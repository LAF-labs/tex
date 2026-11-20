import fs from 'node:fs/promises';
import path from 'node:path';
import {
  acceptDesktopSession,
  b64,
  KIND,
  nextFrame,
  queuedFrame,
  parseFrame,
  CAP,
  fromB64,
  makeQBundle,
  pxIdOf,
  PX_HW,
  verifyPxEnroll,
  QBUNDLE_DAYS,
  qbundleWindow,
  type DesktopPairResult,
  type HpkeOpenFn,
  type MailboxTokens,
  type NoiseStatic,
  type PairRecord,
  type PxAckBody,
  type PxEnrollBody,
  type PxHw,
  type RelayLink,
  type RelayQueue,
  type ShareKeyBody,
  type Signer,
  type CTX,
  type Channel,
  type Envelope,
} from '@sax/remote';
import type { PhoneReceiver } from './phone-receive.ts';

const DAY = 86_400_000;
const FILE_VERSION = 1;
export const DESKTOP_CAPS: readonly string[] = Object.freeze([CAP.receipt, CAP.receiptV2, CAP.cash]);

const PX_ACCEPTED_HW: readonly PxHw[] = Object.freeze(['ios_se'] as const);

interface PxRecord {
  pub: string;
  hw: PxHw;
  enrolledAt: number;
  via: 'auto' | 'pc';
}
interface PxPending {
  pub: string;
  hw: PxHw;
  askedAt: number;
}

interface PhoneRecord {
  pairId: string;
  deviceId: string;
  name: string;
  platform: 'ios' | 'android';
  pairedAt: number;
  Sm: string;
  Vm: string;
  mbxId: string;
  tok: string;
  mbxEpoch: number;
  ikTsMax: number;
  asyncSeqMax: number;
  qbundleSeq: number;
  qbundleValidTo: number;
  lastSeenAt: number | null;
  px?: PxRecord;
  pxPending?: PxPending;
  pxOff?: boolean;
}

interface MailboxTrash {
  mbxId: string;
  tok: string;
  deviceId: string;
  at: number;
}
const TRASH_KEEP_MS = 30 * 86_400_000;
const isTrash = (x: unknown): x is MailboxTrash => {
  const t = x as Partial<MailboxTrash> | null;
  return !!t && typeof t.mbxId === 'string' && typeof t.tok === 'string' && typeof t.deviceId === 'string' && typeof t.at === 'number';
};

interface FileShape {
  v: 1;
  phones: PhoneRecord[];
  trash?: MailboxTrash[];
}

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

const isPxKey = (k: { pub?: unknown; hw?: unknown } | undefined): boolean =>
  !!k && typeof k === 'object' && typeof k.pub === 'string' && k.pub.length === 88 && PX_HW.includes(k.hw as PxHw);
const cleanPx = (r: PhoneRecord): PhoneRecord => {
  const out = { ...r };
  const px = r.px as Partial<PxRecord> | undefined;
  if (!(isPxKey(px) && Number.isSafeInteger(px?.enrolledAt) && (px?.via === 'auto' || px?.via === 'pc'))) delete out.px;
  const pend = r.pxPending as Partial<PxPending> | undefined;
  if (!(isPxKey(pend) && Number.isSafeInteger(pend?.askedAt))) delete out.pxPending;
  if (r.pxOff !== true) delete out.pxOff;
  return out;
};

