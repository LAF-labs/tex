// 기기 관리(ADR-048 결정 6): 이 PC에서 계정의 PC·폰을 보고 끊는다. main 전용.
// - 끊기: AIK로 폐기 레코드를 서명해 새 목록을 올린다(PUT /v1/device-list). 서버가 바로 폐기하고 릴레이·푸시·게이트웨이를 멈춘다.
//   그 뒤 이 PC가 가진 그 폰의 연결 기록·우편함을 지운다.
// - 맞추기: 폰이 스스로 나갔거나(self/leave) 유예가 끝나 서버에서 폐기된 기기가 AIK 목록에 남아 있으면 폐기 레코드로 옮긴다.
//   옮기지 않으면 다음 목록 갱신(폰 연결)이 거부된다(서버는 폐기된 기기가 항목에 있는 목록을 받지 않는다).
// - 이 PC 나가기: 서버에 알리고(바로 폐기) 호출자가 로그아웃한다. 계정에 남은 마지막 활성 PC는 나갈 수 없다(account.last_desktop).
// - 최신 목록 받기: PC가 여러 대면 다른 PC가 목록을 바꾼다(폰 연결·끊기·새 PC 승인). 목록을 보거나 바꾸기 전에 서버의 목록을 받아
//   계정 AIK로 검증하고 list_version이 더 높을 때만 받아들인다(서버는 옛 목록을 되돌려 줄 수는 있어도 새 목록을 만들 수는 없다).
// 이름·플랫폼·상태는 서버 값이다. 역할과 키는 AIK 서명 목록과 맞는 것만 "목록에 있음"으로 본다(서버가 끼워 넣은 기기를 구분한다).
import { fromB64, revokeDevice, verifyDeviceList, type AikSigner, type DeviceListJson } from '@sax/remote';
import type { AccountClient, DeviceAuth, ServerDevice } from './remote-ports.ts';

/** 렌더러가 보는 기기 한 대. 키는 내보내지 않는다. */
export interface DeviceView {
  deviceId: string;
  role: 'desktop' | 'mobile';
  platform: ServerDevice['platform'];
  name: string;
  /** pending: 연결 중, active: 쓰는 중, suspended: 정지됨(끊는 중 포함) */
  state: 'pending' | 'active' | 'suspended';
  registeredAt: number;
  /** 정지된 기기가 완전히 끊기는 시각(ms). 없으면 null */
  deleteAfter: number | null;
  /** 이 PC */
  self: boolean;
  /** AIK 서명 목록에 같은 역할·키로 있다. false면 계정 웹에서 신청만 했거나 서버 기록과 목록이 다르다 */
  listed: boolean;
}

/** DeviceSession 가운데 쓰는 부분 */
export interface DeviceManagerSession {
  readonly deviceId: string;
  /** 계정 AIK 공개키(base64) */
  readonly aikPub: string;
  readonly deviceList: DeviceListJson;
  readonly auth: DeviceAuth;
  clearToken(): void;
  setDeviceList(list: DeviceListJson): Promise<void>;
}

export interface DeviceManagerOptions {
  client: Pick<AccountClient, 'devices' | 'deviceListByDevice' | 'putDeviceList' | 'leaveDevice'>;
  /** 로그인 전이면 null */
  session: () => DeviceManagerSession | null;
  aik: () => Promise<AikSigner>;
  /** 그 폰의 연결 기록·우편함을 지운다(phone-link). 기록이 없어도 된다 */
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
  /** 목록을 바꾸는 일은 한 번에 하나(list_version이 겹치지 않게) */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(o: DeviceManagerOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? (() => {});
  }

  /** 계정의 기기(폐기된 것은 빼고, PC 먼저·등록 순). 보기 전에 서버와 목록을 맞춘다. */
  async list(): Promise<DeviceView[]> {
    return this.#serial(async () => this.#view(await this.#sync()));
  }

  /** 다른 기기 끊기. 이 PC 자신은 leave()로 한다. */
  async unlink(deviceId: string): Promise<DeviceView[]> {
    return this.#serial(async () => {
      const s = this.#need();
      if (deviceId === s.deviceId) fail('account.use_leave');
      await this.#pull(s);
      if (!s.deviceList.entries.some((e) => e.entry.device_id === deviceId)) {
        // 목록에 없는 기기(이미 끊겼거나 계정 웹에서 신청만 한 기기)는 서버 상태만 다시 읽는다
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

  /** 이 PC가 계정에서 나간다. 성공하면 호출자가 로그아웃(신원 파일 지우기)한다. */
  async leave(): Promise<void> {
    return this.#serial(async () => {
      const s = this.#need();
      await this.#call(s, (a) => this.#o.client.leaveDevice(a));
      this.#log('main.device_leave', { result: 'ok' });
    });
  }

  /**
   * 서버와 맞춘다: 서버에서 폐기됐는데 AIK 목록에 남은 기기를 폐기 레코드로 옮기고, 그 폰의 연결 기록을 지운다.
   * 옮긴 기기 수를 돌려준다. 앱 시작·기기 화면을 열 때 부른다.
   */
  async reconcile(): Promise<number> {
    return this.#serial(async () => {
      const before = this.#need().deviceList.listVersion;
      await this.#sync();
      return this.#need().deviceList.listVersion - before;
    });
  }

  /**
   * 기기 목록을 바꾸는 다른 일(새 PC 승인, remote-pclink.ts)을 같은 줄에 세운다(list_version이 겹치지 않게).
   * call은 토큰이 만료돼 401이면 한 번 다시 한다.
   */
  exclusive<T>(f: (s: DeviceManagerSession, call: <R>(g: (auth: DeviceAuth) => Promise<R>) => Promise<R>, pull: () => Promise<void>) => Promise<T>): Promise<T> {
    return this.#serial(() => {
      const s = this.#need();
      return f(s, (g) => this.#call(s, g), () => this.#pull(s));
    });
  }

  /** 서버의 최신 목록을 받아들인다(AIK 서명이 맞고 list_version이 더 높고 이 PC가 들어 있을 때만). */
  async #pull(s: DeviceManagerSession): Promise<void> {
    const cur = await this.#call(s, (a) => this.#o.client.deviceListByDevice(a));
    const l = cur.deviceList;
    if (!l || cur.aikPub !== s.aikPub || !Number.isSafeInteger(l.listVersion) || l.listVersion <= s.deviceList.listVersion) return;
    if (!verifyDeviceList(l, fromB64(s.aikPub)).ok) return this.#log('main.device_sync', { result: 'list_invalid' });
    // 이 PC가 빠진 목록(다른 기기에서 이 PC를 끊음)은 받아들이지 않는다. 안내는 화면이 서버 상태(GET /v1/devices)로 한다
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
    // 서버에서 폐기된 폰의 연결 기록은 목록과 상관없이 지운다(다른 PC가 끊은 폰)
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
          self: d.deviceId === s.deviceId,
          listed: !!e && e.role === d.role && e.Sx === d.Sx && e.Vx === d.Vx,
        };
      })
      .sort((a, b) => (a.role === b.role ? a.registeredAt - b.registeredAt : a.role === 'desktop' ? -1 : 1));
  }

  #need(): DeviceManagerSession {
    return this.#o.session() ?? fail('account.signed_out');
  }

  /** 토큰이 만료돼 401이면 토큰을 버리고 한 번만 다시 한다 */
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
