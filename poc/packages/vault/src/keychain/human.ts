// 사람 비밀(세션 결박) 저장소(D05 §2, ADR-026 결정 2·3·4·7, ADR-020 결정 2).
// - 칸 단위 항목: securitycard/<scope>/<row>, portal/<scope>/pw(포털 아이디는 비밀이 아니라 두지 않는다, D05 §2·ADR-035). 각 항목은 슬롯 KEK로 AES-256-GCM(AAD = 항목 이름).
// - 슬롯 KEK(32B 무작위)는 기기 결박 래핑(kek/<slot>/device: TPM → DPAPI)과, Hello가 있으면 Hello 사본(kek/<slot>/hello)으로 둔다.
// - 발급 1회에 요청된 칸만 복호한다. 금고가 잠기면 메모리의 슬롯 KEK를 지운다.
// - 인증서 비밀번호는 저장 기능이 없다. 이 모듈은 STORABLE_KINDS 밖을 받지 않는다.
import { randomBytes } from 'node:crypto';
import type { EventLog } from '@sax/platform';
import {
  isProfileScope, SECURITY_CARD_ROWS, STORABLE_KINDS,
  type ConsentRecord, type KeyTier, type PortalField, type ProfileScope, type StorableKind, type StoredSecretInfo, type VaultLockReason,
} from '../protocol.ts';
import { ITEM_MAX_BYTES, open, seal, type HelloPrompt, type KeychainBackend } from './backend.ts';
import { SessionLock, type SessionLockOptions } from './session.ts';

/** 칸 하나의 평문 상한(보안카드 2~4자리, 포털 비밀번호). 넘으면 거부한다. */
export const HUMAN_SECRET_MAX_BYTES = 256;

const INDEX_ITEM = 'index/human';
/** 엄격 모드 설정(값 없음, 1바이트). 기기 결박 사본을 지운 상태가 재시작 뒤에도 이어지게 키체인에 둔다. */
const STRICT_ITEM = 'settings/strict';

export const slotName = (kind: StorableKind, scope: ProfileScope): string => `${kind === 'security_card' ? 'securitycard' : 'portal'}/${scope}`;

export function itemName(kind: StorableKind, scope: ProfileScope, cell: { row?: number; field?: PortalField }): string {
  if (kind === 'security_card') {
    if (!isRow(cell.row) || cell.field !== undefined) throw new Error('bad_cell');
    return `${slotName(kind, scope)}/${cell.row}`;
  }
  if (cell.field !== 'pw' || cell.row !== undefined) throw new Error('bad_cell');
  return `${slotName(kind, scope)}/${cell.field}`;
}

const isRow = (r: unknown): r is number => Number.isInteger(r) && (r as number) >= SECURITY_CARD_ROWS.min && (r as number) <= SECURITY_CARD_ROWS.max;

interface SlotIndex {
  v: 1;
  kind: StorableKind;
  scope: ProfileScope;
  cells: string[];
  tier: KeyTier;
  hello: boolean;
  suspect: boolean;
}

export interface HumanVaultOptions extends SessionLockOptions {
  backend: KeychainBackend;
  log: EventLog;
}

export type ReadResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'vault_locked' | 'secret_missing' | 'credential_suspect' | 'corrupt' };

export class HumanSecretVault {
  private readonly b: KeychainBackend;
  private readonly log: EventLog;
  readonly lock: SessionLock;
  /** 열린 동안만 들고 있는 슬롯 KEK. 잠기면 0으로 덮고 지운다. */
  private readonly keks = new Map<string, Uint8Array>();
  private indexP: Promise<Map<string, SlotIndex>> | null = null;
  private readonly readyP: Promise<void>;

  constructor(opts: HumanVaultOptions) {
    this.b = opts.backend;
    this.log = opts.log;
    this.lock = new SessionLock(opts);
    this.lock.onLock = (reason) => this.wipeKeks(reason);
    // 기동 직후 엄격 모드 설정을 읽는다. 다 읽을 때까지 잠금은 닫힌 채(startup)라 세션·유휴 보고가 먼저 와도 열리지 않는다.
    this.lock.hold();
    this.readyP = this.b.items.get(STRICT_ITEM).then(
      (raw) => {
        if (raw?.[0] === 1) this.lock.setStrict(true);
      },
      () => {
        // 읽기 실패: 엄격 모드로 본다(fail-closed). 기기 사본이 있어도 Hello로만 연다.
        this.lock.setStrict(true);
      },
    ).finally(() => this.lock.release());
  }

