import type { EventLog } from '@sax/platform';
import { HUMAN_SETTLE_MS, SECRET_TTL_MS, SELF_SCAN_TIMEOUT_MS } from '../constants.ts';
import { scanDir } from '../leak/scanner.ts';
import { isTypistKind, SECURITY_CARD_ROWS, type CardFillReason, type CardFillRequest, type FillReason, type FillRequest, type OneShotBind, type VaultEventName } from '../protocol.ts';
import { parseCardAsk } from './card-scan.ts';
import { hostAllowed, type RelayPolicy } from '../relay/policy.ts';
import type { Relay, TargetState } from '../relay/relay.ts';
import { KNOWN_VALUE_MIN_LEN, knownValuePrefixVariants, knownValueVariants } from '../relay/sanitize.ts';

type Json = Record<string, unknown>;


interface HeldSecret {
  runId: string;
  kind: string;
  bytes: Uint8Array;
  timer: NodeJS.Timeout;
}

/**
 * PoC는 비밀을 저장하지 않는다(ADR-017). 사용자가 금고 직결 입력 창에서 넣은 값을 한 번만 쓰고 지운다.
 * main·렌더러 본체는 이 값을 중계하지 않는다(입력 창 포트는 금고에 직결).
 * 값은 실행(runId)에 묶이고 TTL이 지나거나 run.end면 0으로 덮어 지운다(N-44).
 */
export class OneShotSecrets {
  private readonly items = new Map<string, HeldSecret>();
  private readonly ttlMs: number;
  private readonly onExpire: (runId: string, kind: string) => void;

  constructor(ttlMs = SECRET_TTL_MS, onExpire: (runId: string, kind: string) => void = () => {}) {
    this.ttlMs = ttlMs;
    this.onExpire = onExpire;
  }

  private key(runId: string, kind: string, scope: string, row?: number) {
    return `${runId}|${kind}/${scope}/${row ?? ''}`;
  }

  private drop(k: string): HeldSecret | undefined {
    const v = this.items.get(k);
    if (!v) return undefined;
    clearTimeout(v.timer);
    this.items.delete(k);
    return v;
  }

  provide(bind: OneShotBind, bytes: Uint8Array): void {
    const k = this.key(bind.runId, bind.kind, bind.scope, bind.row);
    this.drop(k)?.bytes.fill(0);
    const timer = setTimeout(() => {
      const v = this.drop(k);
      if (!v) return;
      v.bytes.fill(0);
      this.onExpire(v.runId, v.kind);
    }, this.ttlMs);
    timer.unref();
    this.items.set(k, { runId: bind.runId, kind: bind.kind, bytes, timer });
  }

  /** 같은 실행의 값만 꺼낸다. 꺼낸 값은 더 이상 들고 있지 않는다(부르는 쪽이 0으로 덮는다). */
  take(runId: string, kind: string, scope: string, row?: number): Uint8Array | null {
    return this.drop(this.key(runId, kind, scope, row))?.bytes ?? null;
  }

  get size(): number {
    return this.items.size;
  }

  clearRun(runId: string): void {
    for (const [k, v] of [...this.items]) if (v.runId === runId) this.drop(k)?.bytes.fill(0);
  }

  clear(): void {
    for (const k of [...this.items.keys()]) this.drop(k)?.bytes.fill(0);
  }
}

interface Probe {
  type: string;
  active: boolean;
  connected: boolean;
  len: number;
}

// 보안키보드형 가림 칸(type=text + -webkit-text-security, 대표 실화면 run-fb6d0e95 가설)은 password로 본다. 보이는 일반 글 칸은 아니다.
const PROBE_FN = `function () {
  let a = this.ownerDocument.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  let type = String(this.type || '').toLowerCase();
  if (type === 'text') {
    const v = getComputedStyle(this).getPropertyValue('-webkit-text-security');
    if (v === 'disc' || v === 'circle' || v === 'square') type = 'password';
  }
  return { type, active: a === this, connected: this.isConnected, len: typeof this.value === 'string' ? this.value.length : 0 };
}`;

interface HumanWatch {
  objectId: string;
  runId: string;
  /** 인증서 비밀번호 기억(certMemory)에 쓸 프로필. 없으면 저장하지 않는다. */
  scope?: string;
  timer: NodeJS.Timeout;
  /** blur + 값 있음을 처음 본 시각(N-47). 길이·포커스가 바뀌면 다시 센다. */
  idleSince?: number;
  lastLen?: number;
}

export type VaultEmit = (to: ReadonlyArray<'engine' | 'control'>, name: VaultEventName, data: Json) => void;

