// 새 PC 연결의 main 쪽 흐름(ADR-048 결정 3, D08 §4.3). main 전용.
// 프로토콜은 @sax/remote pclink.ts, 통로는 계정 서비스의 연결 우편함(서버가 메시지를 보고 바꿀 수 있다고 가정한다), 계정 열쇠(RK)는 금고(PcLinkVault)만 만진다.
// - PcLinkJoin [새 PC]: 로그인한 세션으로 신청하고, 쓰던 PC의 답을 기다려 6자리를 보인다. 받은 열쇠는 사용자가
//   "쓰던 PC에 '연결됐어요'가 떴다"고 한 뒤에만 금고에 넘긴다(새 PC는 쓰던 PC를 암호로 확인하지 못한다. 이 확인이 그 자리를 메운다).
// - PcLinkHost [쓰던 PC]: 신청을 보이고, 사용자가 [연결]을 누르면 답한다. 새 PC 화면의 6자리가 맞으면 새 목록을 올리고(서버가 한도를 본다),
//   올라간 뒤에만 금고가 열쇠를 봉인해 보낸다. 6자리를 3번 틀리거나 약속과 다른 값이 오면 신청을 버린다.
// 세션·난수·6자리는 메모리에만 있고 로그에는 결과 코드만 남긴다.
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

/** 새 PC가 6자리를 보인 뒤 이만큼 지나도 승인이 없으면 새로 신청한다(쓰던 PC의 승인 창 10분 + 여유). */
export const PCLINK_RESTART_MS = PCLINK_STEP_MS + 30_000;
/** 쓰던 PC가 "연결됐어요"를 보여 두는 시간. 새 PC의 사용자가 이 말을 보고 확인을 누른다. */
export const PCLINK_DONE_SHOW_MS = 10 * 60_000;

// ───────────────────────── 새 PC ─────────────────────────

/** wait: 쓰던 PC의 답을 기다림 · code: 6자리를 보이는 중 · confirm: 열쇠가 왔고 사용자 확인을 기다림 */
export type PcLinkJoinStage = 'wait' | 'code' | 'confirm';

export interface PcLinkJoinOptions {
  client: Pick<AccountClient, 'devicesBySession' | 'enrollDesktop' | 'pcLinkHello' | 'pcLinkAnswer' | 'pcLinkReveal' | 'pcLinkCancel'>;
  /** 계정 세션. 연결이 끝나면 호출자가 로그아웃한다 */
  session: string;
  /** 서버가 주는 계정의 AIK 공개키(base64, GET /v1/device-list). 쓰던 PC의 답이 이것과 다르면 받지 않는다 */
  aikPub: string;
  /** 이 PC의 기기 키(Sd·Vd 공개키만 쓴다) */
  keys: Pick<DesktopKeys, 'noise' | 'vd'>;
  vault: PcLinkVault;
  platform: 'windows' | 'macos';
  /** 기기 목록에 보이는 이름(40자) */
  name: string;
  now?: () => number;
}

/** 연결이 끝난 새 PC의 신원 재료. 금고의 AIK는 이미 계정의 AIK다. */
export interface PcLinkJoined {
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

  /**
   * 신청한다. 이 PC의 기록(같은 Sx·Vx의 데스크톱)이 계정에 있으면 그 기기 ID를 다시 쓰고, 없으면 새로 신청한다.
   * PC가 이미 3대면 account.device_limit.
   */
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

  /** 화면에 보일 6자리. 쓰던 PC가 답하기 전에는 null */
  get code(): string | null {
    return this.#stage === 'wait' ? null : this.#sas;
  }

  /** 넘겨받기 키와 난수를 새로 뽑아 처음부터 다시 신청한다(서버가 앞 단계를 지운다). */
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