  /** 모든 공개 비동기 연산 앞에서 기다린다(엄격 모드 설정을 읽은 뒤에 판정). */
  ready(): Promise<void> {
    return this.readyP;
  }

  get tier(): KeyTier {
    return this.b.wrapper.tier;
  }

  private wipeKeks(reason: VaultLockReason): void {
    for (const k of this.keks.values()) k.fill(0);
    if (this.keks.size) this.log.event('vault.locked', { reason, slots: this.keks.size });
    this.keks.clear();
  }

  // ───────────── 색인(값 없음: 슬롯·칸 이름·등급·suspect만) ─────────────

  private index(): Promise<Map<string, SlotIndex>> {
    this.indexP ??= (async () => {
      const raw = await this.b.items.get(INDEX_ITEM);
      const m = new Map<string, SlotIndex>();
      if (!raw) return m;
      try {
        const arr = JSON.parse(Buffer.from(raw).toString('utf8')) as SlotIndex[];
        for (const s of arr) if (s?.v === 1 && (STORABLE_KINDS as readonly string[]).includes(s.kind) && isProfileScope(s.scope)) m.set(slotName(s.kind, s.scope), s);
      } catch {
        this.log.event('vault.index_corrupt');
      }
      return m;
    })();
    return this.indexP;
  }

  private async saveIndex(m: Map<string, SlotIndex>): Promise<void> {
    await this.b.items.set(INDEX_ITEM, new TextEncoder().encode(JSON.stringify([...m.values()])));
  }

  // ───────────── 저장(등록 창 T-06 전용) ─────────────

  /**
   * 한 슬롯을 통째로 다시 등록한다(옛 칸·KEK는 지운다). entries의 바이트는 부르는 쪽이 넘긴 뒤 여기서 0으로 덮는다.
   * 기기 결박 래핑이 안 되면(네이티브 헬퍼 없음) 저장하지 않는다. 약한 등급으로 조용히 내려가지 않는다.
   */
  async store(kind: StorableKind, scope: ProfileScope, entries: Array<{ row?: number; field?: PortalField; bytes: Uint8Array }>, notice: { version: string }): Promise<ConsentRecord> {
    const wipe = () => entries.forEach((e) => e.bytes?.fill?.(0));
    try {
      if (!(STORABLE_KINDS as readonly string[]).includes(kind) || !isProfileScope(scope)) throw new Error('bad_slot');
      if (!entries.length || entries.length > SECURITY_CARD_ROWS.max) throw new Error('bad_entries');
      const names = entries.map((e) => itemName(kind, scope, e));
      if (new Set(names).size !== names.length) throw new Error('duplicate_cell');
      for (const e of entries) if (!(e.bytes instanceof Uint8Array) || e.bytes.length === 0 || e.bytes.length > HUMAN_SECRET_MAX_BYTES) throw new Error('bad_value');
      if (kind === 'portal_password' && !names.some((n) => n.endsWith('/pw'))) throw new Error('portal_pw_required');
      await this.readyP;
      // 금고가 열려 있을 때만 저장한다(잠금 사유 무관, readOne과 같은 판정). 유휴·최대 시간 잠금 뒤는 main이 vault.unlock(Hello)
      // 또는 Windows 잠금·해제로 먼저 연다. 엄격 모드는 Hello 확인 뒤 300초 안에만 저장된다.
      const v = this.lock.check();
      if (!v.open) throw new Error('vault_locked');

      const slot = slotName(kind, scope);
      // 다시 등록: 옛 슬롯을 지우기 전에 암호문 그대로 떠 둔다. 새 슬롯을 다 쓰기 전에 실패하면 되돌린다(평문은 다루지 않는다).
      const backup = await this.snapshotSlot(kind, scope);
      const kek = new Uint8Array(randomBytes(32));
      try {
        // forget도 되돌리기 범위 안이다(색인 저장 실패 등으로 던져도 옛 슬롯을 되돌린다).
        await this.forget(kind, scope, 'replace');
        const helloOk = await this.b.hello.available().catch(() => false);
        // 엄격 모드는 무프롬프트 래핑을 두지 않는다(Hello 사본만). Hello가 없으면 엄격 모드로 저장할 수 없다.
        if (this.lock.strict && !helloOk) throw new Error('vault.hello_unavailable');
        if (!this.lock.strict) await this.b.items.set(`kek/${slot}/device`, await this.b.wrapper.wrap(kek, slot));
        if (helloOk) await this.b.items.set(`kek/${slot}/hello`, await this.b.hello.wrap(kek, slot));
        for (let i = 0; i < entries.length; i++) {
          const blob = seal(kek, entries[i]!.bytes, names[i]!);
          if (blob.length > ITEM_MAX_BYTES) throw new Error('vault.item_too_large');
          await this.b.items.set(names[i]!, blob);
        }
        const consent: ConsentRecord = {
          v: 1, kind, scope, items: entries.length, tier: this.tier, helloCopy: helloOk, strict: this.lock.strict,
          noticeVersion: notice.version, at: new Date().toISOString(), via: 'T-06',
        };
        await this.b.items.set(`consent/${slot}`, new TextEncoder().encode(JSON.stringify(consent)));
        const idx = await this.index();
        idx.set(slot, { v: 1, kind, scope, cells: names, tier: this.tier, hello: helloOk, suspect: false });
        await this.saveIndex(idx);
        this.log.event('vault.secret_stored', { kind, items: entries.length, tier: this.tier, hello: helloOk });
        return consent;
      } catch (e) {
        // 반쯤 쓴 슬롯을 남기지 않고, 옛 슬롯이 있었으면 그대로 되돌린다.
        await this.forget(kind, scope, 'replace').catch(() => {});
        await this.restoreSlot(kind, scope, backup).catch(() => this.log.event('vault.restore_failed', { kind }));
        throw e;
      } finally {
        kek.fill(0);
      }
    } finally {
      wipe();
    }
  }

