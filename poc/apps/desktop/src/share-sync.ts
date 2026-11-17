// 계정 공유 기록 동기화(ADR-048 결정 5, D07 §10): 이 PC가 쓴 줄을 봉인해 올리고, 다른 기기가 쓴 줄을 받아 열고 서명을 확인한다. main 전용.
// - 대상: 이 PC의 기기 목록에 기기가 2대 이상일 때만 서버를 부른다(PC 한 대뿐인 계정은 아무것도 올리지 않는다, E-07).
// - 키: K_share(e)는 금고가 RK에서 만든다(crypto.shareKey). 이 모듈은 한 번의 동기화 동안만 들고 있다가 지운다. PC 줄의 서명(Ws)은 금고가 한다.
// - 세대 e는 AIK로 검증한 자기 기기 목록의 폐기 레코드 수다. 서버가 말하는 세대는 "목록을 다시 받아 보라"는 신호로만 쓴다.
// - 받은 줄은 서버가 준 것이라 믿지 않는다. openShareRow가 통과시킨 줄만 저장소에 넘긴다. 폰이 쓴 줄은 그 폰이 지금 목록에 있을 때만 받는다.
// - 서버는 줄을 숨기거나 늦출 수 있다. 그래서 여기서 받은 줄은 화면과 경고에만 쓰고, 발급 여부 판단은 포털 기준선과 발급 잠금이 한다(D03).
// - 기록: 줄의 내용·id·키는 남기지 않는다. 이벤트는 개수와 결과 코드만.
import {
  fromB64, openShareRow, sealShareRow, shareEpoch, SHARE_MAX_EPOCH,
  type DeviceListJson, type ShareBodies, type ShareKind, type ShareRowCore, type ShareVerifyKeys,
} from '@sax/remote';
import type { AccountClient, DeviceAuth, ShareServerRow, ShareVault } from './remote-ports.ts';

/** 이 PC가 올릴 줄 하나. 줄 id는 만든 쪽(엔진 장부)이 정하고 다시 올려도 같다. */
export type ShareOutItem = { [K in ShareKind]: { rowId: string; kind: K; at: number; body: ShareBodies[K]; taskId?: string } }[ShareKind];

/** 받은 줄 하나(서명까지 확인했다). seq는 서버 순번이다. */
export interface ShareInRow {
  seq: number;
  row: ShareRowCore;
}

/**
 * 줄을 내고 받는 곳(엔진 장부). 이 모듈은 저장소가 무엇인지 모른다.
 * - pending: 아직 서버가 받지 않은 줄(오래된 것부터, limit개까지).
 * - sent: 서버가 받았다. seq가 null이면 "이미 올라가 있었다"(끊긴 응답 뒤 다시 올린 경우).
 * - dropped: 다시 올려도 안 되는 줄(모양이 규칙 밖, 일이 이미 끝남). 다시 내지 않는다.
 * - cursor/apply: 받은 마지막 순번. apply는 줄을 넣고 커서를 한 번에 옮긴다. 같은 줄이 또 와도 한 번만 넣는다.
 *   받은 거래처 줄로 이 PC 거래처 목록이 바뀌었으면 바뀐 곳 수(parties)를 돌려준다.
 */
export interface ShareStore {
  pending(limit: number): Promise<ShareOutItem[]>;
  sent(rowId: string, seq: number | null): Promise<void>;
  dropped(rowId: string, reason: string): Promise<void>;
  cursor(): Promise<number>;
  apply(rows: ShareInRow[], cursor: number): Promise<{ parties?: number } | void>;
}

/** DeviceSession 중 이 모듈이 쓰는 부분. */
export interface ShareDevice {
  readonly deviceId: string;
  readonly deviceList: DeviceListJson;
  auth: DeviceAuth;
  clearToken(): void;
}