export interface SecretOpsOptions {
  /** 시험만 주입한다. 기본 SECRET_TTL_MS. */
  secretTtlMs?: number;
  /** 비밀 사용 직후 그 값으로 훑을 폴더(N-17). 없으면 자기 스캔을 하지 않는다. */
  selfScan?: { roots: string[] };
  /** 금고 이벤트(I-2·I-3). */
  emit?: VaultEmit;
  /** 실행당 종류별 1회 기록(N-46). Chrome을 다시 띄워도 남도록 금고가 들고 있다. */
  usedSlots?: Set<string>;
  /**
   * 저장된 사람 비밀 칸 하나(ADR-026). 1회용 값이 없을 때만 부른다. 보안카드는 row, 포털은 pw.
   * 금고가 닫혔으면 vault_locked, suspect면 credential_suspect.
   */
  stored?: (kind: string, scope: string, row?: number) => Promise<StoredRead>;
  /** 시험만 주입한다(사람 창 정착 판정 시계). 기본 Date.now. */
  now?: () => number;
  /**
   * 인증서 비밀번호 기억(대표 지시 2026-11-13). 비밀 창(openForHuman)은 인증서 비밀번호 칸에만 열린다.
   * 저장값이 있으면 사람 창 대신 금고가 그 칸에 넣고 창을 닫는다(엔진에는 'done'). 없으면 사람이 넣은 값을 창이 닫힐 때 저장한다.
   * 사람이 넣은 값은 바로 저장하지 않고 hold로 금고 메모리에만 둔다: 엔진이 로그인 확인(typist.authOk)을 알려야 저장하고,
   * 틀림(typist.authFailed)이면 버리고 기억값도 지운다(틀린 비밀번호를 기억해 다음에 또 넣는 일, 연속 오류 잠금 방지, 부장 지시 2026-11-13).
   */
  certMemory?: {
    scopeOf(runId: string): string | undefined;
    read(scope: string): Promise<StoredRead>;
    hold(runId: string, scope: string, bytes: Uint8Array): void;
  };
  /**
   * 기억값이 없을 때 인증서 비밀번호를 앱의 금고 직결 입력 창(secret.needed → secretInput 포트 → secret.provide)으로 받아
   * 금고가 그 칸에 넣고 기억한다(부장 지시 2026-11-13 (b)). Chrome은 앱 뒤에 있어 사람이 그 칸을 찾지 않아도 된다.
   */
  askApp?: () => boolean;
}

export type StoredRead = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'vault_locked' | 'secret_missing' | 'credential_suspect' | 'corrupt' | 'kek_unavailable' };

/** 실행당 종류별 1회 키(보안카드는 칸별). */
export const slotKey = (runId: string, kind: string, row?: number): string => `${runId}|${kind}|${row ?? ''}`;

/** 비밀 창(D05 §3.5)과 타이피스트(D05 §4). 모든 동작은 금고 감시 세션에서 한다. */
export class SecretOps {
  private readonly relay: Relay;
  private readonly policy: RelayPolicy;
  private readonly log: EventLog;
  private readonly opts: SecretOpsOptions;
  private readonly emit: VaultEmit;
  readonly secrets: OneShotSecrets;
  /** main이 알려 준 실행 트리거(엔진의 주장으로 받지 않는다). */
  readonly runTriggers = new Map<string, 'local' | 'remote' | 'daemon'>();
  private readonly human = new Map<string, HumanWatch>();
  /** 앱 입력 창을 기다리는 인증서 비밀번호 칸(targetId별). 값이 오면 금고가 이 칸에 넣고 창을 닫는다. */
  private readonly appAsk = new Map<string, { runId: string; scope: string; objectId: string }>();
  /** 창 개시 진행 중인 타깃(await 사이 이중 개시 차단, N-43). */
  private readonly opening = new Set<string>();
  readonly usedSlots: Set<string>;
  /** 가장 최근 자기 스캔(시험이 기다린다). */
  selfScanDone: Promise<void> = Promise.resolve();
  /** 비밀 창 개시 조건(Preferences·확장·Google 로그인) 위반 사유. 열 때마다 다시 본다(N-18). null이면 통과. */
  openBlocker: () => Promise<string | null> = async () => 'profile_not_checked';

  constructor(relay: Relay, policy: RelayPolicy, log: EventLog, opts: SecretOpsOptions = {}) {
    this.relay = relay;
    this.policy = policy;
    this.log = log;
    this.opts = opts;
    this.emit = opts.emit ?? (() => {});
    this.usedSlots = opts.usedSlots ?? new Set();
    relay.activeValueHook = (targetId) => this.noteHumanValue(targetId);
    this.secrets = new OneShotSecrets(opts.secretTtlMs ?? SECRET_TTL_MS, (runId, kind) => {
      this.log.event('vault.secret_expired', { kind });
      this.emit(['control'], 'secret.expired', { runId, kind });
    });
  }