  /** 슬롯의 키체인 항목(암호문·래핑된 KEK·동의 레코드)과 색인 항목을 그대로 떠 둔다. */
  private async snapshotSlot(kind: StorableKind, scope: ProfileScope): Promise<{ info: SlotIndex; items: Array<[string, Uint8Array]> } | null> {
    const slot = slotName(kind, scope);
    const info = (await this.index()).get(slot);
    if (!info) return null;
    const items: Array<[string, Uint8Array]> = [];
    for (const n of [...info.cells, `kek/${slot}/device`, `kek/${slot}/hello`, `consent/${slot}`]) {
      const raw = await this.b.items.get(n);
      if (raw) items.push([n, raw]);
    }
    return { info: { ...info, cells: [...info.cells] }, items };
  }

  private async restoreSlot(kind: StorableKind, scope: ProfileScope, backup: Awaited<ReturnType<HumanSecretVault['snapshotSlot']>>): Promise<void> {
    if (!backup) return;
    for (const [n, raw] of backup.items) await this.b.items.set(n, raw);
    const idx = await this.index();
    idx.set(slotName(kind, scope), backup.info);
    await this.saveIndex(idx);
  }

  // ───────────── 꺼내기(타이피스트 전용, 칸 하나) ─────────────

  /** 칸 하나를 복호한다. 금고가 닫혔거나 suspect면 꺼내지 않는다. 받은 쪽이 다 쓴 뒤 0으로 덮는다. */
  async readOne(kind: StorableKind, scope: ProfileScope, cell: { row?: number; field?: PortalField }): Promise<ReadResult> {
    let name: string;
    try {
      name = itemName(kind, scope, cell);
    } catch {
      return { ok: false, reason: 'secret_missing' };
    }
    await this.readyP;
    const slot = slotName(kind, scope);
    const info = (await this.index()).get(slot);
    if (!info || !info.cells.includes(name)) return { ok: false, reason: 'secret_missing' };
    if (info.suspect) return { ok: false, reason: 'credential_suspect' };
    const verdict = this.lock.check();
    if (!verdict.open) return { ok: false, reason: 'vault_locked' };
    const kek = await this.slotKek(slot, info);
    if (!kek) return { ok: false, reason: 'vault_locked' };
    const blob = await this.b.items.get(name);
    if (!blob) return { ok: false, reason: 'secret_missing' };
    try {
      return { ok: true, bytes: open(kek, blob, name) };
    } catch {
      this.log.event('vault.item_corrupt', { kind });
      return { ok: false, reason: 'corrupt' };
    }
  }

