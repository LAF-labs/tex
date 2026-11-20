import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  addDevice,
  b64,
  certNotAfter,
  CTX,
  DeviceTokenCache,
  deviceAuthHeaders,
  escrowClaimAad,
  escrowStoreAad,
  fromB64,
  initialDeviceList,
  isEmailShape,
  issueCert,
  jcsBytes,
  rekeyedDeviceList,
  utf8,
  verifyAcctClaim,
  verifyCert,
  verifyDeviceList,
  type DesktopKeys,
  type DeviceListJson,
  type SignedCert,
} from '@sax/remote';
import { PcLinkJoin } from './remote-pclink.ts';
import type { AccountClient, DeviceAuth, PcLinkVault, ServerDevice } from './remote-ports.ts';

export const GATEWAY_SCOPES: readonly string[] = Object.freeze(['gateway']);

export const CERT_RENEW_MS = 14 * 86_400_000;
const FILE_VERSION = 1;

export interface RemoteIdentity {
  v: 1;
  accountEmail: string;
  deviceId: string;
  aikPub: string;
  Sd: string;
  Vd: string;
  cert: SignedCert;
  deviceList: DeviceListJson;
  enrolledAt: number;
}

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const key32 = (s: unknown) => {
  try {
    return typeof s === 'string' && fromB64(s).length === 32;
  } catch {
    return false;
  }
};

export function checkIdentity(v: unknown, now = Date.now()): RemoteIdentity | null {
  const i = v as Partial<RemoteIdentity> | null;
  if (!i || typeof i !== 'object' || i.v !== FILE_VERSION) return null;
  if (typeof i.accountEmail !== 'string' || !isEmailShape(i.accountEmail) || typeof i.deviceId !== 'string' || !UUID4.test(i.deviceId)) return null;
  if (!key32(i.aikPub) || !key32(i.Sd) || !key32(i.Vd) || !Number.isSafeInteger(i.enrolledAt) || !i.cert || !i.deviceList) return null;
  const aik = fromB64(i.aikPub!);
  const c = verifyCert(i.cert, aik, Math.min(now, i.cert.cert?.not_after - 1));
  if (!c || c.device_id !== i.deviceId || c.role !== 'desktop' || b64(c.Sx) !== i.Sd || b64(c.Vx) !== i.Vd) return null;
  const l = verifyDeviceList(i.deviceList, aik);
  if (!l.ok || !l.devices.some((d) => d.deviceId === i.deviceId && d.role === 'desktop')) return null;
  return i as RemoteIdentity;
}

export class RemoteIdentityFile {
  readonly file: string;
  constructor(dir: string) {
    this.file = path.join(dir, 'remote-identity.json');
  }
  async load(now = Date.now()): Promise<RemoteIdentity | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      return null;
    }
    try {
      return checkIdentity(JSON.parse(raw), now);
    } catch {
      return null;
    }
  }
  async save(i: RemoteIdentity): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(i), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

interface PendingCode {
  email: string;
  loginId: string;
  expiresAt: number;
  signup: boolean;
}

export class PendingCodeFile {
  readonly file: string;
  constructor(dir: string) {
    this.file = path.join(dir, 'remote-pending-code.json');
  }
  async load(now = Date.now()): Promise<PendingCode | null> {
    let v: unknown;
    try {
      v = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      return null;
    }
    const o = v as Record<string, unknown> | null;
    const ok =
      !!o &&
      typeof o === 'object' &&
      typeof o.email === 'string' &&
      isEmailShape(o.email) &&
      typeof o.loginId === 'string' &&
      o.loginId.length > 0 &&
      o.loginId.length <= 200 &&
      typeof o.expiresAt === 'number' &&
      Number.isFinite(o.expiresAt) &&
      typeof o.signup === 'boolean';
    if (!ok || (o.expiresAt as number) <= now || (o.expiresAt as number) > now + 60 * 60 * 1000) {
      await this.clear().catch(() => {});
      return null;
    }
    return { email: o.email as string, loginId: o.loginId as string, expiresAt: o.expiresAt as number, signup: o.signup as boolean };
  }
  async save(p: PendingCode): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(p), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

export interface AccountView {
  step: 'unavailable' | 'signed_out' | 'code_sent' | 'reset_code' | 'working' | 'set_password' | 'signed_in' | 'link_wait' | 'link_code' | 'link_confirm';
  email: string | null;
  codeExpiresAt: number | null;
  error: string | null;
  phones: number;
  pairable?: false;
  linkCode?: string;
}

interface DesktopAccountOptions {
  client: AccountClient | null;
  keys: () => Promise<DesktopKeys>;
  identity: RemoteIdentityFile;
  pending?: PendingCodeFile;
  platform: 'windows' | 'macos';
  deviceName: string;
  model?: () => Promise<string | undefined>;
  pairing?: boolean;
  linkVault?: () => Promise<PcLinkVault>;
  resetKeys?: () => void;
  onRekey?: () => void;
  now?: () => number;
  log?: (name: string, data: Record<string, string | number>) => void;
}

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[a-z_]+\.[a-z_]+$/.test(c) ? c : 'account.failed';
};

