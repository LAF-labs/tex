import { EgressError, GatewayError, isCodefEnv, type CodefEnv, type CodefPath, type Egress } from '@sax/net';
import { CODEF_OK, CODEF_TOKEN_CODES, CodefError, failureOf, type CodefBankCode, type CodefClientType } from './codes.ts';

interface CodefGrant {
  accessToken: string;
  expiresAt: number;
  env: CodefEnv;
  publicKey: string;
}

const GRANT_MARGIN_MS = 10 * 60_000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

interface CodefReply {
  code: string;
  data: unknown;
  text?: string;
}

/** 추가 인증(2-way) 1차 응답에서 2차 요청에 되돌려 줄 값(CODEF 개인 보유계좌 '추가인증 출력부'). 인증번호·전화번호는 담지 않는다 */
export interface CodefTwoWay {
  jobIndex: number;
  threadIndex: number;
  jti: string;
  twoWayTimestamp: number;
  method: 'sms';
}

function twoWayOf(data: unknown): CodefTwoWay | null {
  const d = obj(data);
  if (!d || d.continue2Way !== true) return null;
  const extra = obj(d.extraInfo);
  const sms = !!extra && 'reqSMSAuthNo' in extra;
  const jobIndex = Number(d.jobIndex);
  const threadIndex = Number(d.threadIndex);
  const jti = str(d.jti, 64);
  const ts = Number(d.twoWayTimestamp);
  if (!sms || !Number.isSafeInteger(jobIndex) || !Number.isSafeInteger(threadIndex) || !/^[A-Za-z0-9_-]{8,64}$/.test(jti) || !Number.isSafeInteger(ts)) return null;
  return { jobIndex, threadIndex, jti, twoWayTimestamp: ts, method: 'sms' };
}

const LOGIN_KEYS = ['commWithdrawAccountNo', 'withdrawAccountNo', 'reqWithdrawAccountPass', 'withdrawAccountPassword', 'birthDate', 'identity', 'userName', 'id', 'password', 'derFile', 'keyFile', 'certFile', 'certType', 'loginType', 'clientType', 'organization', 'businessType', 'countryCode', 'loginTypeLevel', 'clientTypeLevel', 'cardNo', 'cardPassword', 'add_password'] as const;
const LOGIN_LABELS: ReadonlyArray<[RegExp, string]> = [
  [/생년월일/, 'birthDate'],
  [/주민(등록)?번호|사업자(등록)?번호|실명번호/, 'identity'],
  [/아이디/, 'id'],
  [/성명|이름/, 'userName'],
  [/카드\s*번호/, 'cardNo'],
];
export function missingParamOf(text: string | undefined): string | null {
  if (!text) return null;
  const words = new Set(text.split(/[^A-Za-z_]+/));
  const hit = new Set<string>(LOGIN_KEYS.filter((k) => words.has(k)));
  for (const [re, k] of LOGIN_LABELS) if (re.test(text)) hit.add(k);
  return hit.size ? [...LOGIN_KEYS, 'userName', 'cardNo'].filter((k, i, a) => hit.has(k) && a.indexOf(k) === i).join('_') : 'other';
}

/**
 * CF-12401처럼 원인이 메시지에만 있을 때 로그용 단서: CODEF 안내문의 영문 단어만 '_'로 이어(숫자·한글·기호 없음, 80자).
 * 로그는 [A-Za-z0-9_.:-]만 받는다(@sax/platform). 한글 안내는 missingParamOf가 키 이름으로 바꾼다.
 */
export function hintOf(text: string | undefined): string | null {
  const t = (text ?? '').split(/[^A-Za-z_]+/).filter((w) => w.length >= 2).join('_').slice(0, 80);
  return t || null;
}

interface SealedLogin {
  derFile: string;
  keyFile: string;
  password: string;
}

export interface CodefAccount {
  number: string;
  display: string;
  name: string;
  depositKind: string;
  balance: number | null;
}

export interface CodefTxn {
  date: string;
  time: string;
  out: number;
  in: number;
  balance: number | null;
  desc1: string;
  desc2: string;
  desc3: string;
  desc4: string;
  counterAccount: string;
}