  /** 열린 금고에서 슬롯 KEK. 엄격 모드면 Hello 확인 때 이미 들어와 있어야 한다(기기 사본이 없다). */
  private async slotKek(slot: string, info: SlotIndex): Promise<Uint8Array | null> {
    const cached = this.keks.get(slot);
    if (cached) return cached;
    if (this.lock.strict) return null;
    const wrapped = await this.b.items.get(`kek/${slot}/device`);
    if (!wrapped) return null;
    try {
      const kek = await this.b.wrapper.unwrap(wrapped, slot);
      // 그사이 잠겼으면 들고 있지 않는다.
      if (!this.lock.check().open) {
        kek.fill(0);
        return null;
      }
      this.keks.set(slot, kek);
      return kek;
    } catch {
      this.log.event('vault.kek_unwrap_failed', { tier: info.tier });
      return null;
    }
  }

  /**
   * Hello로 연다(유휴 잠금 뒤·최대 시간 뒤·엄격 모드 발급). 저장된 슬롯의 Hello 사본을 한 번의 프롬프트로 연다.
   * Phase 1 저장 슬롯은 대개 1~2개(보안카드·포털)이므로 첫 사본으로 사람 확인을 받고, 나머지는 같은 확인 안에서 연다.
   */
  async unlockWithHello(prompt: HelloPrompt): Promise<{ ok: boolean; presence: boolean; reason?: 'hello_unavailable' | 'hello_cancelled' | 'no_stored_secret' | 'session_locked' }> {
    await this.readyP;
    const v = this.lock.check();
    if (!v.open && !v.helloCanOpen) return { ok: false, presence: false, reason: 'session_locked' };
    if (!(await this.b.hello.available().catch(() => false))) return { ok: false, presence: false, reason: 'hello_unavailable' };
    const slots = [...(await this.index()).values()].filter((s) => s.hello);
    if (!slots.length) return { ok: false, presence: false, reason: 'no_stored_secret' };
    const opened: Array<[string, Uint8Array]> = [];
    for (const s of slots) {
      const slot = slotName(s.kind, s.scope);
      const w = await this.b.items.get(`kek/${slot}/hello`);
      if (!w) continue;
      const kek = await this.b.hello.unwrap(w, slot, prompt).catch(() => null);
      if (!kek) {
        for (const [, k] of opened) k.fill(0);
        return { ok: false, presence: false, reason: 'hello_cancelled' };
      }
      opened.push([slot, kek]);
    }
    // presence는 실제로 Hello 프롬프트를 거쳐 사본을 연 때만이다. 색인에만 있고 사본이 없으면 사람 확인이 없었다.
    if (!opened.length) {
      this.log.event('vault.item_corrupt', { item: 'hello' });
      return { ok: false, presence: false, reason: 'no_stored_secret' };
    }
    this.lock.helloConfirmed();
    if (!this.lock.check().open) {
      for (const [, k] of opened) k.fill(0);
      return { ok: false, presence: true, reason: 'session_locked' };
    }
    for (const [slot, k] of opened) {
      this.keks.get(slot)?.fill(0);
      this.keks.set(slot, k);
    }
    return { ok: true, presence: true };
  }