  /**
   * 쓰던 PC의 답을 본다. 단계가 바뀌면 true.
   * 끝내야 하는 실패는 code가 붙은 오류다: account.link_not_found(쓰던 PC가 거절했거나 신청이 사라짐), account.link_mismatch(답이 맞지 않음).
   */
  async poll(): Promise<boolean> {
    if (this.#busy) return false;
    this.#busy = true;
    try {
      const before = this.#stage;
      const a = await this.#o.client.pcLinkAnswer(this.#o.session, this.deviceId);
      if (this.#stage === 'wait' && a.challenge !== null) {
        const c = parsePcLinkChallenge(a.challenge);
        // 서버가 준 계정 AIK와 다른 키로 답한 PC는 이 계정의 PC가 아니다
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
        // 쓰던 PC의 승인 창(10분)이 지났다. 새 6자리로 다시 신청한다
        await this.#sendHello();
      }
      return this.#stage !== before;
    } finally {
      this.#busy = false;
    }
  }

  /**
   * 사용자가 "쓰던 PC에 '연결됐어요'가 떴다"고 한 뒤에만 부른다. 금고가 봉인문을 열고, 연 열쇠의 AIK가 6자리에 묶인 AIK와 같을 때만 바꾼다.
   * 실패는 account.link_mismatch(금고가 받지 않음). 성공하면 우편함을 비운다. 호출자는 키 객체를 새로 만든다(AIK가 바뀌었다).
   */
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

  /** 그만둔다(우편함만 비운다. 신청 기록은 남아 다시 시도할 때 쓴다). */
  async cancel(): Promise<void> {
    await this.#o.client.pcLinkCancel(this.#o.session, this.deviceId).catch(() => {});
  }
}

// ───────────────────────── 쓰던 PC ─────────────────────────

/** 렌더러가 보는 신청 한 건. 키·난수·6자리는 내보내지 않는다(6자리는 사용자가 새 PC 화면에서 읽어 넣는다). */
export interface PcLinkRequestView {
  deviceId: string;
  /** 새 PC가 적은 이름·플랫폼(서버 값) */
  name: string;
  platform: 'windows' | 'macos';
  createdAt: number;
  /**
   * new: 아직 답하지 않음([연결]·[거절]) · wait: 답했고 새 PC의 응답을 기다림 · code: 6자리를 받을 차례 ·
   * done: 연결됨("연결됐어요") · other: 다른 PC가 진행 중
   */
  stage: 'new' | 'wait' | 'code' | 'done' | 'other';
  /** code 단계에서 남은 입력 횟수 */
  triesLeft: number | null;
}

const stateOf = (ap: PcLinkApprover): PcLinkApproveState => ap.state;

type Call = <R>(g: (auth: DeviceAuth) => Promise<R>) => Promise<R>;

export interface PcLinkHostOptions {
  client: Pick<AccountClient, 'pcLinks' | 'pcLinkChallenge' | 'pcLinkGrant' | 'pcLinkDrop' | 'putDeviceList'>;
  /** 기기 목록을 바꾸는 일과 같은 줄에 선다(DeviceManager.exclusive). 로그인 전이면 account.signed_out */
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
  /** 내가 답한 신청(메모리에만. 앱을 다시 켜면 사라지고, 새 PC가 10분 뒤 다시 신청한다) */
  #aps = new Map<string, Approving>();
  #done = new Map<string, { view: PcLinkRequestView; at: number }>();

  constructor(o: PcLinkHostOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? (() => {});
  }

  /** 기다리는 신청들. 새 PC의 응답(m3)이 와 있으면 약속과 대조한다. */
  list(): Promise<PcLinkRequestView[]> {
    return this.#o.exclusive((s, call) => this.#sync(s, call));
  }

  /** [연결]: 이 PC가 승인하겠다고 답한다. 다른 PC가 먼저 답했으면 account.link_state. */
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