interface CodefTxnPage {
  txns: CodefTxn[];
  startDate: string;
  endDate: string;
}

const won = (v: unknown): number | null => {
  const s = str(v, 40).replace(/[,\s원]/g, '');
  if (!/^-?\d{1,15}$/.test(s)) return null;
  return Number(s);
};

export class CodefClient {
  private readonly egress: Pick<Egress, 'toGateway' | 'toCodef'>;
  private readonly now: () => number;
  private grant: CodefGrant | null = null;
  private budget: ((path: CodefPath) => void) | null = null;

  setBudget(fn: ((path: CodefPath) => void) | null): void {
    this.budget = fn;
  }

  constructor(o: { egress: Pick<Egress, 'toGateway' | 'toCodef'>; now?: () => number }) {
    this.egress = o.egress;
    this.now = o.now ?? Date.now;
  }

  async token(): Promise<CodefGrant> {
    const g = this.grant;
    if (g && g.expiresAt - this.now() > GRANT_MARGIN_MS) return g;
    let r: unknown;
    try {
      r = await this.egress.toGateway({ surface: 'codefToken', body: {} });
    } catch (e) {
      if (e instanceof GatewayError && e.code === 'gateway.codef_off') throw new CodefError('codef_off');
      throw new CodefError('unavailable');
    }
    const j = obj(r);
    const exp = Date.parse(str(j?.expiresAt, 40));
    const at = str(j?.accessToken, 4096);
    const pk = str(j?.publicKey, 4096);
    if (!j || !/^[\x21-\x7e]{16,4096}$/.test(at) || !Number.isFinite(exp) || !isCodefEnv(j.env) || !pk) throw new CodefError('bad_response');
    this.grant = { accessToken: at, expiresAt: exp, env: j.env, publicKey: pk };
    return this.grant;
  }

  async publicKey(): Promise<string> {
    return (await this.token()).publicKey;
  }

  async call(path: CodefPath, body: Json): Promise<CodefReply> {
    let r = await this.once(path, body);
    if (CODEF_TOKEN_CODES.has(r.code)) {
      this.grant = null;
      r = await this.once(path, body);
    }
    return r;
  }

  private async once(path: CodefPath, body: Json): Promise<CodefReply> {
    const g = await this.token();
    this.budget?.(path);
    let res;
    try {
      res = await this.egress.toCodef({ env: g.env, path, body, accessToken: g.accessToken });
    } catch (e) {
      throw new CodefError(e instanceof EgressError && e.code === 'timeout' ? 'bank_busy' : 'unavailable');
    }
    const j = obj(res.json);
    const code = str(obj(j?.result)?.code, 16);
    if (res.status === 401 && !code) return { code: 'CF-00401', data: null };
    if (!/^CF-\d{5}$/.test(code)) throw new CodefError(res.status >= 500 ? 'unavailable' : 'bad_response');
    const rj = obj(j?.result);
    return { code, data: j?.data ?? null, text: `${str(rj?.message, 400)} ${str(rj?.extraMessage, 400)}` };
  }

  private static ensure(r: CodefReply): Json {
    const d = obj(r.data) ?? {};
    const errs = Array.isArray(d.errorList) ? (d.errorList as unknown[]) : [];
    const first = obj(errs[0]);
    const errCode = str(first?.code, 16);
    if (r.code !== CODEF_OK || first) {
      const cf = /^CF-\d{5}$/.test(errCode) ? errCode : r.code;
      const text = `${r.text ?? ''} ${str(first?.message, 400)} ${str(first?.extraMessage, 400)}`;
      const param = cf === 'CF-12401' ? missingParamOf(text) : null;
      const e = new CodefError(failureOf(cf), cf, null, param);
      if (cf === 'CF-12401' || failureOf(cf) === 'rejected') e.hint = hintOf(text);
      throw e;
    }
    return d;
  }

  private static loginEntry(org: CodefBankCode, clientType: CodefClientType, login?: SealedLogin, withdraw?: string, withdrawPassword?: string): Json {
    const base: Json = { countryCode: 'KR', businessType: 'BK', clientType, organization: org, loginType: '0' };
    if (!login) return base;
    return { ...base, certType: '1', derFile: login.derFile, keyFile: login.keyFile, password: login.password, ...(withdraw ? { withdrawAccountNo: withdraw, commWithdrawAccountNo: withdraw } : {}), ...(withdrawPassword ? { withdrawAccountPassword: withdrawPassword } : {}) };
  }

