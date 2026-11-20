import { fromB64, revokeDevice, verifyDeviceList, type AikSigner, type DeviceListJson } from '@sax/remote';
import type { AccountClient, DeviceAuth, ServerDevice } from './remote-ports.ts';

export interface DeviceView {
  deviceId: string;
  role: 'desktop' | 'mobile';
  platform: ServerDevice['platform'];
  name: string;
  state: 'pending' | 'active' | 'suspended';
  registeredAt: number;
  deleteAfter: number | null;
  lastSeenAt: number | null;
  self: boolean;
  listed: boolean;
}

export interface DeviceManagerSession {
  readonly deviceId: string;
  readonly aikPub: string;
  readonly deviceList: DeviceListJson;
  readonly auth: DeviceAuth;
  clearToken(): void;
  setDeviceList(list: DeviceListJson): Promise<void>;
}

interface DeviceManagerOptions {
  client: Pick<AccountClient, 'devices' | 'deviceListByDevice' | 'putDeviceList' | 'leaveDevice'>;
  session: () => DeviceManagerSession | null;
  aik: () => Promise<AikSigner>;
  dropPhone: (deviceId: string) => Promise<void>;
  now?: () => number;
  log?: (name: string, data: Record<string, string | number>) => void;
}

const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};
const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[a-z_]+\.[a-z_]+$/.test(c) ? c : 'account.failed';
};

export class DeviceManager {
  #o: DeviceManagerOptions;
  #now: () => number;
  #log: NonNullable<DeviceManagerOptions['log']>;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(o: DeviceManagerOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? (() => {});
  }

  async list(): Promise<DeviceView[]> {
    return this.#serial(async () => this.#view(await this.#sync()));
  }

  async unlink(deviceId: string): Promise<DeviceView[]> {
    return this.#serial(async () => {
      const s = this.#need();
      if (deviceId === s.deviceId) fail('account.use_leave');
      await this.#pull(s);
      if (!s.deviceList.entries.some((e) => e.entry.device_id === deviceId)) {
        const rows = await this.#sync();
        if (!rows.some((d) => d.deviceId === deviceId && d.state !== 'revoked')) return this.#view(rows);
        return fail('account.device_not_listed');
      }
      const role = s.deviceList.entries.find((e) => e.entry.device_id === deviceId)!.entry.role;
      await this.#publish(s, await revokeDevice(await this.#o.aik(), s.deviceList, deviceId, this.#now()));
      if (role === 'mobile') await this.#o.dropPhone(deviceId).catch((e) => this.#log('main.device_unlink', { step: 'drop_phone', result: codeOf(e) }));
      this.#log('main.device_unlink', { result: 'ok', role });
      return this.#view(await this.#call(s, (a) => this.#o.client.devices(a)));
    });
  }

  async leave(): Promise<void> {
    return this.#serial(async () => {
      const s = this.#need();
      await this.#call(s, (a) => this.#o.client.leaveDevice(a));
      this.#log('main.device_leave', { result: 'ok' });
    });
  }

  async reconcile(): Promise<number> {
    return this.#serial(async () => {
      const before = this.#need().deviceList.listVersion;
      await this.#sync();
      return this.#need().deviceList.listVersion - before;
    });
  }

  exclusive<T>(f: (s: DeviceManagerSession, call: <R>(g: (auth: DeviceAuth) => Promise<R>) => Promise<R>, pull: () => Promise<void>) => Promise<T>): Promise<T> {
    return this.#serial(() => {
      const s = this.#need();
      return f(s, (g) => this.#call(s, g), () => this.#pull(s));
    });
  }

  async #pull(s: DeviceManagerSession): Promise<void> {
    const cur = await this.#call(s, (a) => this.#o.client.deviceListByDevice(a));
    const l = cur.deviceList;
    if (!l || cur.aikPub !== s.aikPub || !Number.isSafeInteger(l.listVersion) || l.listVersion <= s.deviceList.listVersion) return;
    if (!verifyDeviceList(l, fromB64(s.aikPub)).ok) return this.#log('main.device_sync', { result: 'list_invalid' });
    if (!l.entries.some((e) => e.entry.device_id === s.deviceId && e.entry.role === 'desktop')) return this.#log('main.device_sync', { result: 'self_removed' });
    await s.setDeviceList(l);
    this.#log('main.device_sync', { result: 'pulled' });
  }

  async #sync(): Promise<ServerDevice[]> {
    const s = this.#need();
    await this.#pull(s);
    const rows = await this.#call(s, (a) => this.#o.client.devices(a));
    const gone = rows.filter((d) => d.state === 'revoked' && d.deviceId !== s.deviceId && s.deviceList.entries.some((e) => e.entry.device_id === d.deviceId));
    for (const d of gone) {
      await this.#publish(s, await revokeDevice(await this.#o.aik(), s.deviceList, d.deviceId, this.#now()));
      this.#log('main.device_sync', { result: 'moved', role: d.role });
    }
    for (const d of rows) if (d.role === 'mobile' && d.state === 'revoked') await this.#o.dropPhone(d.deviceId).catch(() => {});
    return rows;
  }

  async #publish(s: DeviceManagerSession, list: DeviceListJson): Promise<void> {
    await this.#call(s, (a) => this.#o.client.putDeviceList(a, list));
    await s.setDeviceList(list);
  }

  #view(rows: readonly ServerDevice[]): DeviceView[] {
    const s = this.#need();
    const listed = new Map(s.deviceList.entries.map((e) => [e.entry.device_id, e.entry]));
    return rows
      .filter((d) => d.state !== 'revoked')
      .map((d): DeviceView => {
        const e = listed.get(d.deviceId);
        return {
          deviceId: d.deviceId,
          role: d.role,
          platform: d.platform,
          name: d.name,
          state: d.state as DeviceView['state'],
          registeredAt: d.registeredAt,
          deleteAfter: d.deleteAfter,
          lastSeenAt: d.deviceId === s.deviceId ? Date.now() : d.lastSeenAt,
          self: d.deviceId === s.deviceId,
          listed: !!e && e.role === d.role && e.Sx === d.Sx && e.Vx === d.Vx,
        };
      })
      .sort((a, b) => (a.role === b.role ? a.registeredAt - b.registeredAt : a.role === 'desktop' ? -1 : 1));
  }

  #need(): DeviceManagerSession {
    return this.#o.session() ?? fail('account.signed_out');
  }

  async #call<T>(s: DeviceManagerSession, f: (auth: DeviceAuth) => Promise<T>): Promise<T> {
    try {
      return await f(s.auth);
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'account.unauthorized') throw e;
      s.clearToken();
      return f(s.auth);
    }
  }

  #serial<T>(f: () => Promise<T>): Promise<T> {
    const p = this.#chain.then(f, f);
    this.#chain = p.catch(() => {});
    return p;
  }
}
