import { randomUUID } from 'node:crypto';
import {
  PCLINK_STEP_MS, PcLinkApprover, b64, checkPcLinkGrant, parsePcLinkChallenge, parsePcLinkHello, pcLinkHello, pcLinkReveal,
  type AikSigner, type DesktopKeys, type DeviceListJson, type PcLinkApproveState, type PcLinkChallenge, type PcLinkGrantCheck, type PcLinkHello, type SignedCert,
} from '@sax/remote';
import type { DeviceManagerSession } from './remote-devices.ts';
import type { AccountClient, DeviceAuth, PcLinkVault } from './remote-ports.ts';

const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};
const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[a-z_]+\.[a-z_]+$/.test(c) ? c : 'account.failed';
};

const causeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  if (typeof c === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(c)) return c;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m ? m.slice(0, 40).replace(/[^A-Za-z0-9_.:-]/g, '_') : 'unknown';
};

const NO_RETRY: ReadonlySet<string> = new Set(['account.device_limit', 'account.link_mismatch']);

export const PCLINK_RESTART_MS = PCLINK_STEP_MS + 30_000;
const PCLINK_DONE_SHOW_MS = 10 * 60_000;

type PcLinkJoinStage = 'wait' | 'code' | 'confirm';

interface PcLinkJoinOptions {
  client: Pick<AccountClient, 'devicesBySession' | 'enrollDesktop' | 'pcLinkHello' | 'pcLinkAnswer' | 'pcLinkReveal' | 'pcLinkCancel'>;
  session: string;
  aikPub: string;
  keys: Pick<DesktopKeys, 'noise' | 'vd'>;
  vault: PcLinkVault;
  platform: 'windows' | 'macos';
  name: string;
  now?: () => number;
}

interface PcLinkJoined {
  deviceId: string;
  cert: SignedCert;
  deviceList: DeviceListJson;
  aikPub: Uint8Array;
}

export class PcLinkJoin {
  #o: PcLinkJoinOptions;
  #now: () => number;
  readonly deviceId: string;
  #hello!: PcLinkHello;
  #nonce!: Uint8Array;
  #stage: PcLinkJoinStage = 'wait';
  #challenge: PcLinkChallenge | null = null;
  #sas: string | null = null;
  #transcript: Uint8Array | null = null;
  #codeAt = 0;
  #grant: Extract<PcLinkGrantCheck, { ok: true }> | null = null;
  #busy = false;