export class DesktopAccount {
  #o: DesktopAccountOptions;
  #now: () => number;
  #log: NonNullable<DesktopAccountOptions['log']>;
  #id: RemoteIdentity | null = null;
  #pendingCode: PendingCode | null = null;
  #pendingWrite: Promise<void> = Promise.resolve();
  get #pending(): PendingCode | null {
    return this.#pendingCode;
  }
  set #pending(p: PendingCode | null) {
    this.#pendingCode = p;
    const f = this.#o.pending;
    if (f) this.#pendingWrite = this.#pendingWrite.then(() => (p ? f.save(p) : f.clear())).catch(() => {});
  }
  #reset: { email: string; resetId: string; expiresAt: number } | null = null;
  #offer: { session: string; email: string } | null = null;
  #lastEmail: string | null = null;
  #working = false;
  #error: string | null = null;
  #device: DeviceSession | null = null;
  #link: { join: PcLinkJoin; session: string; email: string } | null = null;

  constructor(o: DesktopAccountOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? (() => {});
  }

  async init(): Promise<AccountView> {
    const id = await this.#o.identity.load(this.#now());
    if (id) {
      try {
        const k = await this.#o.keys();
        if (b64(k.aik.publicKey) === id.aikPub && b64(k.noise.publicKey) === id.Sd && b64(k.vd.publicKey) === id.Vd) this.#id = id;
        else this.#log('main.account_identity', { result: 'key_mismatch' });
      } catch (e) {
        this.#log('main.account_identity', { result: codeOf(e) });
      }
    }
    const f = this.#o.pending;
    if (f) {
      const p = await f.load(this.#now());
      if (p && !this.#id) {
        this.#pendingCode = p;
        this.#log('main.account_code', { result: 'resumed' });
      } else if (p) this.#pending = null;
    }
    return this.view();
  }

  view(): AccountView {
    if (!this.#o.client) return { step: 'unavailable', email: null, codeExpiresAt: null, error: null, phones: 0 };
    if (this.#offer) return { step: 'set_password', email: this.#offer.email, codeExpiresAt: null, error: this.#error, phones: 0 };
    if (this.#link) {
      const code = this.#link.join.code;
      return { step: `link_${this.#link.join.stage}`, email: this.#link.email, codeExpiresAt: null, error: null, phones: 0, ...(code ? { linkCode: code } : {}) };
    }
    if (this.#id) return { step: 'signed_in', email: this.#id.accountEmail, codeExpiresAt: null, error: this.#error === 'account.password_later' ? this.#error : null, phones: this.#id.deviceList.entries.filter((e) => e.entry.role === 'mobile').length, ...(this.#o.pairing === false ? { pairable: false as const } : {}) };
    if (this.#working) return { step: 'working', email: this.#pending?.email ?? null, codeExpiresAt: null, error: null, phones: 0 };
    if (this.#reset) {
      if (this.#reset.expiresAt > this.#now()) return { step: 'reset_code', email: this.#reset.email, codeExpiresAt: this.#reset.expiresAt, error: this.#error, phones: 0 };
      return { step: 'signed_out', email: this.#reset.email, codeExpiresAt: null, error: 'account.code_expired', phones: 0 };
    }
    if (this.#pending && this.#pending.expiresAt > this.#now()) return { step: 'code_sent', email: this.#pending.email, codeExpiresAt: this.#pending.expiresAt, error: this.#error, phones: 0 };
    return { step: 'signed_out', email: this.#pending?.email ?? this.#lastEmail, codeExpiresAt: null, error: this.#pending ? (this.#error ?? 'account.code_expired') : this.#error, phones: 0 };
  }

  get identity(): RemoteIdentity | null {
    return this.#id;
  }

  async sendCode(emailRaw: string, signup = false): Promise<AccountView> {
    const client = this.#need();
    const email = emailRaw.trim();
    this.#error = null;
    if (!isEmailShape(email)) {
      this.#error = 'account.email_shape';
      return this.view();
    }
    await this.#run(async () => {
      const r = await client.startEmailCode(email);
      this.#pending = { email, loginId: r.loginId, expiresAt: this.#now() + r.expiresInSec * 1000, signup };
      this.#log('main.account_code', { result: 'sent' });
    }, 'main.account_code');
    return this.view();
  }

  async verify(code: string): Promise<AccountView> {
    const client = this.#need();
    const p = this.#pending;
    this.#error = null;
    if (!p || p.expiresAt <= this.#now()) {
      this.#error = 'account.code_expired';
      return this.view();
    }
    if (!/^\d{6}$/.test(code)) {
      this.#error = 'account.code_shape';
      return this.view();
    }
    await this.#run(async () => {
      const { session } = await client.verifyEmailCode(p.loginId, code);
      this.#pending = null;
      this.#lastEmail = p.email;
      let keep = false;
      try {
        const id = await this.#enroll(client, session, p.email);
        if (id) {
          this.#id = id;
          this.#log('main.account_enroll', { result: 'ok' });
          if (p.signup) keep = (await client.me(session).then((m) => m.hasPassword === false).catch(() => false));
          if (keep) this.#offer = { session, email: p.email };
        }
      } finally {
        if (!keep && this.#link?.session !== session) await client.logout(session).catch(() => {});
      }
    }, 'main.account_enroll');
    return this.view();
  }

  async passwordLogin(emailRaw: string, password: string): Promise<AccountView> {
    const client = this.#need();
    const email = emailRaw.trim();
    this.#error = null;
    if (!isEmailShape(email)) {
      this.#error = 'account.email_shape';
      return this.view();
    }
    if (!password) {
      this.#error = 'account.password_empty';
      return this.view();
    }
    this.#pending = null;
    this.#lastEmail = email;
    await this.#run(async () => {
      const { session } = await client.passwordLogin(email, password);
      try {
        const id = await this.#enroll(client, session, email);
        if (id) {
          this.#id = id;
          this.#log('main.account_enroll', { result: 'ok' });
        }
      } finally {
        if (this.#link?.session !== session) await client.logout(session).catch(() => {});
      }
    }, 'main.account_password');
    return this.view();
  }

  async setPassword(password: string): Promise<AccountView> {
    const client = this.#o.client;
    const o = this.#offer;
    if (!client || !o) throw new Error('account_no_offer');
    if (this.#working) throw new Error('busy');
    this.#error = null;
    if (!password) {
      this.#error = 'account.password_empty';
      return this.view();
    }
    this.#working = true;
    try {
      await client.setPassword(o.session, password);
      this.#log('main.account_password_set', { result: 'ok' });
      await this.#endOffer();
    } catch (e) {
      const code = codeOf(e);
      this.#log('main.account_password_set', { result: code });
      if (code === 'account.reauth_required' || code === 'account.unauthorized' || code === 'request.not_found') {
        await this.#endOffer();
        this.#error = 'account.password_later';
      } else this.#error = code;
    } finally {
      this.#working = false;
    }
    return this.view();
  }

  async skipPassword(): Promise<AccountView> {
    if (this.#working) throw new Error('busy');
    if (this.#offer) {
      this.#log('main.account_password_set', { result: 'later' });
      await this.#endOffer();
    }
    this.#error = null;
    return this.view();
  }

  async #endOffer(): Promise<void> {
    const o = this.#offer;
    this.#offer = null;
    if (o) await this.#o.client?.logout(o.session).catch(() => {});
  }

  async startReset(emailRaw: string): Promise<AccountView> {
    const client = this.#need();
    const email = emailRaw.trim();
    this.#error = null;
    if (!isEmailShape(email)) {
      this.#error = 'account.email_shape';
      return this.view();
    }
    this.#pending = null;
    this.#lastEmail = email;
    await this.#run(async () => {
      const r = await client.startPasswordReset(email);
      this.#reset = { email, resetId: r.resetId, expiresAt: this.#now() + r.expiresInSec * 1000 };
      this.#log('main.account_reset', { result: 'sent' });
    }, 'main.account_reset');
    return this.view();
  }

  async finishReset(code: string, password: string): Promise<AccountView> {
    const client = this.#need();
    const r = this.#reset;
    this.#error = null;
    if (!r || r.expiresAt <= this.#now()) {
      this.#error = 'account.code_expired';
      return this.view();
    }
    if (!/^\d{6}$/.test(code)) {
      this.#error = 'account.code_shape';
      return this.view();
    }
    if (!password) {
      this.#error = 'account.password_empty';
      return this.view();
    }
    await this.#run(async () => {
      const { session } = await client.verifyPasswordReset(r.resetId, code, password);
      this.#reset = null;
      this.#log('main.account_reset', { result: 'ok' });
      try {
        const id = await this.#enroll(client, session, r.email);
        if (id) {
          this.#id = id;
          this.#log('main.account_enroll', { result: 'ok' });
        }
      } finally {
        if (this.#link?.session !== session) await client.logout(session).catch(() => {});
      }
    }, 'main.account_reset');
    return this.view();
  }

  back(): AccountView {
    this.#lastEmail = this.#pending?.email ?? this.#reset?.email ?? this.#lastEmail;
    this.#pending = null;
    this.#reset = null;
    this.#error = null;
    return this.view();
  }

  async signOut(): Promise<AccountView> {
    if (this.#working) throw new Error('busy');
    const email = this.#id?.accountEmail ?? this.#offer?.email ?? null;
    const offer = this.#offer;
    if (this.#link) await this.#endLink(null, true);
    this.#device?.clearToken();
    this.#device?.clearGatewayToken();
    this.#device = null;
    this.#id = null;
    this.#offer = null;
    this.#reset = null;
    this.#error = null;
    this.#pending = null;
    if (email) this.#lastEmail = email;
    if (offer) await this.#o.client?.logout(offer.session).catch(() => {});
    await this.#pendingWrite;
    await this.#o.identity.clear();
    this.#log('main.account_signout', { result: 'ok' });
    return this.view();
  }

  async linkPoll(): Promise<boolean> {
    const l = this.#link;
    if (!l || this.#working) return false;
    try {
      return await l.join.poll();
    } catch (e) {
      const code = codeOf(e);
      if (code.startsWith('net.') || code === 'policy.rate_limited' || this.#link !== l) return false;
      const shown = code === 'account.link_not_found' ? 'account.link_rejected' : code === 'account.unauthorized' ? 'account.link_expired' : code;
      await this.#endLink(shown, code === 'account.link_mismatch');
      return true;
    }
  }

  async linkAccept(): Promise<AccountView> {
    const l = this.#link;
    if (!l || l.join.stage !== 'confirm') throw new Error('account_no_link');
    if (this.#working) throw new Error('busy');
    this.#working = true;
    this.#error = null;
    try {
      const j = await l.join.accept();
      this.#o.resetKeys?.();
      const k = await this.#o.keys();
      const id: RemoteIdentity = { v: 1, accountEmail: l.email, deviceId: j.deviceId, aikPub: b64(j.aikPub), Sd: b64(k.noise.publicKey), Vd: b64(k.vd.publicKey), cert: j.cert, deviceList: j.deviceList, enrolledAt: this.#now() };
      if (b64(k.aik.publicKey) !== id.aikPub || !checkIdentity(id, this.#now())) throw Object.assign(new Error('link'), { code: 'account.link_mismatch' });
      await this.#o.identity.save(id);
      this.#link = null;
      this.#id = id;
      this.#lastEmail = l.email;
      await this.#o.client?.logout(l.session).catch(() => {});
      this.#log('main.account_link', { result: 'ok' });
    } catch (e) {
      if (this.#link === l) await this.#endLink(codeOf(e), true);
    } finally {
      this.#working = false;
    }
    return this.view();
  }

  async linkCancel(): Promise<AccountView> {
    if (this.#working) throw new Error('busy');
    if (this.#link) await this.#endLink(null, true);
    return this.view();
  }

  async #endLink(error: string | null, cancel: boolean): Promise<void> {
    const l = this.#link;
    this.#link = null;
    this.#error = error;
    if (!l) return;
    this.#lastEmail = l.email;
    if (cancel) await l.join.cancel();
    await this.#o.client?.logout(l.session).catch(() => {});
    this.#log('main.account_link', { result: error ?? 'cancelled' });
  }

  device(): DeviceSession | null {
    if (!this.#id || !this.#o.client) return null;
    if (!this.#device) this.#device = new DeviceSession(this.#o.client, this.#o.keys, this.#o.identity, this.#id, this.#now, (id) => (this.#id = id), this.#o.model);
    return this.#device;
  }

  #need(): AccountClient {
    if (!this.#o.client) throw new Error('account_unavailable');
    if (this.#id) throw new Error('account_signed_in');
    if (this.#link) throw new Error('account_linking');
    if (this.#working) throw new Error('busy');
    return this.#o.client;
  }

  async #run(f: () => Promise<void>, logName: string): Promise<void> {
    this.#working = true;
    try {
      await f();
    } catch (e) {
      this.#error = codeOf(e);
      this.#log(logName, { result: this.#error });
    } finally {
      this.#working = false;
    }
  }

  async #joinByEscrow(client: AccountClient, session: string, email: string, cur: { aikPub: string; deviceList: DeviceListJson | null }): Promise<RemoteIdentity | null> {
    const vault = await this.#o.linkVault!();
    let k = await this.#o.keys();
    const Sd = b64(k.noise.publicKey);
    const Vd = b64(k.vd.publicKey);
    const now = this.#now();
    const aik = fromB64(cur.aikPub);
    let step: 'enroll' | 'claim' | 'reset' | 'import' | 'list' = 'enroll';
    try {
      const rows = await client.devicesBySession(session);
      let deviceId = rows.find((d) => d.role === 'desktop' && d.Sx === Sd && d.Vx === Vd && (d.state === 'pending' || d.state === 'active'))?.deviceId;
      if (!deviceId) {
        deviceId = randomUUID();
        await client.enrollDesktop(session, { deviceId, platform: this.#o.platform, name: this.#o.deviceName.slice(0, 40), Sx: Sd, Vx: Vd });
      }
      if (b64(k.aik.publicKey) !== cur.aikPub) {
        step = 'claim';
        const linkPub = await vault.key();
        let g: { aikPub: string; enc: string; ct: string };
        try {
          g = await client.claimKeyEscrow(session, { deviceId, Hx: b64(linkPub) });
        } catch (e) {
          const code = codeOf(e);
          if (code !== 'account.escrow_missing' && code !== 'request.not_found') throw e;
          this.#log('main.account_escrow', { result: code });
          if (code === 'request.not_found') return null;
          step = 'reset';
          const id = await this.#resetKey(client, session, email, deviceId, rows, k, cur.deviceList);
          this.#log('main.account_escrow', { result: 'reset' });
          return id;
        }
        if (g.aikPub !== cur.aikPub) throw Object.assign(new Error('escrow'), { code: 'account.bad_response' });
        step = 'import';
        await vault.importRk({ enc: fromB64(g.enc), ct: fromB64(g.ct), info: utf8(CTX.rkEscrow), aad: escrowClaimAad(aik, deviceId, linkPub), aikPub: aik }).catch(() => {
          throw Object.assign(new Error('escrow'), { code: 'account.link_mismatch' });
        });
        this.#o.resetKeys?.();
        k = await this.#o.keys();
        if (b64(k.aik.publicKey) !== cur.aikPub) throw Object.assign(new Error('escrow'), { code: 'account.link_mismatch' });
        this.#o.onRekey?.();
      }
      step = 'list';
      if (!cur.deviceList || !verifyDeviceList(cur.deviceList, k.aik.publicKey).ok) throw Object.assign(new Error('escrow'), { code: 'account.bad_response' });
      let list = cur.deviceList;
      if (!list.entries.some((e) => e.entry.device_id === deviceId && e.entry.role === 'desktop' && e.entry.Sx === Sd && e.entry.Vx === Vd)) {
        list = await addDevice(k.aik, cur.deviceList, { deviceId, role: 'desktop', noisePub: k.noise.publicKey, signPub: k.vd.publicKey, registeredAt: now }).catch((e: unknown) => {
          throw Object.assign(new Error('escrow'), { code: /too many/.test(String((e as Error)?.message)) ? 'account.device_limit' : 'account.bad_response' });
        });
        await client.joinByKeyEscrow(session, deviceId, list);
      }
      const cert = await issueCert(k.aik, { device_id: deviceId, role: 'desktop', Sx: k.noise.publicKey, Vx: k.vd.publicKey, not_after: certNotAfter(now) });
      const id: RemoteIdentity = { v: 1, accountEmail: email, deviceId, aikPub: cur.aikPub, Sd, Vd, cert, deviceList: list, enrolledAt: now };
      await this.#o.identity.save(id);
      this.#log('main.account_escrow', { result: 'joined' });
      return id;
    } catch (e) {
      this.#log('main.account_escrow', { result: codeOf(e), step });
      throw e;
    }
  }

  async #resetKey(client: AccountClient, session: string, email: string, deviceId: string, rows: ServerDevice[], k: DesktopKeys, old: DeviceListJson | null): Promise<RemoteIdentity> {
    if (!old) throw Object.assign(new Error('escrow'), { code: 'account.bad_response' });
    const now = this.#now();
    const vault = await this.#o.linkVault!();
    const { pub } = await client.keyEscrowPub(session);
    const sealed = await vault.sealRk(fromB64(pub), utf8(CTX.rkEscrow), escrowStoreAad(k.aik.publicKey));
    const since = new Map(old.entries.map((e) => [e.entry.device_id, e.entry.registered_at]));
    const others = rows
      .filter((d) => d.role === 'desktop' && d.deviceId !== deviceId && (d.state === 'active' || d.state === 'suspended'))
      .map((d) => ({ deviceId: d.deviceId, role: 'desktop' as const, noisePub: fromB64(d.Sx), signPub: fromB64(d.Vx), registeredAt: since.get(d.deviceId) ?? d.registeredAt }));
    const list = await rekeyedDeviceList(k.aik, old.listVersion + 1, [...others, { deviceId, role: 'desktop', noisePub: k.noise.publicKey, signPub: k.vd.publicKey, registeredAt: now }]).catch(() => {
      throw Object.assign(new Error('escrow'), { code: 'account.device_limit' });
    });
    await client.resetByKeyEscrow(session, { deviceId, aikPub: b64(k.aik.publicKey), deviceList: list, enc: b64(sealed.enc), ct: b64(sealed.ct) });
    const cert = await issueCert(k.aik, { device_id: deviceId, role: 'desktop', Sx: k.noise.publicKey, Vx: k.vd.publicKey, not_after: certNotAfter(now) });
    const id: RemoteIdentity = { v: 1, accountEmail: email, deviceId, aikPub: b64(k.aik.publicKey), Sd: b64(k.noise.publicKey), Vd: b64(k.vd.publicKey), cert, deviceList: list, enrolledAt: now };
    await this.#o.identity.save(id);
    return id;
  }

  async depositKey(): Promise<string> {
    const client = this.#o.client;
    const dev = this.device();
    if (!client || !dev || !this.#o.linkVault) return 'skipped';
    let result: string;
    try {
      const st = await client.keyEscrowState(dev.auth);
      if (st.stored) result = 'already';
      else {
        const vault = await this.#o.linkVault();
        const sealed = await vault.sealRk(fromB64(st.pub), utf8(CTX.rkEscrow), escrowStoreAad(fromB64(dev.aikPub)));
        await client.putKeyEscrow(dev.auth, { enc: b64(sealed.enc), ct: b64(sealed.ct) });
        result = 'stored';
      }
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      const msg = (e as { message?: unknown } | null)?.message;
      result = typeof code === 'string' && /^[a-z_]+\.[a-z_]+$/.test(code) ? code : typeof msg === 'string' && /^[a-z_]{1,40}$/.test(msg) ? `vault.${msg}` : 'account.failed';
    }
    this.#log('main.account_escrow', { result });
    if (result === 'account.cert_invalid' && this.#id && !this.#working && !this.#link) {
      const email = this.#id.accountEmail;
      this.#device?.clearToken();
      this.#device?.clearGatewayToken();
      this.#device = null;
      this.#id = null;
      this.#lastEmail = email;
      this.#error = 'account.key_changed';
      await this.#pendingWrite;
      await this.#o.identity.clear();
      this.#log('main.account_signout', { result: 'key_changed' });
    }
    return result;
  }

  async #sealForPin(client: AccountClient, session: string, k: DesktopKeys): Promise<{ enc: string; ct: string } | null> {
    if (!this.#o.linkVault) return null;
    const { pub } = await client.keyEscrowPub(session);
    const sealed = await (await this.#o.linkVault()).sealRk(fromB64(pub), utf8(CTX.rkEscrow), escrowStoreAad(k.aik.publicKey));
    return { enc: b64(sealed.enc), ct: b64(sealed.ct) };
  }

  async #enroll(client: AccountClient, session: string, email: string): Promise<RemoteIdentity | null> {
    const k = await this.#o.keys();
    const now = this.#now();
    const aikPub = b64(k.aik.publicKey);
    const Sd = b64(k.noise.publicKey);
    const Vd = b64(k.vd.publicKey);
    const cur = await client.deviceList(session);
    let deviceId: string;
    let list: DeviceListJson;
    if (cur.aikPub) {
      const mine = cur.aikPub === aikPub && cur.deviceList && verifyDeviceList(cur.deviceList, k.aik.publicKey).ok ? cur.deviceList.entries.find((e) => e.entry.role === 'desktop' && e.entry.Sx === Sd && e.entry.Vx === Vd) : undefined;
      if (!mine || !cur.deviceList) {
        if (!this.#o.linkVault) throw Object.assign(new Error('pinned'), { code: 'account.aik_already_pinned' });
        const joined = await this.#joinByEscrow(client, session, email, { aikPub: cur.aikPub, deviceList: cur.deviceList });
        if (joined) return joined;
        const join = await PcLinkJoin.start({ client, session, aikPub: cur.aikPub, keys: k, vault: await this.#o.linkVault(), platform: this.#o.platform, name: this.#o.deviceName, now: this.#now });
        this.#link = { join, session, email };
        this.#log('main.account_link', { result: 'started' });
        return null;
      }
      deviceId = mine.entry.device_id;
      list = cur.deviceList;
    } else {
      deviceId = randomUUID();
      list = await initialDeviceList(k.aik, { deviceId, role: 'desktop', noisePub: k.noise.publicKey, signPub: k.vd.publicKey, registeredAt: now });
      const escrow = await this.#sealForPin(client, session, k).catch(() => null);
      const r = await client.pinFirstDesktop(session, { aikPub, deviceList: list, platform: this.#o.platform, name: this.#o.deviceName.slice(0, 40), ...(escrow ? { escrow } : {}) });
      if (r.deviceId !== deviceId) throw Object.assign(new Error('device'), { code: 'account.bad_response' });
    }
    const cert = await issueCert(k.aik, { device_id: deviceId, role: 'desktop', Sx: k.noise.publicKey, Vx: k.vd.publicKey, not_after: certNotAfter(now) });
    const id: RemoteIdentity = { v: 1, accountEmail: email, deviceId, aikPub, Sd, Vd, cert, deviceList: list, enrolledAt: now };
    await this.#o.identity.save(id);
    return id;
  }
}

export class DeviceSession {
  #client: AccountClient;
  #keys: () => Promise<DesktopKeys>;
  #file: RemoteIdentityFile;
  #id: RemoteIdentity;
  #now: () => number;
  #cache: DeviceTokenCache;
  #gwCache: DeviceTokenCache;
  #gwInflight: Promise<string> | null = null;
  #onChange: (id: RemoteIdentity) => void;

  constructor(client: AccountClient, keys: () => Promise<DesktopKeys>, file: RemoteIdentityFile, id: RemoteIdentity, now: () => number, onChange: (id: RemoteIdentity) => void = () => {}, model: () => Promise<string | undefined> = async () => undefined) {
    this.#onChange = onChange;
    this.#client = client;
    this.#keys = keys;
    this.#file = file;
    this.#id = id;
    this.#now = now;
    this.#cache = new DeviceTokenCache(async () => this.#client.deviceToken(await this.#cert(), (await this.#keys()).vd, undefined, await model()), now);
    this.#gwCache = new DeviceTokenCache(async () => {
      const t = await this.#client.deviceToken(await this.#cert(), (await this.#keys()).vd, GATEWAY_SCOPES);
      if (t.scopes.length !== GATEWAY_SCOPES.length || t.scopes.some((s, i) => s !== GATEWAY_SCOPES[i])) throw Object.assign(new Error('scope'), { code: 'account.scope_unavailable' });
      return t;
    }, now);
  }

  get deviceList(): DeviceListJson {
    return this.#id.deviceList;
  }
  get aikPub(): string {
    return this.#id.aikPub;
  }

  get deviceId(): string {
    return this.#id.deviceId;
  }

  readonly auth: DeviceAuth = async (htm, htu) => deviceAuthHeaders(await this.#cache.token(), (await this.#keys()).vd, htm, htu, this.#now());

  clearToken(): void {
    this.#cache.clear();
  }

  async gatewayAuth(htm: 'POST', htu: string): Promise<Record<string, string>> {
    const p = (this.#gwInflight ??= this.#gwCache.token().finally(() => (this.#gwInflight = null)));
    return deviceAuthHeaders(await p, (await this.#keys()).vd, htm, htu, this.#now());
  }

  clearGatewayToken(): void {
    this.#gwCache.clear();
  }

  async acctClaimField(): Promise<string> {
    const sc = await this.#client.acctClaim(this.auth);
    if (!sc || typeof sc !== 'object' || sc.claim?.aik_pub !== this.#id.aikPub) throw Object.assign(new Error('claim'), { code: 'account.bad_response' });
    const field = b64(jcsBytes(sc));
    const shape = verifyAcctClaim(field, { accountKeys: [], aikPub: fromB64(this.#id.aikPub), now: this.#now() });
    if (!shape.ok && shape.reason === 'shape') throw Object.assign(new Error('claim'), { code: 'account.bad_response' });
    return field;
  }

  async deletion(): Promise<{ deleteAfter: number | null }> {
    return this.#retry(() => this.#client.accountDeletion(this.auth));
  }
  async requestDelete(): Promise<{ deleteAfter: number }> {
    return this.#retry(() => this.#client.requestAccountDelete(this.auth));
  }
  async cancelDelete(): Promise<void> {
    return this.#retry(() => this.#client.cancelAccountDelete(this.auth));
  }
  async #retry<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'account.unauthorized') throw e;
      this.clearToken();
      return f();
    }
  }

  async setDeviceList(list: DeviceListJson): Promise<void> {
    this.#id = { ...this.#id, deviceList: list };
    await this.#file.save(this.#id);
    this.#onChange(this.#id);
  }

  async #cert(): Promise<SignedCert> {
    const now = this.#now();
    if (this.#id.cert.cert.not_after - CERT_RENEW_MS > now) return this.#id.cert;
    const k = await this.#keys();
    const cert = await issueCert(k.aik, { device_id: this.#id.deviceId, role: 'desktop', Sx: k.noise.publicKey, Vx: k.vd.publicKey, not_after: certNotAfter(now) });
    this.#id = { ...this.#id, cert };
    await this.#file.save(this.#id);
    this.#onChange(this.#id);
    return cert;
  }
}
