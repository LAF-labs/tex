// 연결된 폰 수신(D08 §5·§7·§8, ADR-007). 페어링이 끝난 폰마다 우편함 하나를 지켜 사진·현금매출을 받는다.
// - 보관: 페어 기록(폰 공개키·우편함 ID·mbx_epoch·재전송 방지 최고값)은 앱 데이터의 remote-phones.json(0600)에,
//   우편함 능력 토큰(tok_read·tok_write)은 seal(Electron safeStorage)로 봉인한 값만 둔다. 개인키는 금고 밖으로 나오지 않는다.
//   토큰만으로는 우편함에 들어가지 못한다(기기 범위 토큰 + DPoP(Vd, 금고)가 함께 있어야 한다, services/relay/API.md 인증 두 겹).
// - 받는 길 둘: (1) 라이브 우편함 WSS(폰·PC가 둘 다 켜져 있을 때, Noise_IK 세션), (2) HTTPS 큐(PC가 꺼져 있던 동안 쌓인 HPKE 봉투).
//   운영 라이브는 룸 호스트 RELAY_LIVE=1일 때만 열린다. 닫혀 있으면 업그레이드가 거절되고, 큐 폴링만으로 받는다(늦게 다시 시도).
// - 큐 번들(Q_D 공개키, Vd 서명)은 유효기간 7일이라 하루 남으면 새 seq로 다시 올린다.
// - 로그는 단계·결과 코드만(우편함 ID·토큰·폰 이름·금액 없음).
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  acceptDesktopSession,
  b64,
  CAP,
  fromB64,
  makeQBundle,
  QBUNDLE_DAYS,
  qbundleWindow,
  type DesktopPairResult,
  type HpkeOpenFn,
  type MailboxTokens,
  type NoiseStatic,
  type PairRecord,
  type RelayLink,
  type RelayQueue,
  type Signer,
  type CTX,
} from '@sax/remote';
import type { PhoneReceiver } from './phone-receive.ts';

const DAY = 86_400_000;
const FILE_VERSION = 1;
/** 폰 앱이 hello에서 보는 PC 기능. receipt.v2 = 종이 세금계산서 값(paperInvoice)을 받아 꾸러미에 넣는다. */
export const DESKTOP_CAPS: readonly string[] = Object.freeze([CAP.receipt, CAP.receiptV2, CAP.cash]);

export interface PhoneRecord {
  pairId: string;
  deviceId: string;
  name: string;
  platform: 'ios' | 'android';
  pairedAt: number;
  /** 폰 Noise 정적 공개키 Sm(b64) */
  Sm: string;
  /** 폰 서명 공개키 Vm(b64, 큐 봉투 서명 확인) */
  Vm: string;
  /** 우편함 ID(b64, 32B) */
  mbxId: string;
  /** 봉인한 {read, write}(seal 결과) */
  tok: string;
  mbxEpoch: number;
  ikTsMax: number;
  asyncSeqMax: number;
  qbundleSeq: number;
  qbundleValidTo: number;
  lastSeenAt: number | null;
}

interface FileShape {
  v: 1;
  phones: PhoneRecord[];
}

/** 토큰 봉인. 제품은 Electron safeStorage(키체인·DPAPI). 시험은 그대로. */
export interface TokenSeal {
  seal(plain: Uint8Array): string;
  open(sealed: string): Uint8Array;
}

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isRec = (r: unknown): r is PhoneRecord => {
  const x = r as Partial<PhoneRecord> | null;
  const int = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  return (
    !!x &&
    typeof x.pairId === 'string' && x.pairId.length > 0 && x.pairId.length <= 64 &&
    typeof x.deviceId === 'string' && UUID4.test(x.deviceId) &&
    typeof x.name === 'string' && x.name.length <= 40 &&
    (x.platform === 'ios' || x.platform === 'android') &&
    [x.Sm, x.Vm, x.mbxId].every((k) => typeof k === 'string' && k.length <= 64) &&
    typeof x.tok === 'string' && x.tok.length <= 4096 &&
    [x.pairedAt, x.mbxEpoch, x.ikTsMax, x.asyncSeqMax, x.qbundleSeq, x.qbundleValidTo].every(int) &&
    (x.lastSeenAt === null || int(x.lastSeenAt))
  );
};