  private constructor(o: PcLinkJoinOptions, deviceId: string) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.deviceId = deviceId;
  }

  static async start(o: PcLinkJoinOptions): Promise<PcLinkJoin> {
    const Sx = b64(o.keys.noise.publicKey);
    const Vx = b64(o.keys.vd.publicKey);
    const rows = await o.client.devicesBySession(o.session);
    let deviceId = rows.find((d) => d.role === 'desktop' && d.Sx === Sx && d.Vx === Vx && (d.state === 'pending' || d.state === 'active'))?.deviceId;
    if (!deviceId) {
      deviceId = randomUUID();
      await o.client.enrollDesktop(o.session, { deviceId, platform: o.platform, name: o.name.slice(0, 40), Sx, Vx });
    }
    const j = new PcLinkJoin(o, deviceId);
    await j.#sendHello();
    return j;
  }

  get stage(): PcLinkJoinStage {
    return this.#stage;
  }

  get code(): string | null {
    return this.#stage === 'wait' ? null : this.#sas;
  }

  async #sendHello(): Promise<void> {
    const linkPub = await this.#o.vault.key();
    const { hello, nonce } = pcLinkHello({ deviceId: this.deviceId, noisePub: this.#o.keys.noise.publicKey, signPub: this.#o.keys.vd.publicKey, linkPub });
    await this.#o.client.pcLinkHello(this.#o.session, this.deviceId, hello);
    this.#hello = hello;
    this.#nonce = nonce;
    this.#stage = 'wait';
    this.#challenge = null;
    this.#sas = null;
    this.#transcript = null;
    this.#grant = null;
  }

  async poll(): Promise<boolean> {
    if (this.#busy) return false;
    this.#busy = true;
    try {
      const before = this.#stage;
      const a = await this.#o.client.pcLinkAnswer(this.#o.session, this.deviceId);
      if (this.#stage === 'wait' && a.challenge !== null) {
        const c = parsePcLinkChallenge(a.challenge);
        if (!c || c.aik_pub !== this.#o.aikPub || c.device_id === this.deviceId) return fail('account.link_mismatch');
        const r = pcLinkReveal(this.#hello, c, this.#nonce);
        await this.#o.client.pcLinkReveal(this.#o.session, this.deviceId, r.reveal);
        this.#challenge = c;
        this.#sas = r.sas;
        this.#transcript = r.transcript;
        this.#codeAt = this.#now();
        this.#stage = 'code';
      } else if (this.#stage === 'code' && a.grant !== null) {
        const g = checkPcLinkGrant(this.#hello, this.#challenge!, this.#transcript!, a.grant, this.#now());
        if (!g.ok) return fail('account.link_mismatch');
        this.#grant = g;
        this.#stage = 'confirm';
      } else if (this.#stage === 'code' && this.#now() - this.#codeAt > PCLINK_RESTART_MS) {
        await this.#sendHello();
      }
      return this.#stage !== before;
    } finally {
      this.#busy = false;
    }
  }

  async accept(): Promise<PcLinkJoined> {
    const g = this.#grant;
    if (this.#stage !== 'confirm' || !g) return fail('account.link_state');
    try {
      await this.#o.vault.importRk({ enc: g.enc, ct: g.ct, info: g.info, aad: g.aad, aikPub: g.aikPub });
    } catch {
      return fail('account.link_mismatch');
    }
    await this.#o.client.pcLinkCancel(this.#o.session, this.deviceId).catch(() => {});
    return { deviceId: this.deviceId, cert: g.cert, deviceList: g.deviceList, aikPub: g.aikPub };
  }

  async cancel(): Promise<void> {
    await this.#o.client.pcLinkCancel(this.#o.session, this.deviceId).catch(() => {});
  }
}

export interface PcLinkRequestView {
  deviceId: string;
  name: string;
  platform: 'windows' | 'macos';
  createdAt: number;
  stage: 'new' | 'wait' | 'code' | 'done' | 'other';
  triesLeft: number | null;
}

const stateOf = (ap: PcLinkApprover): PcLinkApproveState => ap.state;

type Call = <R>(g: (auth: DeviceAuth) => Promise<R>) => Promise<R>;

interface PcLinkHostOptions {
  client: Pick<AccountClient, 'pcLinks' | 'pcLinkChallenge' | 'pcLinkGrant' | 'pcLinkDrop' | 'putDeviceList'>;
  exclusive: <T>(f: (s: DeviceManagerSession, call: Call, pull: () => Promise<void>) => Promise<T>) => Promise<T>;
  aik: () => Promise<AikSigner>;
  vault: () => Promise<PcLinkVault>;
  now?: () => number;
  log?: (name: string, data: Record<string, string | number>) => void;
}

interface Approving {
  ap: PcLinkApprover;
  startedAt: number;
}

export class PcLinkHost {
  #o: PcLinkHostOptions;
  #now: () => number;
  #log: NonNullable<PcLinkHostOptions['log']>;
  #aps = new Map<string, Approving>();
  #done = new Map<string, { view: PcLinkRequestView; at: number }>();

  constructor(o: PcLinkHostOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? (() => {});
  }

  list(): Promise<PcLinkRequestView[]> {
    return this.#o.exclusive((s, call) => this.#sync(s, call));
  }

  begin(deviceId: string): Promise<PcLinkRequestView[]> {
    return this.#o.exclusive(async (s, call) => {
      const r = (await call((a) => this.#o.client.pcLinks(a))).find((x) => x.deviceId === deviceId);
      if (!r || deviceId === s.deviceId) return fail('account.link_not_found');
      const hello = parsePcLinkHello(r.hello);
      if (!hello || hello.device_id !== deviceId) return fail('account.link_mismatch');
      if (r.challengedBy !== null) return fail('account.link_state');
      const aik = await this.#o.aik();
      const ap = new PcLinkApprover(hello, { deviceId: s.deviceId, aikPub: aik.publicKey }, this.#now);
      await call((a) => this.#o.client.pcLinkChallenge(a, deviceId, ap.challenge));
      this.#aps.set(deviceId, { ap, startedAt: this.#now() });
      this.#log('main.pclink_host', { result: 'challenged' });
      return this.#sync(s, call);
    });
  }

  confirm(deviceId: string, code: string): Promise<{ ok: boolean; requests: PcLinkRequestView[] }> {
    return this.#o.exclusive(async (s, call, pull) => {
      await this.#sync(s, call);
      const p = this.#aps.get(deviceId);
      if (!p || (p.ap.state !== 'awaiting_sas' && p.ap.state !== 'approved')) return fail('account.link_state');
      if (!p.ap.confirm(code)) {
        if (stateOf(p.ap) === 'failed') {
          this.#aps.delete(deviceId);
          if (p.ap.triesLeft <= 0) await call((a) => this.#o.client.pcLinkDrop(a, deviceId)).catch(() => {});
          this.#log('main.pclink_host', { result: p.ap.triesLeft <= 0 ? 'code_tries' : 'code_expired' });
        }
        return { ok: false, requests: await this.#sync(s, call) };
      }
      const row = (await call((a) => this.#o.client.pcLinks(a))).find((x) => x.deviceId === deviceId);
      let step: 'list' | 'seal' | 'send' = 'list';
      try {
        const aik = await this.#o.aik();
        const h = p.ap.hello;
        await pull();
        let list = s.deviceList;
        if (!list.entries.some((e) => e.entry.device_id === h.device_id && e.entry.role === 'desktop' && e.entry.Sx === h.Sx && e.entry.Vx === h.Vx)) {
          list = await p.ap.listWithNew(aik, s.deviceList, this.#now()).catch((e: unknown) => fail(/too many/.test(String((e as Error)?.message)) ? 'account.device_limit' : 'account.link_mismatch'));
          await call((a) => this.#o.client.putDeviceList(a, list));
          await s.setDeviceList(list);
        }
        step = 'seal';
        const vault = await this.#o.vault();
        const grant = await p.ap.grant({ aik, deviceList: list, sealRk: (r, i, a) => vault.sealRk(r, i, a), now: this.#now() });
        step = 'send';
        await call((a) => this.#o.client.pcLinkGrant(a, deviceId, grant));
      } catch (e) {
        if (NO_RETRY.has(codeOf(e))) this.#aps.delete(deviceId);
        this.#log('main.pclink_host', { result: codeOf(e), step, cause: causeOf(e) });
        throw Object.assign(new Error(codeOf(e)), { code: codeOf(e) });
      }
      this.#aps.delete(deviceId);
      this.#done.set(deviceId, { view: { deviceId, name: row?.name ?? '', platform: row?.platform ?? 'windows', createdAt: row?.createdAt ?? this.#now(), stage: 'done', triesLeft: null }, at: this.#now() });
      this.#log('main.pclink_host', { result: 'ok' });
      return { ok: true, requests: await this.#sync(s, call) };
    });
  }

  reject(deviceId: string): Promise<PcLinkRequestView[]> {
    return this.#o.exclusive(async (s, call) => {
      if (deviceId === s.deviceId) return fail('account.link_not_found');
      this.#aps.delete(deviceId);
      await call((a) => this.#o.client.pcLinkDrop(a, deviceId));
      this.#log('main.pclink_host', { result: 'rejected' });
      return this.#sync(s, call);
    });
  }

  async #sync(s: DeviceManagerSession, call: Call): Promise<PcLinkRequestView[]> {
    const now = this.#now();
    const rows = await call((a) => this.#o.client.pcLinks(a));
    const out: PcLinkRequestView[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const hello = parsePcLinkHello(r.hello);
      if (!hello || hello.device_id !== r.deviceId || r.deviceId === s.deviceId) continue;
      seen.add(r.deviceId);
      const base = { deviceId: r.deviceId, name: r.name, platform: r.platform, createdAt: r.createdAt };
      let p = this.#aps.get(r.deviceId);
      if (p && (p.ap.hello.commit !== hello.commit || r.challengedBy !== s.deviceId || p.ap.state === 'failed' || now - p.startedAt > PCLINK_STEP_MS)) {
        this.#aps.delete(r.deviceId);
        p = undefined;
      }
      if (!p) {
        if (r.challengedBy === null) out.push({ ...base, stage: 'new', triesLeft: null });
        else if (r.challengedBy !== s.deviceId) out.push({ ...base, stage: 'other', triesLeft: null });
        continue;
      }
      if (p.ap.state === 'awaiting_reveal' && r.reveal !== null && !p.ap.reveal(r.reveal)) {
        this.#aps.delete(r.deviceId);
        await call((a) => this.#o.client.pcLinkDrop(a, r.deviceId)).catch(() => {});
        this.#log('main.pclink_host', { result: 'commit_mismatch' });
        continue;
      }
      const code = p.ap.state === 'awaiting_sas' || p.ap.state === 'approved';
      out.push({ ...base, stage: code ? 'code' : 'wait', triesLeft: code ? p.ap.triesLeft : null });
    }
    for (const id of [...this.#aps.keys()]) if (!seen.has(id)) this.#aps.delete(id);
    for (const [id, d] of [...this.#done]) {
      if (now - d.at > PCLINK_DONE_SHOW_MS) this.#done.delete(id);
      else out.push(d.view);
    }
    return out;
  }
}