  /**
   * 엄격 모드 전환(설정 S-02). 켜면 기기 결박 사본(무프롬프트)을 지운다: Hello 사본이 없는 슬롯이 있으면 거부한다.
   * 끄면 기기 사본을 다시 만든다: 열린 금고(메모리의 KEK)가 있어야 한다.
   */
  async setStrict(on: boolean): Promise<{ ok: boolean; reason?: 'hello_unavailable' | 'unlock_required' }> {
    await this.readyP;
    const idx = await this.index();
    if (on) {
      if ([...idx.values()].some((s) => !s.hello)) return { ok: false, reason: 'hello_unavailable' };
      // 설정을 먼저 남기고 기기 사본을 지운다(중간에 끊겨도 재시작 뒤 엄격 모드: Hello로만 연다).
      await this.b.items.set(STRICT_ITEM, Uint8Array.of(1));
      this.lock.setStrict(true);
      for (const s of idx.values()) await this.b.items.delete(`kek/${slotName(s.kind, s.scope)}/device`);
      return { ok: true };
    }
    for (const s of idx.values()) if (!this.keks.has(slotName(s.kind, s.scope))) return { ok: false, reason: 'unlock_required' };
    // 기기 사본을 다 만든 뒤에 설정을 끈다(중간에 끊기면 엄격 모드로 남는다).
    for (const s of idx.values()) {
      const slot = slotName(s.kind, s.scope);
      const kek = this.keks.get(slot);
      // 그사이 잠겨 KEK를 지웠으면 멈춘다(설정은 엄격 모드로 남는다).
      if (!kek) return { ok: false, reason: 'unlock_required' };
      await this.b.items.set(`kek/${slot}/device`, await this.b.wrapper.wrap(kek, slot));
    }
    await this.b.items.delete(STRICT_ITEM);
    this.lock.setStrict(false);
    return { ok: true };
  }

  // ───────────── 목록·삭제·suspect ─────────────

  async has(kind: StorableKind, scope: ProfileScope): Promise<boolean> {
    return (await this.index()).has(slotName(kind, scope));
  }

  async list(): Promise<StoredSecretInfo[]> {
    const out: StoredSecretInfo[] = [];
    for (const s of (await this.index()).values()) {
      const raw = await this.b.items.get(`consent/${slotName(s.kind, s.scope)}`);
      let at = '';
      try {
        at = raw ? String((JSON.parse(Buffer.from(raw).toString('utf8')) as ConsentRecord).at) : '';
      } catch {
        // 동의 레코드가 깨졌으면 시각만 비운다
      }
      out.push({ kind: s.kind, scope: s.scope, items: s.cells.length, tier: s.tier, suspect: s.suspect, consentAt: at });
    }
    return out;
  }

  async consent(kind: StorableKind, scope: ProfileScope): Promise<ConsentRecord | null> {
    const raw = await this.b.items.get(`consent/${slotName(kind, scope)}`);
    if (!raw) return null;
    return JSON.parse(Buffer.from(raw).toString('utf8')) as ConsentRecord;
  }

  /** 슬롯 삭제(설정 "저장된 비밀"의 개별 삭제, 또는 다시 등록 직전). 칸·KEK·동의 레코드를 모두 지운다. */
  async forget(kind: StorableKind, scope: ProfileScope, why: 'user' | 'replace' = 'user'): Promise<boolean> {
    const slot = slotName(kind, scope);
    const idx = await this.index();
    const info = idx.get(slot);
    // 색인에 없어도 이름이 정해진 항목은 지운다(반쯤 쓴 슬롯 정리).
    const names = new Set(info?.cells ?? []);
    if (kind === 'security_card') for (let r = SECURITY_CARD_ROWS.min; r <= SECURITY_CARD_ROWS.max; r++) names.add(`${slot}/${r}`);
    // 'id'는 ADR-035 이전 PoC가 남겼을 수 있는 항목을 함께 지운다.
    else for (const f of ['id', 'pw']) names.add(`${slot}/${f}`);
    for (const n of [...names, `kek/${slot}/device`, `kek/${slot}/hello`, `consent/${slot}`]) await this.b.items.delete(n);
    this.keks.get(slot)?.fill(0);
    this.keks.delete(slot);
    if (info) {
      idx.delete(slot);
      await this.saveIndex(idx);
      if (why === 'user') this.log.event('vault.secret_forgotten', { kind });
    }
    return !!info;
  }

  /** 포털의 명시적 인증 실패 1회 뒤(ADR-026 결정 7). 다시 등록하기 전에는 꺼내지 않는다. */
  async markSuspect(kind: StorableKind, scope: ProfileScope): Promise<boolean> {
    const idx = await this.index();
    const info = idx.get(slotName(kind, scope));
    if (!info || info.suspect) return false;
    info.suspect = true;
    await this.saveIndex(idx);
    this.log.event('vault.credential_suspect', { kind });
    return true;
  }
}