export interface ShareSyncOptions {
  client: Pick<AccountClient, 'putShareRow' | 'shareRows'> | null;
  /** 로그인(기기 등록)을 마쳤으면 기기 세션, 아니면 null. */
  device: () => ShareDevice | null | Promise<ShareDevice | null>;
  vault: () => Promise<ShareVault>;
  store: ShareStore;
  /** 올리기 전에 장부에서 올릴 줄을 모은다(엔진 share.collect). 기기가 2대 이상일 때만, 받은 뒤에 부른다(다른 기기가 이미 올린 줄을 다시 만들지 않게). */
  collect?: () => Promise<unknown>;
  /** 서버의 최신 기기 목록을 받아 검증하고 기기 세션에 넣는다(DeviceManager). 세대가 뒤처졌거나 모르는 폰의 줄이 왔을 때 한 번 부른다. */
  refreshDeviceList?: () => Promise<void>;
  now?: () => number;
  log?: (name: string, data: Record<string, string | number | boolean>) => void;
}

export type ShareSyncState =
  /** 끝까지 했다 */
  | 'ok'
  /** 기기가 하나뿐이거나 로그인 전이라 할 일이 없다 */
  | 'not_needed'
  /** 서버에 닿지 못했거나 서버가 거절했다(code). 다음에 다시 한다 */
  | 'failed';

export interface ShareSyncResult {
  state: ShareSyncState;
  code?: string;
  /** 서버에서 받은 줄 수, 그 가운데 확인을 통과해 넣은 줄 수 */
  pulled: number;
  applied: number;
  /** 확인에서 떨어진 줄 수(이유별) */
  rejected: Partial<Record<'key' | 'shape' | 'mismatch' | 'signer' | 'signature', number>>;
  pushed: number;
  dropped: number;
  /** 받은 거래처 줄로 바뀐 이 PC 거래처 수(더함·고침·지움). 0보다 크면 부르는 쪽이 거래처 목록을 다시 읽는다 */
  parties: number;
}

/** 한 번에 올리는 줄 수(기기당 시간 한도 600 안에서 여유 있게). */
export const SHARE_PUSH_BATCH = 50;
/** 한 번의 동기화에서 받는 쪽 수 상한(200줄씩). 넘으면 다음 동기화에서 이어 받는다. */
export const SHARE_PULL_PAGES = 25;

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[a-z_]+\.[a-z_]+$/.test(c) ? c : 'share.failed';
};