/** remote-phones.json. 쓰기는 임시 파일 → rename(반쯤 쓴 파일이 남지 않게). 같은 객체 안에서 쓰기를 줄 세운다. */
export class PhoneStore {
  #file: string;
  #chain: Promise<unknown> = Promise.resolve();
  constructor(file: string) {
    this.#file = file;
  }
  async load(): Promise<PhoneRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.#file, 'utf8');
    } catch {
      return [];
    }
    try {
      const j = JSON.parse(raw) as Partial<FileShape>;
      if (j.v !== FILE_VERSION || !Array.isArray(j.phones)) return [];
      return j.phones.filter(isRec);
    } catch {
      return [];
    }
  }
  save(phones: readonly PhoneRecord[]): Promise<void> {
    const run = async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ v: FILE_VERSION, phones: [...phones] } satisfies FileShape), { mode: 0o600 });
      // Windows: 다른 프로세스(백신·색인·읽는 중)가 대상 파일을 열고 있으면 rename이 잠깐 EPERM·EBUSY로 실패한다
      for (let i = 0; ; i++) {
        try {
          await fs.rename(tmp, this.#file);
          return;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (i >= 9 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw e;
          await new Promise((r) => setTimeout(r, 20 * (i + 1)));
        }
      }
    };
    const p = this.#chain.then(run, run);
    this.#chain = p.catch(() => undefined);
    return p;
  }
}

export interface PhoneLinkKeys {
  noise: NoiseStatic;
  vd: Pick<Signer<typeof CTX.qbundle>, 'sign'>;
  hpkeOpen: HpkeOpenFn;
  qdPublic: Uint8Array;
}

export interface PhoneView {
  pairId: string;
  name: string;
  platform: 'ios' | 'android';
  pairedAt: number;
  online: boolean;
  lastSeenAt: number | null;
}

export interface PhoneLinkOptions {
  store: PhoneStore;
  seal: TokenSeal;
  keys: () => Promise<PhoneLinkKeys>;
  /** 라이브 우편함(WSS). 없으면 큐만. */
  joinMailbox?: (mbxId: Uint8Array, tok: MailboxTokens) => Promise<RelayLink>;
  /** HTTPS 큐(services/relay/API.md). @sax/remote relayQueue를 기기 인증과 함께 묶은 것 */
  queue: (mbxId: Uint8Array, tok: MailboxTokens) => Pick<RelayQueue, 'list' | 'listPage' | 'ack' | 'putBundle'>;
  /** 페어 하나당 수신기(phone-receive.ts phoneReceiver) */
  receiver: (pairId: string) => PhoneReceiver;
  /** 우편함 삭제(연결 해제). 실패해도 로컬 기록은 지운다. */
  deleteMailbox?: (mbxId: Uint8Array, tokWrite: Uint8Array) => Promise<void>;
  deviceListVersion: () => number;
  appVersion: string;
  capabilities?: () => readonly string[];
  /** 큐 폴링 간격(기본: 라이브 연결 중 5분, 아니면 30초) */
  pollMs?: { live: number; idle: number };
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (name: string, data?: Record<string, string | number | boolean>) => void;
  onChange?: () => void;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    if (signal.aborted) return res();
    const t = setTimeout(res, ms);
    t.unref?.();
    signal.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
  });

interface Runner {
  rec: PhoneRecord;
  abort: AbortController;
  link: RelayLink | null;
  online: boolean;
  /** 큐 폴링을 바로 깨운다({"t":"env"}) */
  kick: () => void;
  /** 라이브 재시도 대기를 끊고 바로 다시 붙는다(백오프 초기화) */
  retry: (() => void) | null;
}

/** 라이브 재연결 백오프: 1초부터 두 배씩, 30초 상한(집에 둔 PC가 밖의 폰에 늦어도 30초 안에 다시 붙는다). */
export const LIVE_BACKOFF = { minMs: 1000, maxMs: 30_000 } as const;

/** 폰 수신 관리. start()로 저장된 폰을 모두 지키고, add()로 방금 연결한 폰을 더한다. */
export class PhoneLink {
  #o: PhoneLinkOptions;
  #recs: PhoneRecord[] = [];
  #runs = new Map<string, Runner>();
  #now: () => number;
  #sleep: NonNullable<PhoneLinkOptions['sleep']>;
  #log: NonNullable<PhoneLinkOptions['log']>;
  #started = false;
  /** 페어마다 수신기 하나(라이브와 큐가 같은 조립·중복 판정을 쓴다) */
  #receivers = new Map<string, PhoneReceiver>();