  private async resolve(t: TargetState, frame: string, selector: string): Promise<{ objectId: string; backendNodeId: number; frameId: string; frameUrl: string } | null> {
    const frameId = frame === 'main' ? t.mainFrameId : /^[0-9A-F]{16,64}$/i.test(frame) ? frame : await this.childFrame(t, frame);
    if (!frameId) return null;
    const { executionContextId } = await this.relay.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId, worldName: '__sax_vault' }, t.vaultSession);
    const ev = await this.relay.send<{ result: Json }>('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})`, contextId: executionContextId }, t.vaultSession);
    const objectId = ev.result.objectId as string | undefined;
    if (!objectId) return null;
    const { node } = await this.relay.send<{ node: Json }>('DOM.describeNode', { objectId }, t.vaultSession);
    const { frameTree } = await this.relay.send<{ frameTree: Json }>('Page.getFrameTree', {}, t.vaultSession);
    return { objectId, backendNodeId: Number(node.backendNodeId), frameId, frameUrl: findFrameUrl(frameTree, frameId) ?? '' };
  }

  /**
   * 사전의 frame이 iframe 선택자일 때(홈택스 인증서 창 iframe#dscert, 같은 출처 MagicLine4Web): 본 프레임에서 그 iframe을 찾아 하위 프레임 id를 얻는다.
   * 같은 프로세스 iframe만 이 세션에서 닿는다. 못 찾으면 null(엔진은 사람 직접 입력으로 간다).
   */
  private async childFrame(t: TargetState, frameSelector: string): Promise<string | null> {
    if (!t.mainFrameId) return null;
    const { executionContextId } = await this.relay.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: t.mainFrameId, worldName: '__sax_vault' }, t.vaultSession);
    const ev = await this.relay.send<{ result: Json }>('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(frameSelector)})`, contextId: executionContextId }, t.vaultSession);
    const objectId = ev.result.objectId as string | undefined;
    if (!objectId) return null;
    const { node } = await this.relay.send<{ node: Json }>('DOM.describeNode', { objectId }, t.vaultSession);
    return typeof node.frameId === 'string' ? node.frameId : null;
  }

  /**
   * 보안카드 요청 칸 번호를 금고 격리 월드에서 읽는다. 글자 안의 숫자가 정확히 하나이고 1~35일 때만 그 값, 아니면 null.
   * "12번 앞 2자리"처럼 숫자가 둘 이상이면 읽지 못한 것으로 본다(셀렉터를 칸 번호 요소로 좁혀야 한다).
   */
  private async readRowLabel(t: TargetState, frameId: string, selector: string): Promise<number | null> {
    const { executionContextId } = await this.relay.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId, worldName: '__sax_vault' }, t.vaultSession);
    const r = await this.relay.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
      expression: `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e ? String(e.textContent ?? '') : null; })()`,
      contextId: executionContextId,
      returnByValue: true,
    }, t.vaultSession);
    return parseCardRow(r.result.value);
  }

  private async probe(t: TargetState, objectId: string): Promise<Probe | null> {
    try {
      const r = await this.relay.send<{ result: { value: Probe } }>('Runtime.callFunctionOn', { objectId, functionDeclaration: PROBE_FN, returnByValue: true }, t.vaultSession);
      return r.result.value;
    } catch {
      return null;
    }
  }

  private refuse(reason: string): { ok: false; reason: 'secret_window_refused' } {
    this.log.event('vault.secret_window_refused', { reason });
    this.emit(['engine', 'control'], 'secret_window.refused', { reason });
    return { ok: false, reason: 'secret_window_refused' };
  }

  /** 사람 비밀 입력은 local·remote 실행만(A-23·N-77). 없음·daemon·그 밖은 거부. */
  private triggerAllowed(runId: string): boolean {
    const trigger = this.runTriggers.get(runId);
    return trigger === 'local' || trigger === 'remote';
  }

  /** 타이피스트: remote 실행은 시작 게이트 통과 플래그가 있을 때만(ADR-029 결정 2, D-34(N-13)). */
  private fillTriggerAllowed(req: FillRequest): boolean {
    const trigger = this.runTriggers.get(req.runId);
    return trigger === 'local' || (trigger === 'remote' && req.startGate === true);
  }

  async fill(req: FillRequest): Promise<{ ok: boolean; reason?: FillReason }> {
    const t = this.relay.exposedTarget(req.targetId);
    if (!t) return { ok: false, reason: 'not_found' };
    if (!this.fillTriggerAllowed(req)) return { ok: false, reason: 'denied' };
    // 타이피스트는 포털 비밀번호·보안카드만 넣는다. 인증서 비밀번호는 정책·허용 호스트와 상관없이 넣지 않는다(ADR-020 결정 2, ADR-025 결정 10).
    if (!isTypistKind(req.secret?.kind)) {
      this.log.event('vault.typist_kind_refused', { kind: String(req.secret?.kind).slice(0, 20) });
      return { ok: false, reason: 'denied' };
    }
    // 보안카드는 칸 하나씩(row 필수), 포털 비밀번호는 칸 번호가 없다(D05 §4).
    if (req.secret.kind === 'security_card' ? !isRow(req.secret.row) : req.secret.row !== undefined) return { ok: false, reason: 'denied' };
    // 요청 kind와 사전 칸의 kind가 같아야 한다(「또는」이 아니라 「그리고」, N-46).
    if (!req.slot || req.slot.secretKind !== req.secret?.kind) return { ok: false, reason: 'not_secret_slot' };
    const used = slotKey(req.runId, req.secret.kind, req.secret.row);
    if (this.usedSlots.has(used)) return { ok: false, reason: 'denied' };
    // 개시 검사와 표시는 await 없이 한 번에(N-43).
    if (t.win || this.opening.has(t.targetId)) return { ok: false, reason: 'denied' };
    this.opening.add(t.targetId);
    try {
      return await this.fillOpening(t, req, used);
    } finally {
      this.opening.delete(t.targetId);
    }
  }

  private async fillOpening(t: TargetState, req: FillRequest, used: string): Promise<{ ok: boolean; reason?: FillReason }> {
    const blocker = await this.openBlocker();
    if (blocker) return this.refuse(blocker);
    const el = await this.resolve(t, req.frame, req.element).catch(() => null);
    if (!el) return { ok: false, reason: 'not_found' };
    const hosts = this.policy.secretHosts[req.secret.kind] ?? [];
    if (!hostAllowed(hostOf(el.frameUrl), hosts)) return { ok: false, reason: 'origin_not_allowed' };
    const p0 = await this.probe(t, el.objectId);
    if (!p0 || p0.type !== 'password') return { ok: false, reason: 'not_secret_slot' };
    if (!p0.active) return { ok: false, reason: 'denied' };
    // 보안카드: 화면에 보인 칸 번호가 요청 칸과 같을 때만(D05 §4 2). 값을 꺼내기 전에 본다.
    if (req.secret.kind === 'security_card') {
      const sel = typeof req.rowLabel === 'string' && req.rowLabel.length > 0 && req.rowLabel.length <= ROW_LABEL_MAX ? req.rowLabel : null;
      const shown = sel ? await this.readRowLabel(t, el.frameId, sel).catch(() => null) : null;
      if (shown !== req.secret.row) {
        this.log.event('vault.card_row_mismatch', { readable: shown !== null });
        return { ok: false, reason: 'row_mismatch' };
      }
    }
    let secret = this.secrets.take(req.runId, req.secret.kind, req.secret.scope, req.secret.row);
    if (!secret && this.opts.stored) {
      // 저장된 사람 비밀(세션 결박). 요청된 칸 하나만 복호한다.
      const r = await this.opts.stored(req.secret.kind, req.secret.scope, req.secret.row);
      if (r.ok) secret = r.bytes;
      else if (r.reason === 'vault_locked' || r.reason === 'credential_suspect') return { ok: false, reason: r.reason };
      // corrupt·kek_unavailable·secret_missing: 저장본을 못 쓰니 사람에게 1회용으로 받는다(아래 secret.needed).
    }
    if (!secret) {
      // 비밀 창은 금고가 부른다(N-44): main만 창을 열고, 값은 결속된 secretInput 포트로 온다.
      const data: Json = { runId: req.runId, targetId: t.targetId, kind: req.secret.kind, scope: req.secret.scope };
      if (req.secret.row !== undefined) data.row = req.secret.row;
      this.emit(['control'], 'secret.needed', data);
      return { ok: false, reason: 'secret_missing' };
    }
    this.usedSlots.add(used);

    // Phase 1 한계(D05 §8): CDP JSON 직렬화 때문에 금고 힙에 문자열 사본이 생긴다(엔진 힙에는 없다).
    const text = new TextDecoder().decode(secret);
    secret.fill(0);
    this.relay.openWindow(t, 'typist', el.frameId, el.backendNodeId);
    // 값을 미리 안다: 글자마다 페이지가 흘리는 접두사까지 입력 전에 올린다(S6f 회귀, 창 종료 뒤에만 올리면 입력 도중 것이 먼저 나간다).
    this.relay.addKnownSecret(t.targetId, knownValuePrefixVariants(text));
    let ok = true;
    let reason: FillReason | undefined;
    const keyEvents = this.policy.typistInput === 'keyEvents';
    try {
      if (!keyEvents) await this.relay.send('Input.setIgnoreInputEvents', { ignore: true }, t.vaultSession);
      for (const ch of text) {
        const p = await this.probe(t, el.objectId);
        if (!p || !p.active || p.type !== 'password' || !p.connected) {
          ok = false;
          reason = 'denied';
          break;
        }
        if (keyEvents) {
          await this.relay.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch }, t.vaultSession);
          await this.relay.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, t.vaultSession);
        } else {
          await this.relay.send('Input.insertText', { text: ch }, t.vaultSession);
        }
        if (this.policy.keyDelayMs > 0) await sleep(this.policy.keyDelayMs);
      }
      if (ok) {
        const p = await this.probe(t, el.objectId);
        if (!p || p.len !== [...text].length) {
          ok = false;
          reason = 'blocked_by_module';
        }
      }
    } finally {
      if (!keyEvents) await this.relay.send('Input.setIgnoreInputEvents', { ignore: false }, t.vaultSession).catch(() => {});
      this.relay.addKnownSecret(t.targetId, knownValueVariants(text));
      this.relay.deactivateWindow(t);
    }
    this.log.event('secret.used', { kind: req.secret.kind, viaTypist: true, ok });
    this.selfScan(text);
    return ok ? { ok } : { ok, reason };
  }

  /**
   * 발급 서명의 보안카드 창(홈택스 UTXPPABA08: 실행 탭이 window.open으로 연 새 창, 대표 지시 2026-11-14).
   * 금고가 그 창의 요청 글자("[7]번 보안카드번호 앞 2자리")를 자기 세션으로 읽고, 저장된 그 칸 4자리의 앞·뒤 2자리를 칸에 친다.
   * 엔진은 칸 번호도 값도 모른다(끝났는지와 사유 코드만). 한 실행에서 같은 칸은 한 번만 친다: 틀림 뒤 같은 값으로 다시 치지 않는다(카드 5회 오류 폐기).
   */
  async fillCard(req: CardFillRequest): Promise<{ ok: boolean; reason?: CardFillReason }> {
    const opener = this.relay.exposedTarget(String(req.targetId));
    if (!opener) return { ok: false, reason: 'not_found' };
    if (!this.fillTriggerAllowed({ runId: req.runId, startGate: req.startGate } as FillRequest)) return { ok: false, reason: 'denied' };
    const fields = Array.isArray(req.fields) ? req.fields.filter((f) => typeof f?.element === 'string' && typeof f?.label === 'string' && f.element.length <= ROW_LABEL_MAX && f.label.length <= ROW_LABEL_MAX) : [];
    if (!fields.length || fields.length !== req.fields.length || fields.length > 3 || typeof req.window !== 'string' || req.window.length > 200) return { ok: false, reason: 'denied' };
    let re: RegExp;
    try {
      re = new RegExp(req.window);
    } catch {
      return { ok: false, reason: 'denied' };
    }
    const t = [...this.relay.targets.values()].find((x) => x.type === 'page' && x.exposed && !x.revoked && x.openerId === opener.targetId && re.test(x.url));
    if (!t) return { ok: false, reason: 'window_missing' };
    if (!hostAllowed(hostOf(t.url), this.policy.secretHosts.security_card ?? [])) return { ok: false, reason: 'origin_not_allowed' };
    if (t.win || this.opening.has(t.targetId)) return { ok: false, reason: 'denied' };
    this.opening.add(t.targetId);
    try {
      const blocker = await this.openBlocker();
      if (blocker) return this.refuse(blocker);
      // 먼저 칸·요청 글자를 모두 읽는다. 하나라도 못 읽으면 아무것도 치지 않는다.
      const plan: Array<{ objectId: string; backendNodeId: number; frameId: string; row: number; half: 'front' | 'back' }> = [];
      for (const f of fields) {
        const el = await this.resolve(t, 'main', f.element).catch(() => null);
        if (!el) return { ok: false, reason: 'not_found' };
        const p0 = await this.probe(t, el.objectId);
        if (!p0 || p0.type !== 'password') return { ok: false, reason: 'not_secret_slot' };
        const ask = parseCardAsk(await this.readText(t, el.frameId, f.label).catch(() => null));
        if (!ask) {
          this.log.event('vault.card_ask_unreadable', {});
          return { ok: false, reason: 'row_mismatch' };
        }
        if (this.usedSlots.has(slotKey(req.runId, 'security_card', ask.row))) return { ok: false, reason: 'already_used' };
        plan.push({ objectId: el.objectId, backendNodeId: el.backendNodeId, frameId: el.frameId, row: ask.row, half: ask.half });
      }
      const values: string[] = [];
      try {
        for (const x of plan) {
          const r = this.opts.stored ? await this.opts.stored('security_card', req.scope, x.row) : ({ ok: false, reason: 'secret_missing' } as const);
          if (!r.ok) return { ok: false, reason: r.reason === 'vault_locked' || r.reason === 'credential_suspect' ? r.reason : 'secret_missing' };
          const cell = new TextDecoder().decode(r.bytes);
          r.bytes.fill(0);
          if (!/^\d{4}$/.test(cell)) return { ok: false, reason: 'secret_missing' };
          values.push(x.half === 'front' ? cell.slice(0, 2) : cell.slice(2, 4));
        }
        for (const x of plan) this.usedSlots.add(slotKey(req.runId, 'security_card', x.row));
        let ok = true;
        for (let i = 0; i < plan.length && ok; i++) {
          const x = plan[i]!;
          this.relay.openWindow(t, 'typist', x.frameId, x.backendNodeId);
          try {
            ok = (await this.typeInto(t, x.objectId, values[i]!)).ok;
          } finally {
            this.relay.deactivateWindow(t);
          }
        }
        this.log.event('secret.used', { kind: 'security_card', viaTypist: true, ok, cells: plan.length });
        return ok ? { ok } : { ok, reason: 'blocked_by_module' };
      } finally {
        values.fill('');
      }
    } finally {
      this.opening.delete(t.targetId);
    }
  }

  /** 요소 글자(비밀 아님: 보안카드 요청 칸 번호 글자)를 금고 격리 월드에서 읽는다. */
  private async readText(t: TargetState, frameId: string, selector: string): Promise<string | null> {
    const { executionContextId } = await this.relay.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId, worldName: '__sax_vault' }, t.vaultSession);
    const r = await this.relay.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
      expression: `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e ? String(e.textContent ?? '') : null; })()`,
      contextId: executionContextId,
      returnByValue: true,
    }, t.vaultSession);
    return typeof r.result.value === 'string' ? r.result.value : null;
  }

  /** 기억한 인증서 비밀번호를 칸에 넣는다(타이피스트와 같은 방식: 한 글자씩, 칸이 바뀌면 멈춤, 끝에 길이 확인). */
  private async typeInto(t: TargetState, objectId: string, text: string): Promise<{ ok: boolean }> {
    const keyEvents = this.policy.typistInput === 'keyEvents';
    let ok = true;
    try {
      if (!keyEvents) await this.relay.send('Input.setIgnoreInputEvents', { ignore: true }, t.vaultSession);
      await this.relay.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(){this.focus();this.value=""}' }, t.vaultSession);
      for (const ch of text) {
        const p = await this.probe(t, objectId);
        if (!p || p.type !== 'password' || !p.connected) {
          ok = false;
          break;
        }
        if (keyEvents) {
          await this.relay.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch }, t.vaultSession);
          await this.relay.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, t.vaultSession);
        } else {
          await this.relay.send('Input.insertText', { text: ch }, t.vaultSession);
        }
        if (this.policy.keyDelayMs > 0) await sleep(this.policy.keyDelayMs);
      }
      if (ok) {
        const p = await this.probe(t, objectId);
        ok = !!p && p.len === [...text].length;
      }
    } catch {
      ok = false;
    } finally {
      if (!keyEvents) await this.relay.send('Input.setIgnoreInputEvents', { ignore: false }, t.vaultSession).catch(() => {});
    }
    return { ok };
  }

  /**
   * 비밀 사용 직후 그 값으로 logs·staging을 훑어 건수만 남긴다(N-17, PoC 빌드). 짧은 값(보안카드 칸)은 정상 글자와 겹쳐 건너뛴다.
   * 기다림은 SELF_SCAN_TIMEOUT_MS까지. 넘으면 결과를 버리고 vault.leak_scan_skipped.
   */
  private selfScan(text: string): void {
    const roots = this.opts.selfScan?.roots;
    if (!roots?.length || text.length < KNOWN_VALUE_MIN_LEN) return;
    const scan = (async () => {
      let files = 0;
      let findings = 0;
      for (const root of roots) {
        const r = await scanDir(root, [text]);
        files += r.files;
        findings += r.findings.length;
      }
      return { files, findings };
    })().catch(() => null);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), SELF_SCAN_TIMEOUT_MS);
      timer.unref();
    });
    this.selfScanDone = Promise.race([scan, timeout]).then((r) => {
      clearTimeout(timer);
      if (r === 'timeout' || r === null) {
        this.log.event('vault.leak_scan_skipped');
        return;
      }
      this.log.event('vault.leak_scan', r);
      if (r.findings > 0) this.emit(['engine', 'control'], 'secret_window.leak_suspected', { hits: r.findings });
    });
  }

  async openForHuman(req: { runId: string; targetId: string; frame: string; element: string }): Promise<{ ok: boolean; reason?: 'secret_window_refused' | 'origin_not_allowed' | 'not_found' | 'denied' }> {
    const t = this.relay.exposedTarget(req.targetId);
    // 같은 문서에서 다시 묻기(서명 [확인] 뒤 틀린 비밀번호 → 대화 카드, 2026-11-14): 오염 상태(tainted)는 받는다. 지금 입력 중인 창(active)만 막는다.
    if (!t || t.win?.phase === 'active' || this.opening.has(t.targetId)) return { ok: false, reason: 'not_found' };
    if (!this.triggerAllowed(req.runId)) return { ok: false, reason: 'denied' };
    this.opening.add(t.targetId);
    try {
      const blocker = await this.openBlocker();
      if (blocker) return this.refuse(blocker);
      const el = await this.resolve(t, req.frame, req.element).catch(() => null);
      if (!el) return { ok: false, reason: 'not_found' };
      const hosts = Object.values(this.policy.secretHosts).flat();
      if (!hostAllowed(hostOf(el.frameUrl), hosts)) return { ok: false, reason: 'origin_not_allowed' };
      const mem = this.opts.certMemory;
      const scope = mem?.scopeOf(req.runId);
      if (mem && scope) {
        const r = await mem.read(scope).catch(() => null);
        if (r?.ok) {
          const text = new TextDecoder().decode(r.bytes);
          r.bytes.fill(0);
          this.relay.openWindow(t, 'typist', el.frameId, el.backendNodeId);
          this.relay.addKnownSecret(t.targetId, knownValuePrefixVariants(text));
          const typed = await this.typeInto(t, el.objectId, text);
          this.relay.addKnownSecret(t.targetId, knownValueVariants(text));
          this.relay.deactivateWindow(t); // 엔진에 secret_window.closed → 'done'
          this.log.event('secret.used', { kind: 'cert_password', viaTypist: true, ok: typed.ok, remembered: true });
          this.selfScan(text);
          if (typed.ok) return { ok: true };
          // 넣지 못했으면(칸이 바뀜 등) 사람 창으로 다시 연다
        }
      }
      if (this.opts.askApp?.()) {
        // 칸은 금고가 잡아 두고(활성 창, 엔진 CDP·화면 중계 멈춤) 값은 앱 입력 창에서 받는다.
        const askScope = scope ?? 'business';
        this.relay.openWindow(t, 'human', el.frameId, el.backendNodeId);
        this.appAsk.set(t.targetId, { runId: req.runId, scope: askScope, objectId: el.objectId });
        this.emit(['control'], 'secret.needed', { runId: req.runId, targetId: t.targetId, kind: 'cert_password', scope: askScope });
        this.log.event('vault.cert_password_asked_app');
        return { ok: true };
      }
      this.relay.openWindow(t, 'human', el.frameId, el.backendNodeId);
      const watch: HumanWatch = {
        objectId: el.objectId,
        runId: req.runId,
        timer: setInterval(() => void this.tickHuman(t), 250),
        ...(scope ? { scope } : {}),
      };
      this.human.set(t.targetId, watch);
      return { ok: true };
    } finally {
      this.opening.delete(t.targetId);
    }
  }

  /**
   * 활성 창 종료 조건 (나)·(다): blur + 값 있음이 HUMAN_SETTLE_MS 동안 길이·포커스 변화 없이 이어짐(N-47), 노드 분리.
   * 문서 커밋은 Relay가 처리한다.
   */
  /** 사람 입력 활성 창의 지금 값을 금고 세션에서 읽어 알려진 값(접두사 포함)으로 올린다. 창 동안 본 값은 창이 끝날 때까지 남는다. */
  private async noteHumanValue(targetId: string): Promise<void> {
    const w = this.human.get(targetId);
    const t = this.relay.targets.get(targetId);
    if (!w || !t) return;
    try {
      const r = await this.relay.send<{ result: { value?: string } }>('Runtime.callFunctionOn', { objectId: w.objectId, functionDeclaration: 'function(){return typeof this.value==="string"?this.value:""}', returnByValue: true }, t.vaultSession);
      if (typeof r.result.value === 'string' && r.result.value) this.relay.addKnownSecret(targetId, knownValuePrefixVariants(r.result.value));
    } catch {
      // 노드가 사라졌으면 tick이 창을 닫는다
    }
  }

  private async tickHuman(t: TargetState): Promise<void> {
    const w = this.human.get(t.targetId);
    if (!w) return;
    if (t.win?.phase !== 'active') {
      this.stopHuman(t.targetId);
      return;
    }
    const p = await this.probe(t, w.objectId);
    if (!p || !p.connected) return this.closeHuman(t);
    if (p.len > 0) await this.noteHumanValue(t.targetId);
    if (p.active || p.len === 0) {
      w.idleSince = undefined;
      return;
    }
    const now = this.opts.now?.() ?? Date.now();
    if (w.idleSince === undefined || w.lastLen !== p.len) {
      w.idleSince = now;
      w.lastLen = p.len;
      return;
    }
    if (now - w.idleSince >= HUMAN_SETTLE_MS) await this.closeHuman(t);
  }

  private stopHuman(targetId: string): void {
    this.appAsk.delete(targetId);
    const w = this.human.get(targetId);
    if (w) clearInterval(w.timer);
    this.human.delete(targetId);
  }

  private async closeHuman(t: TargetState): Promise<void> {
    const w = this.human.get(t.targetId);
    this.stopHuman(t.targetId);
    const kind = t.win?.kind ?? 'human';
    if (w) {
      // 오염 상태 동안 엔진행 메시지에서 이 값을 지우기 위해 금고가 읽는다(금고는 TB-1).
      try {
        const r = await this.relay.send<{ result: { value?: string } }>('Runtime.callFunctionOn', { objectId: w.objectId, functionDeclaration: 'function(){return typeof this.value==="string"?this.value:""}', returnByValue: true }, t.vaultSession);
        if (r.result.value) {
          this.relay.addKnownSecret(t.targetId, knownValueVariants(r.result.value));
          this.selfScan(r.result.value);
          // 처음 넣은 인증서 비밀번호는 로그인 확인 뒤에 기억한다(hold → typist.authOk). 따로 묻지 않는다. 값은 로그에 남기지 않는다.
          if (this.opts.certMemory && w.scope) this.opts.certMemory.hold(w.runId, w.scope, new TextEncoder().encode(r.result.value));
        }
      } catch {
        // 노드가 이미 분리됨
      }
    }
    this.relay.deactivateWindow(t);
    this.log.event('secret.used', { kind, viaTypist: false });
  }

  /**
   * 앱 입력 창이 인증서 비밀번호를 넘겼다(service가 secret.provide 직후 부른다). 기다리던 칸에 넣고, 넣었으면 확인 대기로 두고, 창을 닫는다.
   * 칸이 사라졌거나 넣지 못했으면 두지 않고 창만 닫는다(엔진은 로그인 결과로 판단한다). 값은 로그·이벤트에 싣지 않는다.
   */
  async appProvided(bind: { runId: string; kind: string; scope: string }): Promise<void> {
    if (bind.kind !== 'cert_password') return;
    const entry = [...this.appAsk].find(([, a]) => a.runId === bind.runId && a.scope === bind.scope);
    if (!entry) return;
    const [targetId, ask] = entry;
    this.appAsk.delete(targetId);
    const bytes = this.secrets.take(bind.runId, 'cert_password', bind.scope);
    const t = this.relay.targets.get(targetId);
    if (!bytes) return;
    const text = new TextDecoder().decode(bytes);
    bytes.fill(0);
    if (!t || t.win?.phase !== 'active') {
      this.log.event('vault.cert_password_app_late');
      return;
    }
    this.relay.addKnownSecret(t.targetId, knownValuePrefixVariants(text));
    const typed = await this.typeInto(t, ask.objectId, text);
    this.relay.addKnownSecret(t.targetId, knownValueVariants(text));
    // 기억은 로그인 확인 뒤(typist.authOk). 지금은 금고 메모리에만 둔다.
    if (typed.ok && this.opts.certMemory) this.opts.certMemory.hold(bind.runId, ask.scope, new TextEncoder().encode(text));
    this.relay.deactivateWindow(t); // 엔진에 secret_window.closed → 'done'
    this.log.event('secret.used', { kind: 'cert_password', viaTypist: true, ok: typed.ok, fromApp: true });
    this.selfScan(text);
  }

  /** 사용자가 "입력 완료"를 눌렀다(main 승인 창이나 금고 UI에서 온 신호만, 엔진 신호 아님). */
  async userDone(targetId: string): Promise<void> {
    const t = this.relay.exposedTarget(targetId);
    if (t?.win?.phase === 'active' && t.win.kind === 'human') await this.closeHuman(t);
  }

  /** 엔진의 종료 요청(라): human 창만, 대상 노드 포커스 해제를 확인한 뒤 승인. 타이피스트 입력 중에는 닫지 않는다(N-43). */
  async requestClose(req: { runId: string; targetId: string }): Promise<{ ok: boolean }> {
    const t = this.relay.exposedTarget(req.targetId);
    if (!t?.win || t.win.phase !== 'active') return { ok: true };
    if (t.win.kind !== 'human') {
      this.log.event('vault.secret_window_close_denied', { target: t.targetId.slice(0, 8), kind: t.win.kind });
      return { ok: false };
    }
    const w = this.human.get(t.targetId);
    const p = w ? await this.probe(t, w.objectId) : null;
    if (w && p && p.active) {
      this.log.event('vault.secret_window_close_denied', { target: t.targetId.slice(0, 8) });
      return { ok: false };
    }
    await this.closeHuman(t);
    return { ok: true };
  }

  /**
   * 오염 창 지우기: 값을 넣은 칸의 문서가 그대로라(홈택스 인증서 창 iframe#dscert는 서명 뒤 숨기만 하고 값을 남긴다, 실측 2026-11-13)
   * 창이 오염인 채로 남으면 금고 자신의 인쇄(pdf.print)가 막힌다. 그 칸 값을 비우고 비었는지 확인한 뒤에만 창을 끝낸다.
   * 활성 창(입력 중)은 건드리지 않는다. 칸을 못 찾으면(노드가 사라짐) 남은 값이 없는 것이다. 값은 읽지 않고 길이만 본다.
   */
  async scrubTainted(t: TargetState): Promise<boolean> {
    if (!t.win) return true;
    if (t.win.phase !== 'tainted') return false;
    for (const backendNodeId of t.secretBackendIds) {
      const r = await this.relay.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId }, t.vaultSession).catch(() => null);
      const objectId = r?.object.objectId;
      if (!objectId) continue;
      const left = await this.relay
        .send<{ result: { value?: unknown } }>('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(){if(typeof this.value!=="string")return 0;this.value="";return this.value.length}', returnByValue: true }, t.vaultSession)
        .catch(() => null);
      if (left?.result.value !== 0) return false;
    }
    if (t.win?.phase !== 'tainted') return false;
    this.relay.endWindow(t, 'scrubbed');
    this.log.event('vault.secret_window_scrubbed', { target: t.targetId.slice(0, 8) });
    return true;
  }

  shutdown(): void {
    for (const id of [...this.human.keys()]) this.stopHuman(id);
    this.appAsk.clear();
    this.secrets.clear();
  }
}

const isRow = (r: unknown): r is number => Number.isInteger(r) && (r as number) >= SECURITY_CARD_ROWS.min && (r as number) <= SECURITY_CARD_ROWS.max;

/** FillRequest.rowLabel 셀렉터 최대 길이. */
const ROW_LABEL_MAX = 256;

/** 보안카드 칸 번호 요소의 글자에서 칸 번호를 읽는다. 숫자가 정확히 하나(1~35)일 때만, 전각 숫자는 NFKC로 맞춘다. */
export function parseCardRow(text: unknown): number | null {
  if (typeof text !== 'string' || text.length > 64) return null;
  const nums = text.normalize('NFKC').match(/\d+/g) ?? [];
  if (nums.length !== 1) return null;
  const n = Number(nums[0]);
  return isRow(n) ? n : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function findFrameUrl(tree: Json, frameId: string): string | undefined {
  const frame = tree.frame as Json;
  if (frame.id === frameId) return String(frame.url) + String(frame.urlFragment ?? '');
  for (const c of (tree.childFrames as Json[]) ?? []) {
    const u = findFrameUrl(c, frameId);
    if (u) return u;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