/** 한 번의 동기화 동안 쓰는 키 묶음. 끝나면 지운다. */
class Keys {
  readonly #vault: ShareVault;
  readonly #byEpoch = new Map<number, Uint8Array>();
  #signPub: Uint8Array | null = null;
  constructor(vault: ShareVault) {
    this.#vault = vault;
  }
  async key(epoch: number): Promise<Uint8Array> {
    const have = this.#byEpoch.get(epoch);
    if (have) return have;
    const r = await this.#vault.key(epoch);
    this.#byEpoch.set(epoch, r.key);
    this.#signPub = r.signPub;
    return r.key;
  }
  async signPub(): Promise<Uint8Array> {
    if (!this.#signPub) await this.key(0);
    return this.#signPub!;
  }
  wipe(): void {
    for (const k of this.#byEpoch.values()) k.fill(0);
    this.#byEpoch.clear();
  }
}

/** 지금 목록에 있는 폰의 서명 키(Vm). 목록에 없는 폰(끊겼거나 아직 모르는 폰)은 null. */
function mobileSignPubs(list: DeviceListJson): (deviceId: string) => Uint8Array | null {
  const m = new Map<string, Uint8Array>();
  for (const e of list.entries) if (e.entry.role === 'mobile') m.set(e.entry.device_id, fromB64(e.entry.Vx));
  return (id) => m.get(id) ?? null;
}

export class ShareSync {
  readonly #o: ShareSyncOptions;
  readonly #now: () => number;
  /** 동기화는 한 번에 하나(커서와 올리기가 겹치지 않게). */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(o: ShareSyncOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  /** 받고 나서 올린다. 던지지 않는다(결과의 state·code로 알린다). */
  sync(): Promise<ShareSyncResult> {
    const p = this.#chain.then(() => this.#run());
    this.#chain = p.catch(() => {});
    return p;
  }

  async #run(): Promise<ShareSyncResult> {
    const out: ShareSyncResult = { state: 'ok', pulled: 0, applied: 0, rejected: {}, pushed: 0, dropped: 0, parties: 0 };
    const started = this.#now();
    let keys: Keys | null = null;
    try {
      const client = this.#o.client;
      const dev = client ? await this.#o.device() : null;
      // 기기가 하나뿐이면 서버를 부르지 않는다. 밀린 줄은 장부에 그대로 있다가 두 번째 기기가 붙으면 올라간다
      if (!client || !dev || dev.deviceList.entries.length < 2) {
        out.state = 'not_needed';
        return out;
      }
      keys = new Keys(await this.#o.vault());
      await this.#pull(client, dev, keys, out);
      await this.#o.collect?.();
      await this.#push(client, dev, keys, out);
    } catch (e) {
      out.state = 'failed';
      out.code = codeOf(e);
    } finally {
      keys?.wipe();
      if (out.state !== 'not_needed') {
        const rejected = Object.values(out.rejected).reduce((a, b) => a + (b ?? 0), 0);
        this.#o.log?.('main.share_sync', { result: out.code ?? out.state, pulled: out.pulled, applied: out.applied, rejected, pushed: out.pushed, dropped: out.dropped, parties: out.parties, ms: this.#now() - started });
      }
    }
    return out;
  }

  async #call<T>(dev: ShareDevice, f: (auth: DeviceAuth) => Promise<T>): Promise<T> {
    try {
      return await f(dev.auth);
    } catch (e) {
      if (codeOf(e) !== 'account.unauthorized') throw e;
      dev.clearToken();
      return f(dev.auth);
    }
  }

  /** 목록을 다시 받았으면 true. 받는 길이 없거나 실패하면 false(지금 목록으로 계속한다). */
  async #refresh(): Promise<boolean> {
    if (!this.#o.refreshDeviceList) return false;
    try {
      await this.#o.refreshDeviceList();
      return true;
    } catch {
      return false;
    }
  }

  async #pull(client: NonNullable<ShareSyncOptions['client']>, dev: ShareDevice, keys: Keys, out: ShareSyncResult): Promise<void> {
    let cursor = await this.#o.store.cursor();
    let refreshed = false;
    for (let page = 0; page < SHARE_PULL_PAGES; page++) {
      const got = await this.#call(dev, (auth) => client.shareRows(auth, cursor));
      // 이미 받은 순번보다 낮은 끝(계정의 마지막 순번)을 말하는 서버는 되감은 것이다. 커서를 내리지 않고 멈춘다
      if (got.head < cursor) {
        this.#o.log?.('main.share_head_regressed', { behind: cursor - got.head });
        throw Object.assign(new Error('head'), { code: 'share.head_regressed' });
      }
      if (!got.rows.length) return;
      // 서버가 본 세대가 내 목록보다 높으면 다른 PC가 기기를 끊은 것이다: 목록을 한 번 다시 받는다
      if (!refreshed && got.epoch > shareEpoch(dev.deviceList)) refreshed = await this.#refresh();
      let opened = await this.#open(got.rows, dev, keys);
      // 모르는 폰이 쓴 줄이 있으면 다른 PC가 폰을 붙인 것일 수 있다: 목록을 한 번 다시 받고 그 쪽만 다시 연다
      if (!refreshed && opened.rejected.signer && (refreshed = await this.#refresh())) opened = await this.#open(got.rows, dev, keys);
      const last = got.rows[got.rows.length - 1]!.seq;
      const done = await this.#o.store.apply(opened.rows, last);
      if (done && Number.isSafeInteger(done.parties) && done.parties! > 0) out.parties += done.parties!;
      cursor = last;
      out.pulled += got.rows.length;
      out.applied += opened.rows.length;
      for (const [k, n] of Object.entries(opened.rejected) as Array<[keyof ShareSyncResult['rejected'], number]>) out.rejected[k] = (out.rejected[k] ?? 0) + n;
      if (!got.more) return;
    }
  }

  async #open(rows: ShareServerRow[], dev: ShareDevice, keys: Keys): Promise<{ rows: ShareInRow[]; rejected: ShareSyncResult['rejected'] }> {
    const verify: ShareVerifyKeys = { sharePub: await keys.signPub(), mobileSignPub: mobileSignPubs(dev.deviceList) };
    const ok: ShareInRow[] = [];
    const rejected: ShareSyncResult['rejected'] = {};
    for (const r of rows) {
      const res = r.epoch > SHARE_MAX_EPOCH ? ({ ok: false, reason: 'shape' } as const) : openShareRow(await keys.key(r.epoch), { rowId: r.rowId, kind: r.kind, epoch: r.epoch, body: r.body }, verify);
      if (res.ok) ok.push({ seq: r.seq, row: res.row });
      else rejected[res.reason] = (rejected[res.reason] ?? 0) + 1;
    }
    return { rows: ok, rejected };
  }

  async #push(client: NonNullable<ShareSyncOptions['client']>, dev: ShareDevice, keys: Keys, out: ShareSyncResult): Promise<void> {
    const items = await this.#o.store.pending(SHARE_PUSH_BATCH);
    if (!items.length) return;
    const vault = await this.#o.vault();
    let refreshed = false;
    for (const item of items) {
      for (;;) {
        const epoch = shareEpoch(dev.deviceList);
        const core = { v: 1, row_id: item.rowId, kind: item.kind, epoch, at: item.at, dev: dev.deviceId, by: 'desktop', body: item.body } as ShareRowCore;
        let wire;
        try {
          wire = await sealShareRow(await keys.key(epoch), core, (msg) => vault.sign(msg));
        } catch (e) {
          // 모양이 규칙 밖인 줄은 다시 올려도 같다. 금고가 실패한 것이면(서명·키) 줄 탓이 아니니 밖으로 던진다
          if (!(e instanceof Error) || !/^share: (row shape|row too large)$/.test(e.message)) throw e;
          await this.#o.store.dropped(item.rowId, 'shape');
          out.dropped++;
          break;
        }
        try {
          const r = await this.#call(dev, (auth) => client.putShareRow(auth, item.taskId === undefined ? wire : { ...wire, taskId: item.taskId }));
          await this.#o.store.sent(item.rowId, r.seq);
          out.pushed++;
          break;
        } catch (e) {
          const code = codeOf(e);
          if (code === 'account.share_row_conflict') {
            // 내가 만든 줄 id가 이미 서버에 있다: 앞서 올렸는데 응답을 못 받은 것이다(봉인은 매번 달라서 같은 내용으로 보이지 않는다)
            await this.#o.store.sent(item.rowId, null);
            out.pushed++;
            break;
          }
          if (code === 'account.task_not_claimed' || code === 'account.task_closed' || code === 'account.task_not_found') {
            await this.#o.store.dropped(item.rowId, code);
            out.dropped++;
            break;
          }
          // 다른 PC가 기기를 끊어 세대가 올랐다: 목록을 다시 받고 새 세대로 한 번 더 봉인한다
          if (code === 'account.share_epoch_stale' && !refreshed && (refreshed = await this.#refresh()) && shareEpoch(dev.deviceList) > epoch) continue;
          throw e;
        }
      }
    }
  }
}

/** 엔진 RPC(main → 엔진). EngineHost.rpc와 같은 모양이다. */
export type ShareEngineRpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** 엔진 장부(ShareService)를 ShareStore로 쓴다. 엔진이 준 모양이 다르면 던진다(동기화는 failed로 끝나고 다음에 다시 한다). */
export function engineShareStore(rpc: ShareEngineRpc): ShareStore {
  const bad = (): never => {
    throw Object.assign(new Error('share store'), { code: 'share.store_failed' });
  };
  return {
    async pending(limit) {
      const r = (await rpc('db.query.share.pending', { limit })) as { rows?: unknown } | null;
      return Array.isArray(r?.rows) ? (r.rows as ShareOutItem[]) : bad();
    },
    async sent(rowId, seq) {
      await rpc('share.sent', { rowId, seq });
    },
    async dropped(rowId, reason) {
      await rpc('share.dropped', { rowId, reason });
    },
    async cursor() {
      const r = (await rpc('db.query.share.cursor')) as { cursor?: unknown } | null;
      return Number.isSafeInteger(r?.cursor) && (r!.cursor as number) >= 0 ? (r!.cursor as number) : bad();
    },
    async apply(rows, cursor) {
      const r = (await rpc('share.apply', { rows, cursor })) as { parties?: { added?: unknown; updated?: unknown; removed?: unknown } } | null;
      const n = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : 0);
      return { parties: n(r?.parties?.added) + n(r?.parties?.updated) + n(r?.parties?.removed) };
    },
  };
}