  constructor(o: PhoneLinkOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#sleep = o.sleep ?? defaultSleep;
    this.#log = o.log ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#recs = await this.#o.store.load();
    for (const r of this.#recs) this.#run(r);
    this.#log('main.phone_link', { step: 'start', phones: this.#recs.length });
  }

  /** 페어링 결과를 저장하고 바로 지킨다. 같은 폰(deviceId)을 다시 연결하면 옛 기록을 바꾼다. */
  async add(r: DesktopPairResult): Promise<void> {
    const rec: PhoneRecord = {
      pairId: r.pairId,
      deviceId: r.phone.deviceId,
      name: r.phone.name.slice(0, 40),
      platform: r.phone.platform,
      pairedAt: this.#now(),
      Sm: b64(r.phone.Sm),
      Vm: b64(r.phone.Vm),
      mbxId: b64(r.mbxId),
      tok: this.#o.seal.seal(packTok(r.tokRead, r.tokWrite)),
      mbxEpoch: r.mbxEpoch,
      ikTsMax: 0,
      asyncSeqMax: 0,
      qbundleSeq: 0,
      qbundleValidTo: 0,
      lastSeenAt: null,
    };
    const replaced = this.#recs.filter((x) => x.deviceId === rec.deviceId || x.pairId === rec.pairId);
    for (const old of replaced) this.#stopRun(old.pairId);
    this.#recs = [...this.#recs.filter((x) => x.deviceId !== rec.deviceId && x.pairId !== rec.pairId), rec];
    await this.#o.store.save(this.#recs);
    this.#log('main.phone_link', { step: 'added' });
    // 같은 폰을 다시 연결했으면 옛 우편함을 지운다(실패해도 새 연결은 그대로)
    for (const old of replaced) {
      if (old.mbxId === rec.mbxId) continue;
      void (async () => {
        const t = unpackTok(this.#o.seal.open(old.tok));
        await this.#o.deleteMailbox?.(fromB64(old.mbxId), t.write);
      })().catch((e) => this.#log('main.phone_link', { step: 'replace_mailbox', result: codeOf(e) }));
    }
    if (this.#started) this.#run(rec);
    this.#o.onChange?.();
  }

  /** 연결 해제: 우편함을 지우고(실패해도) 기록을 지운다. 폰은 다음 연결에서 우편함이 없다는 것을 안다. */
  async remove(pairId: string): Promise<boolean> {
    const rec = this.#recs.find((x) => x.pairId === pairId);
    if (!rec) return false;
    this.#stopRun(pairId);
    try {
      const t = unpackTok(this.#o.seal.open(rec.tok));
      await this.#o.deleteMailbox?.(fromB64(rec.mbxId), t.write);
    } catch (e) {
      this.#log('main.phone_link', { step: 'remove_mailbox', result: codeOf(e) });
    }
    this.#recs = this.#recs.filter((x) => x.pairId !== pairId);
    await this.#o.store.save(this.#recs);
    this.#log('main.phone_link', { step: 'removed' });
    this.#o.onChange?.();
    return true;
  }

  /** 기기 ID로 연결 해제(기기 화면에서 끊었거나 폰이 스스로 나갔을 때). 그 폰의 기록이 없으면 false. */
  async removeDevice(deviceId: string): Promise<boolean> {
    const ids = this.#recs.filter((x) => x.deviceId === deviceId).map((x) => x.pairId);
    let any = false;
    for (const id of ids) any = (await this.remove(id)) || any;
    return any;
  }

  list(): PhoneView[] {
    return this.#recs.map((r) => ({ pairId: r.pairId, name: r.name, platform: r.platform, pairedAt: r.pairedAt, online: this.#runs.get(r.pairId)?.online ?? false, lastSeenAt: r.lastSeenAt }));
  }

  /** 모든 수신을 멈춘다(앱 종료). 기록은 그대로다. */
  stop(): void {
    for (const id of [...this.#runs.keys()]) this.#stopRun(id);
    this.#started = false;
  }

  /** 저장된 큐를 지금 한 번 비운다(시험·[지금 받기]). */
  async drainNow(pairId: string): Promise<number> {
    const rec = this.#recs.find((x) => x.pairId === pairId);
    if (!rec) return 0;
    return this.#drain(rec);
  }

  #receiver(pairId: string): PhoneReceiver {
    let r = this.#receivers.get(pairId);
    if (!r) this.#receivers.set(pairId, (r = this.#o.receiver(pairId)));
    return r;
  }

  #stopRun(pairId: string): void {
    const r = this.#runs.get(pairId);
    if (!r) return;
    r.abort.abort();
    r.link?.close();
    this.#runs.delete(pairId);
    this.#receivers.delete(pairId);
  }

  #persist(rec: PhoneRecord, patch: Partial<PhoneRecord>): Promise<void> {
    Object.assign(rec, patch);
    // 지운 폰의 늦은 갱신은 쓰지 않는다
    if (!this.#recs.includes(rec)) return Promise.resolve();
    return this.#o.store.save(this.#recs);
  }

  #run(rec: PhoneRecord): void {
    if (this.#runs.has(rec.pairId)) return;
    const abort = new AbortController();
    let wake: (() => void) | null = null;
    const run: Runner = { rec, abort, link: null, online: false, kick: () => wake?.(), retry: null };
    this.#runs.set(rec.pairId, run);
    // 큐: 번들 갱신 + 폴링
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          await this.#ensureBundle(rec);
          await this.#drain(rec);
        } catch (e) {
          this.#log('main.phone_queue', { result: codeOf(e) });
        }
        const poll = this.#o.pollMs ?? { live: 5 * 60_000, idle: 30_000 };
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        abort.signal.addEventListener('abort', onAbort, { once: true });
        wake = () => ac.abort();
        await this.#sleep(run.link && !run.link.closed ? poll.live : poll.idle, ac.signal);
        wake = null;
        abort.signal.removeEventListener('abort', onAbort);
      }
    })();
    // 라이브: 붙어 있는 동안 세션을 받는다. 실패하면 1초부터 30초까지 늘려 다시 시도한다(LIVE_BACKOFF).
    if (this.#o.joinMailbox) void this.#live(run);
  }

  /**
   * 깨어남·화면 잠금 해제·네트워크 변화: 재시도 대기를 끊고 바로 붙고, 큐도 바로 비운다.
   * reconnect면 열린 연결도 닫고 새로 붙는다(잠자기 뒤의 TCP는 열려 보여도 죽어 있다).
   */
  wake(why: 'resume' | 'unlock' | 'online', reconnect = why === 'resume'): void {
    if (!this.#started) return;
    for (const run of this.#runs.values()) {
      if (reconnect) run.link?.close();
      run.retry?.();
      run.kick();
    }
    this.#log('main.phone_link', { step: 'wake', why, phones: this.#runs.size });
  }

  /** 재시도 대기. wake()가 끊으면 백오프를 처음으로 돌린다. */
  async #retryWait(run: Runner, ms: number): Promise<boolean> {
    const ac = new AbortController();
    let woke = false;
    const onAbort = () => ac.abort();
    run.abort.signal.addEventListener('abort', onAbort, { once: true });
    run.retry = () => ((woke = true), ac.abort());
    await this.#sleep(ms, ac.signal);
    run.retry = null;
    run.abort.signal.removeEventListener('abort', onAbort);
    return woke;
  }

  async #live(run: Runner): Promise<void> {
    const { rec, abort } = run;
    let backoff: number = LIVE_BACKOFF.minMs;
    while (!abort.signal.aborted) {
      let link: RelayLink;
      try {
        const t = unpackTok(this.#o.seal.open(rec.tok));
        link = await this.#o.joinMailbox!(fromB64(rec.mbxId), t);
      } catch (e) {
        this.#log('main.phone_live', { step: 'join', result: codeOf(e) });
        backoff = (await this.#retryWait(run, backoff)) ? LIVE_BACKOFF.minMs : Math.min(backoff * 2, LIVE_BACKOFF.maxMs);
        continue;
      }
      if (abort.signal.aborted) {
        link.close();
        return;
      }
      backoff = LIVE_BACKOFF.minMs;
      run.link = link;
      link.onEnv(() => run.kick());
      this.#log('main.phone_live', { step: 'joined' });
      const keys = await this.#o.keys();
      const pair: PairRecord = { pairId: rec.pairId, phoneStatic: fromB64(rec.Sm), revoked: false, ikTsMax: rec.ikTsMax };
      const receiver = this.#receiver(rec.pairId);
      while (!link.closed && !abort.signal.aborted) {
        let sess: Awaited<ReturnType<typeof acceptDesktopSession>>;
        try {
          sess = await acceptDesktopSession(link, {
          noise: keys.noise,
          pair,
          hello: { appVersion: this.#o.appVersion, deviceListVersion: this.#o.deviceListVersion(), asyncSeqMax: rec.asyncSeqMax, capabilities: [...(this.#o.capabilities?.() ?? DESKTOP_CAPS)] },
          persistTs: (_id, ts) => this.#persist(rec, { ikTsMax: ts }),
          });
        } catch (e) {
          // 세션 하나가 깨져도 라이브 루프는 산다(연결을 새로 받는다)
          this.#log('main.phone_live', { step: 'accept', result: codeOf(e) });
          link.close();
          break;
        }
        if (!sess) continue;
        run.online = true;
        await this.#persist(rec, { lastSeenAt: this.#now() });
        this.#o.onChange?.();
        this.#log('main.phone_live', { step: 'session', listMismatch: sess.deviceListMismatch });
        // 폰이 세션을 열 때 큐에 남긴 것도 비운다(라이브로 다시 보내기 전에 중복을 줄인다)
        run.kick();
        try {
          while (!sess.channel.closed && !abort.signal.aborted) {
            const env = await sess.channel.recv(30_000);
            if (env) await receiver.queue.handle(sess.channel, env);
          }
        } catch (e) {
          this.#log('main.phone_live', { step: 'recv', result: codeOf(e) });
          sess.channel.close();
        }
        run.online = false;
        this.#o.onChange?.();
      }
      run.link = null;
      if (!abort.signal.aborted) await this.#retryWait(run, backoff);
    }
  }

  async #ensureBundle(rec: PhoneRecord): Promise<void> {
    const now = this.#now();
    if (rec.qbundleValidTo - now > DAY) return;
    const keys = await this.#o.keys();
    const seq = rec.qbundleSeq + 1;
    const w = qbundleWindow(now);
    const t = unpackTok(this.#o.seal.open(rec.tok));
    await this.#o.queue(fromB64(rec.mbxId), t).putBundle(await makeQBundle(keys.vd, { Qx: keys.qdPublic, seq, ...w }));
    await this.#persist(rec, { qbundleSeq: seq, qbundleValidTo: w.validTo });
    this.#log('main.phone_queue', { step: 'bundle', days: QBUNDLE_DAYS });
  }

  async #drain(rec: PhoneRecord): Promise<number> {
    const keys = await this.#o.keys();
    const t = unpackTok(this.#o.seal.open(rec.tok));
    const r = await this.#receiver(rec.pairId).drain({
      queue: this.#o.queue(fromB64(rec.mbxId), t),
      hpkeOpen: keys.hpkeOpen,
      pairId: rec.pairId,
      phoneVm: fromB64(rec.Vm),
      mbxEpoch: rec.mbxEpoch,
      seqMax: { get: async () => rec.asyncSeqMax, set: (s) => this.#persist(rec, { asyncSeqMax: s }) },
      now: this.#now,
    });
    if (r.handled) {
      await this.#persist(rec, { lastSeenAt: this.#now() });
      this.#log('main.phone_queue', { step: 'drained', handled: r.handled, dropped: r.dropped });
      this.#o.onChange?.();
    }
    return r.handled;
  }
}

/** 토큰 두 개(32B씩)를 64B 하나로 */
export function packTok(read: Uint8Array, write: Uint8Array): Uint8Array {
  if (read.length !== 32 || write.length !== 32) throw new Error('phone.bad_token');
  const b = new Uint8Array(64);
  b.set(read, 0);
  b.set(write, 32);
  return b;
}
export function unpackTok(b: Uint8Array): MailboxTokens {
  if (b.length !== 64) throw new Error('phone.bad_token');
  return { read: b.slice(0, 32), write: b.slice(32) };
}

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  if (typeof c === 'string' && /^[a-z_]+\.[a-z_]+$/.test(c)) return c;
  const m = (e as Error | null)?.message;
  if (typeof m === 'string' && /^[a-z_]+\.[a-z_]+$/.test(m)) return m;
  return 'failed';
};