export class PhoneStore {
  #file: string;
  #chain: Promise<unknown> = Promise.resolve();
  #trash: MailboxTrash[] = [];
  trash(): MailboxTrash[] {
    return [...this.#trash];
  }
  setTrash(t: readonly MailboxTrash[]): void {
    this.#trash = [...t];
  }
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
      this.#trash = Array.isArray(j.trash) ? j.trash.filter(isTrash) : [];
      return j.phones.filter(isRec).map(cleanPx);
    } catch {
      return [];
    }
  }
  save(phones: readonly PhoneRecord[]): Promise<void> {
    const run = async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ v: FILE_VERSION, phones: [...phones], ...(this.#trash.length ? { trash: this.#trash } : {}) } satisfies FileShape), { mode: 0o600 });
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
  idle(): Promise<void> {
    return this.#chain.then(() => undefined);
  }
}

interface PhoneLinkKeys {
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
  deviceId: string;
  approver: 'on' | 'paused' | 'asked' | 'off';
}

export interface PhoneSessionHook {
  open(pairId: string, ch: Channel, peerCaps: readonly string[]): void | Promise<void>;
  handle(pairId: string, ch: Channel, env: Envelope): Promise<boolean>;
  close(pairId: string, ch: Channel): void;
}

export interface PhoneLinkOptions {
  store: PhoneStore;
  seal: TokenSeal;
  keys: () => Promise<PhoneLinkKeys>;
  joinMailbox?: (mbxId: Uint8Array, tok: MailboxTokens) => Promise<RelayLink>;
  queue: (mbxId: Uint8Array, tok: MailboxTokens) => Pick<RelayQueue, 'list' | 'listPage' | 'ack' | 'putBundle'>;
  receiver: (pairId: string) => PhoneReceiver;
  deleteMailbox?: (mbxId: Uint8Array, tokWrite: Uint8Array, peer?: string) => Promise<void>;
  deviceListVersion: () => number;
  appVersion: string;
  capabilities?: () => readonly string[];
  shareKeys?: (deviceId: string) => Promise<ShareKeyBody | null>;
  session?: PhoneSessionHook;
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
  kick: () => void;
  retry: (() => void) | null;
  shareSend: ((body: ShareKeyBody) => void) | null;
}

export const LIVE_BACKOFF = { minMs: 1000, maxMs: 30_000 } as const;

export class PhoneLink {
  #o: PhoneLinkOptions;
  #recs: PhoneRecord[] = [];
  #runs = new Map<string, Runner>();
  #now: () => number;
  #sleep: NonNullable<PhoneLinkOptions['sleep']>;
  #log: NonNullable<PhoneLinkOptions['log']>;
  #started = false;
  #loops = new Set<Promise<void>>();
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
    void this.#emptyTrash();
  }

  async #emptyTrash(): Promise<void> {
    const st = this.#o.store as Partial<Pick<PhoneStore, 'trash' | 'setTrash'>>;
    const list = st.trash?.() ?? [];
    if (!list.length || !this.#o.deleteMailbox) return;
    const keep: MailboxTrash[] = [];
    for (const t of list) {
      if (this.#now() - t.at > TRASH_KEEP_MS) continue;
      let write: Uint8Array;
      try {
        write = unpackTok(this.#o.seal.open(t.tok)).write;
      } catch {
        this.#log('main.phone_link', { step: 'mailbox_retry', result: 'unsealable' });
        continue;
      }
      try {
        await this.#o.deleteMailbox(fromB64(t.mbxId), write, t.deviceId);
        this.#log('main.phone_link', { step: 'mailbox_retry', result: 'ok' });
      } catch (e) {
        const code = codeOf(e);
        if (code === 'relay.mailbox_not_found') continue;
        this.#log('main.phone_link', { step: 'mailbox_retry', result: code });
        keep.push(t);
      }
    }
    st.setTrash?.(keep);
    await this.#o.store.save(this.#recs);
  }

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
    for (const old of replaced) {
      if (old.mbxId === rec.mbxId) continue;
      void (async () => {
        const t = unpackTok(this.#o.seal.open(old.tok));
        await this.#o.deleteMailbox?.(fromB64(old.mbxId), t.write);
      })().catch((e) => this.#log('main.phone_link', { step: 'replace_mailbox', result: codeOf(e) }));
    }
    if (this.#started) this.#run(rec);
    else await this.start();
    this.#o.onChange?.();
  }

  async remove(pairId: string): Promise<boolean> {
    const rec = this.#recs.find((x) => x.pairId === pairId);
    if (!rec) return false;
    this.#stopRun(pairId);
    let write: Uint8Array | null = null;
    try {
      write = unpackTok(this.#o.seal.open(rec.tok)).write;
    } catch {
      this.#log('main.phone_link', { step: 'remove_mailbox', result: 'unsealable' });
    }
    if (write) {
      try {
        await this.#o.deleteMailbox?.(fromB64(rec.mbxId), write, rec.deviceId);
      } catch (e) {
        const code = codeOf(e);
        this.#log('main.phone_link', { step: 'remove_mailbox', result: code });
        const st = this.#o.store as Partial<Pick<PhoneStore, 'trash' | 'setTrash'>>;
        if (code !== 'relay.mailbox_not_found') st.setTrash?.([...(st.trash?.() ?? []), { mbxId: rec.mbxId, tok: rec.tok, deviceId: rec.deviceId, at: this.#now() }]);
      }
    }
    this.#recs = this.#recs.filter((x) => x.pairId !== pairId);
    await this.#o.store.save(this.#recs);
    this.#log('main.phone_link', { step: 'removed' });
    this.#o.onChange?.();
    return true;
  }

  async removeDevice(deviceId: string): Promise<boolean> {
    const ids = this.#recs.filter((x) => x.deviceId === deviceId).map((x) => x.pairId);
    let any = false;
    for (const id of ids) any = (await this.remove(id)) || any;
    return any;
  }

  list(): PhoneView[] {
    return this.#recs.map((r) => ({ pairId: r.pairId, name: r.name, platform: r.platform, pairedAt: r.pairedAt, online: this.#runs.get(r.pairId)?.online ?? false, lastSeenAt: r.lastSeenAt, deviceId: r.deviceId, approver: this.#pxUsable(r) ? 'on' : r.pxOff ? (r.pxPending ? 'asked' : 'paused') : 'off' }));
  }

  #pxUsable(r: PhoneRecord): boolean {
    return !!r.px && PX_ACCEPTED_HW.includes(r.px.hw);
  }

  deviceOf(pairId: string): string | null {
    return this.#recs.find((x) => x.pairId === pairId)?.deviceId ?? null;
  }

  px(pairId: string): { pub: Uint8Array; hw: PxHw; deviceId: string } | null {
    const r = this.#recs.find((x) => x.pairId === pairId);
    if (!r?.px || !this.#pxUsable(r)) return null;
    try {
      return { pub: fromB64(r.px.pub), hw: r.px.hw, deviceId: r.deviceId };
    } catch {
      return null;
    }
  }

  async enrollPx(pairId: string, body: PxEnrollBody): Promise<PxAckBody> {
    const rec = this.#recs.find((x) => x.pairId === pairId);
    let pub: Uint8Array;
    let sig: Uint8Array;
    try {
      pub = fromB64(body.pxPub);
      sig = fromB64(body.sig);
    } catch {
      return { state: 'rejected', pxId: '0'.repeat(16) };
    }
    const pxId = pxIdOf(pub);
    const done = (state: PxAckBody['state']): PxAckBody => {
      this.#log('main.phone_px', { result: state });
      return { state, pxId };
    };
    if (!rec || !verifyPxEnroll(fromB64(rec.Vm), rec.pairId, rec.deviceId, pub, body.hw, sig)) return done('rejected');
    if (!PX_ACCEPTED_HW.includes(body.hw) || (body.hw === 'ios_se') !== (rec.platform === 'ios')) return done('rejected');
    const key = b64(pub);
    if (rec.px?.pub === key && rec.px.hw === body.hw) return done('enrolled');
    const now = this.#now();
    if (!rec.pxOff) {
      this.#log('main.phone_px', { result: rec.px ? 'replaced' : 'new' });
      const next = { ...rec, px: { pub: key, hw: body.hw, enrolledAt: now, via: 'auto' as const } };
      delete next.pxPending;
      await this.#replace(rec, next);
      this.#o.onChange?.();
      return done('enrolled');
    }
    if (rec.pxPending?.pub !== key || rec.pxPending.hw !== body.hw) {
      await this.#persist(rec, { pxPending: { pub: key, hw: body.hw, askedAt: now } });
      this.#o.onChange?.();
    }
    return done('needs_pc');
  }

  async allowPx(pairId: string): Promise<boolean> {
    const rec = this.#recs.find((x) => x.pairId === pairId);
    if (!rec?.pxOff) return false;
    const next = { ...rec };
    if (rec.pxPending && PX_ACCEPTED_HW.includes(rec.pxPending.hw)) next.px = { pub: rec.pxPending.pub, hw: rec.pxPending.hw, enrolledAt: this.#now(), via: 'pc' };
    delete next.pxPending;
    delete next.pxOff;
    await this.#replace(rec, next);
    this.#log('main.phone_px', { result: 'allowed' });
    this.#o.onChange?.();
    return true;
  }

  async revokePx(pairId: string): Promise<boolean> {
    const rec = this.#recs.find((x) => x.pairId === pairId);
    if (!rec || rec.pxOff) return false;
    const next: PhoneRecord = { ...rec, pxOff: true };
    delete next.px;
    delete next.pxPending;
    await this.#replace(rec, next);
    this.#log('main.phone_px', { result: 'revoked' });
    this.#o.onChange?.();
    return true;
  }

  #replace(rec: PhoneRecord, next: PhoneRecord): Promise<void> {
    for (const k of ['px', 'pxPending', 'pxOff'] as const) if (!(k in next)) delete rec[k];
    return this.#persist(rec, next);
  }

  stop(): void {
    for (const id of [...this.#runs.keys()]) this.#stopRun(id);
    this.#started = false;
  }

  async idle(): Promise<void> {
    while (this.#loops.size) await Promise.all([...this.#loops]);
    await this.#o.store.idle();
  }

  #track(p: Promise<void>): void {
    const done = p.catch(() => {}).finally(() => this.#loops.delete(done));
    this.#loops.add(done);
  }

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
    if (!this.#recs.includes(rec)) return Promise.resolve();
    return this.#o.store.save(this.#recs);
  }

  #run(rec: PhoneRecord): void {
    if (this.#runs.has(rec.pairId)) return;
    const abort = new AbortController();
    let wake: (() => void) | null = null;
    const run: Runner = { rec, abort, link: null, online: false, kick: () => wake?.(), retry: null, shareSend: null };
    this.#runs.set(rec.pairId, run);
    this.#track((async () => {
      while (!abort.signal.aborted) {
        try {
          await this.#ensureBundle(rec);
          await this.#drain(rec);
        } catch (e) {
          this.#log('main.phone_queue', { result: codeOf(e) });
        }
        if (abort.signal.aborted) break;
        const poll = this.#o.pollMs ?? { live: 5 * 60_000, idle: 30_000 };
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        abort.signal.addEventListener('abort', onAbort, { once: true });
        wake = () => ac.abort();
        await this.#sleep(run.link && !run.link.closed ? poll.live : poll.idle, ac.signal);
        wake = null;
        abort.signal.removeEventListener('abort', onAbort);
      }
    })());
    if (this.#o.joinMailbox) this.#track(this.#live(run));
  }

  wake(why: 'resume' | 'unlock' | 'online', reconnect = why === 'resume'): void {
    if (!this.#started) return;
    for (const run of this.#runs.values()) {
      if (reconnect) run.link?.close();
      run.retry?.();
      run.kick();
    }
    this.#log('main.phone_link', { step: 'wake', why, phones: this.#runs.size });
  }

  async #retryWait(run: Runner, ms: number): Promise<boolean> {
    if (run.abort.signal.aborted) return false;
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
      let gone: AbortController | null = null;
      link.onPeerGone?.(() => gone?.abort());
      this.#log('main.phone_live', { step: 'joined' });
      const keys = await this.#o.keys();
      const pair: PairRecord = { pairId: rec.pairId, phoneStatic: fromB64(rec.Sm), revoked: false, ikTsMax: rec.ikTsMax };
      const receiver = this.#receiver(rec.pairId);
      let nextHs: Uint8Array | undefined;
      while (!link.closed && !abort.signal.aborted) {
        let sess: Awaited<ReturnType<typeof acceptDesktopSession>>;
        const first = nextHs;
        nextHs = undefined;
        try {
          sess = await acceptDesktopSession(link, {
          first,
          noise: keys.noise,
          pair,
          hello: { appVersion: this.#o.appVersion, deviceListVersion: this.#o.deviceListVersion(), asyncSeqMax: rec.asyncSeqMax, capabilities: [...(this.#o.capabilities?.() ?? DESKTOP_CAPS), ...(this.#o.shareKeys ? [CAP.share] : [])] },
          persistTs: (_id, ts) => this.#persist(rec, { ikTsMax: ts }),
          });
        } catch (e) {
          this.#log('main.phone_live', { step: 'accept', result: codeOf(e) });
          link.close();
          break;
        }
        if (!sess) continue;
        const g = (gone = new AbortController());
        run.online = true;
        await this.#persist(rec, { lastSeenAt: this.#now() });
        this.#o.onChange?.();
        this.#log('main.phone_live', { step: 'session', listMismatch: sess.deviceListMismatch });
        run.kick();
        if (this.#o.shareKeys && sess.peerHello.capabilities.includes(CAP.share)) {
          const ch = sess.channel;
          run.shareSend = (body) => ch.send('share.key', body);
          await this.#giveShareKeys(run);
        }
        const hook = this.#o.session;
        try {
          await hook?.open(rec.pairId, sess.channel, sess.peerHello.capabilities);
        } catch (e) {
          this.#log('main.phone_live', { step: 'open', result: codeOf(e) });
        }
        try {
          while (!sess.channel.closed && !abort.signal.aborted) {
            const f = g.signal.aborted ? queuedFrame(link) : await nextFrame(link, 30_000, g.signal);
            if (!f && g.signal.aborted) {
              this.#log('main.phone_live', { step: 'peer_gone' });
              break;
            }
            if (!f) continue;
            if (parseFrame(f)?.kind === KIND.HS) {
              nextHs = f;
              this.#log('main.phone_live', { step: 'rehello' });
              break;
            }
            const env = sess.channel.accept(f);
            if (!env) continue;
            if (env.type === 'close') {
              this.#log('main.phone_live', { step: 'closed_by_phone' });
              break;
            }
            if (!(await hook?.handle(rec.pairId, sess.channel, env))) await receiver.queue.handle(sess.channel, env);
          }
        } catch (e) {
          this.#log('main.phone_live', { step: 'recv', result: codeOf(e) });
          sess.channel.close();
        } finally {
          gone = null;
          hook?.close(rec.pairId, sess.channel);
        }
        run.online = false;
        run.shareSend = null;
        this.#o.onChange?.();
      }
      run.link = null;
      if (!abort.signal.aborted) await this.#retryWait(run, backoff);
    }
  }

  async #giveShareKeys(run: Runner): Promise<boolean> {
    try {
      const body = await this.#o.shareKeys?.(run.rec.deviceId);
      const send = run.shareSend;
      if (!body || !send) {
        this.#log('main.phone_live', { step: 'share_key', result: body ? 'closed' : 'none' });
        return false;
      }
      send(body);
      this.#log('main.phone_live', { step: 'share_key', result: 'sent', epochs: body.shareKeys.length });
      return true;
    } catch (e) {
      this.#log('main.phone_live', { step: 'share_key', result: codeOf(e) });
      return false;
    }
  }

  async pushShareKeys(): Promise<number> {
    let n = 0;
    for (const run of this.#runs.values()) if (run.shareSend && (await this.#giveShareKeys(run))) n++;
    return n;
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