  /**
   * 새 PC 화면의 6자리. 맞으면 새 목록을 올리고(이미 목록에 있는 PC면 건너뛴다) 계정 열쇠를 봉인해 보낸다.
   * 틀리면 ok: false(남은 횟수는 목록의 triesLeft). 3번 틀리면 신청을 버린다.
   */
  confirm(deviceId: string, code: string): Promise<{ ok: boolean; requests: PcLinkRequestView[] }> {
    return this.#o.exclusive(async (s, call, pull) => {
      await this.#sync(s, call);
      const p = this.#aps.get(deviceId);
      if (!p || p.ap.state !== 'awaiting_sas') return fail('account.link_state');
      if (!p.ap.confirm(code)) {
        // confirm()이 상태를 바꾼다(게터라 좁혀진 형식을 다시 읽는다)
        if (stateOf(p.ap) === 'failed') {
          this.#aps.delete(deviceId);
          // 횟수를 다 썼으면 신청을 버린다. 시간이 지난 것이면 두고 새 PC의 다시 신청을 기다린다
          if (p.ap.triesLeft <= 0) await call((a) => this.#o.client.pcLinkDrop(a, deviceId)).catch(() => {});
          this.#log('main.pclink_host', { result: p.ap.triesLeft <= 0 ? 'code_tries' : 'code_expired' });
        }
        return { ok: false, requests: await this.#sync(s, call) };
      }
      const row = (await call((a) => this.#o.client.pcLinks(a))).find((x) => x.deviceId === deviceId);
      this.#aps.delete(deviceId);
      try {
        const aik = await this.#o.aik();
        const h = p.ap.hello;
        // 다른 PC가 그 사이 목록을 바꿨을 수 있다. 최신 목록 위에 새 PC를 더한다
        await pull();
        let list = s.deviceList;
        if (!list.entries.some((e) => e.entry.device_id === h.device_id && e.entry.role === 'desktop' && e.entry.Sx === h.Sx && e.entry.Vx === h.Vx)) {
          list = await p.ap.listWithNew(aik, s.deviceList, this.#now()).catch((e: unknown) => fail(/too many/.test(String((e as Error)?.message)) ? 'account.device_limit' : 'account.link_mismatch'));
          await call((a) => this.#o.client.putDeviceList(a, list));
          await s.setDeviceList(list);
        }
        // 목록이 올라간 뒤에만 열쇠를 봉인한다(서버가 거절하면 봉인하지 않는다)
        const vault = await this.#o.vault();
        const grant = await p.ap.grant({ aik, deviceList: list, sealRk: (r, i, a) => vault.sealRk(r, i, a), now: this.#now() });
        await call((a) => this.#o.client.pcLinkGrant(a, deviceId, grant));
      } catch (e) {
        this.#log('main.pclink_host', { result: codeOf(e) });
        // 렌더러는 오류의 message만 받는다(ipc.ts dispatchShell): 코드를 message에 둔다
        throw Object.assign(new Error(codeOf(e)), { code: codeOf(e) });
      }
      this.#done.set(deviceId, { view: { deviceId, name: row?.name ?? '', platform: row?.platform ?? 'windows', createdAt: row?.createdAt ?? this.#now(), stage: 'done', triesLeft: null }, at: this.#now() });
      this.#log('main.pclink_host', { result: 'ok' });
      return { ok: true, requests: await this.#sync(s, call) };
    });
  }

  /** [거절]: 신청을 버린다(아직 활성화되지 않은 그 PC의 신청 기록도 서버에서 지워져 자리가 빈다). */
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
      // 새 PC가 다시 신청했거나(다른 약속), 내 답이 서버에 없거나, 승인 창(10분)이 지났으면 앞 상태를 버린다
      if (p && (p.ap.hello.commit !== hello.commit || r.challengedBy !== s.deviceId || p.ap.state === 'failed' || now - p.startedAt > PCLINK_STEP_MS)) {
        this.#aps.delete(r.deviceId);
        p = undefined;
      }
      if (!p) {
        if (r.challengedBy === null) out.push({ ...base, stage: 'new', triesLeft: null });
        else if (r.challengedBy !== s.deviceId) out.push({ ...base, stage: 'other', triesLeft: null });
        // 내가 답했는데 상태가 없는 신청(앱을 다시 켰거나 시간이 지남)은 새 PC가 다시 신청할 때까지 보이지 않는다
        continue;
      }
      if (p.ap.state === 'awaiting_reveal' && r.reveal !== null && !p.ap.reveal(r.reveal)) {
        // 약속과 다른 값: 새 PC의 키가 중간에 바뀌었다. 신청을 버린다
        this.#aps.delete(r.deviceId);
        await call((a) => this.#o.client.pcLinkDrop(a, r.deviceId)).catch(() => {});
        this.#log('main.pclink_host', { result: 'commit_mismatch' });
        continue;
      }
      out.push({ ...base, stage: p.ap.state === 'awaiting_sas' ? 'code' : 'wait', triesLeft: p.ap.state === 'awaiting_sas' ? p.ap.triesLeft : null });
    }
    for (const id of [...this.#aps.keys()]) if (!seen.has(id)) this.#aps.delete(id);
    for (const [id, d] of [...this.#done]) {
      if (now - d.at > PCLINK_DONE_SHOW_MS) this.#done.delete(id);
      else out.push(d.view);
    }
    return out;
  }
}