  async createAccount(org: CodefBankCode, clientType: CodefClientType, login: SealedLogin, withdraw?: string, withdrawPassword?: string): Promise<string> {
    const d = CodefClient.ensure(await this.call('/v1/account/create', { accountList: [CodefClient.loginEntry(org, clientType, login, withdraw, withdrawPassword)] }));
    const id = str(d.connectedId, 128);
    if (!/^[A-Za-z0-9_.-]{8,128}$/.test(id)) throw new CodefError('bad_response');
    return id;
  }

  async deleteAccount(connectedId: string, org: CodefBankCode, clientType: CodefClientType): Promise<void> {
    const r = await this.call('/v1/account/delete', { connectedId, accountList: [CodefClient.loginEntry(org, clientType)] });
    if (r.code !== CODEF_OK && failureOf(r.code) === 'session_lost') return;
    CodefClient.ensure(r);
  }

  async accounts(connectedId: string, org: CodefBankCode, clientType: CodefClientType, answer?: { twoWay: CodefTwoWay; smsAuthNo: string }): Promise<CodefAccount[] | { twoWay: CodefTwoWay }> {
    const path = clientType === 'B' ? '/v1/kr/bank/b/account/account-list' : '/v1/kr/bank/p/account/account-list';
    const body: Json = { connectedId, organization: org };
    if (answer) {
      const info: Json = { ...answer.twoWay };
      delete info.method;
      Object.assign(body, { smsAuthNo: answer.smsAuthNo, is2Way: true, twoWayInfo: info });
    }
    const r = await this.call(path, body);
    const tw = r.code === 'CF-03002' ? twoWayOf(r.data) : null;
    if (tw) return { twoWay: tw };
    const d = CodefClient.ensure(r);
    const list = Array.isArray(d.resDepositTrust) ? (d.resDepositTrust as unknown[]) : obj(d.resDepositTrust) ? [d.resDepositTrust] : [];
    const out: CodefAccount[] = [];
    for (const raw of list.slice(0, 100)) {
      const a = obj(raw);
      const number = str(a?.resAccount, 40).replace(/\D/g, '');
      if (!a || number.length < 6 || number.length > 20) continue;
      const kind = str(a.resAccountDeposit, 4);
      out.push({ number, display: str(a.resAccountDisplay, 40) || number, name: str(a.resAccountNickName, 60) || str(a.resAccountName, 60), depositKind: kind, balance: won(a.resAccountBalance) });
    }
    return out;
  }

  async transactions(connectedId: string, org: CodefBankCode, clientType: CodefClientType, account: string, startDate: string, endDate: string): Promise<CodefTxnPage> {
    const path = clientType === 'B' ? '/v1/kr/bank/b/account/transaction-list' : '/v1/kr/bank/p/account/transaction-list';
    const d = CodefClient.ensure(await this.call(path, { connectedId, organization: org, account, startDate, endDate, orderBy: '1', inquiryType: '1' }));
    const list = Array.isArray(d.resTrHistoryList) ? (d.resTrHistoryList as unknown[]) : [];
    const txns: CodefTxn[] = [];
    for (const raw of list.slice(0, 20_000)) {
      const t = obj(raw);
      if (!t) continue;
      txns.push({
        date: str(t.resAccountTrDate, 8),
        time: str(t.resAccountTrTime, 6),
        out: won(t.resAccountOut) ?? 0,
        in: won(t.resAccountIn) ?? 0,
        balance: won(t.resAfterTranBalance),
        desc1: str(t.resAccountDesc1, 120),
        desc2: str(t.resAccountDesc2, 120),
        desc3: str(t.resAccountDesc3, 120),
        desc4: str(t.resAccountDesc4, 120),
        counterAccount: str(t.resCounterAccount, 40).replace(/\D/g, ''),
      });
    }
    return { txns, startDate: str(d.commStartDate, 8) || startDate, endDate: str(d.commEndDate, 8) || endDate };
  }
}
