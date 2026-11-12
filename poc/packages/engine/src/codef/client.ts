// CODEF 호출(계좌 자동조회). 토큰은 우리 게이트웨이 /v1/codef/token에서 받고(시크릿은 서버에만), 호출은 Egress.toCodef로 PC → CODEF 직결이다.
// 토큰·본문(인증서 파일·감싼 비밀번호·계좌·거래내역)은 기록하지 않는다. 응답은 비신뢰 값이라 필요한 칸만 모양을 확인해 꺼낸다.
import { EgressError, GatewayError, isCodefEnv, type CodefEnv, type CodefPath, type Egress } from '@sax/net';
import { CODEF_OK, CODEF_TOKEN_CODES, CodefError, failureOf, type CodefBankCode, type CodefClientType } from './codes.ts';

export interface CodefGrant {
  accessToken: string;
  expiresAt: number;
  env: CodefEnv;
  publicKey: string;
}

/** 토큰이 이만큼 남으면 새로 묻는다 */
const GRANT_MARGIN_MS = 10 * 60_000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

export interface CodefReply {
  code: string;
  data: unknown;
}

/** 감싼 로그인(금고 codef.seal 결과): 계정 등록 accountList 원소의 인증서 칸 */
export interface SealedLogin {
  derFile: string;
  keyFile: string;
  password: string;
}

export interface CodefAccount {
  /** 계좌번호 숫자만(화면·로그에 보내지 않는다. 엔진 안에서 조회·저장에만) */
  number: string;
  display: string;
  name: string;
  /** 11 수시입출 등 CODEF 분류 */
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

export interface CodefTxnPage {
  txns: CodefTxn[];
  /** CODEF가 실제로 쓴 기간(은행 한도로 줄였으면 다르다) YYYYMMDD */
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
  /** 호출 전에 부른다(하루 상한, CodefLink가 넣는다). 던지면 보내지 않는다 */
  private budget: ((path: CodefPath) => void) | null = null;

  setBudget(fn: ((path: CodefPath) => void) | null): void {
    this.budget = fn;
  }

  constructor(o: { egress: Pick<Egress, 'toGateway' | 'toCodef'>; now?: () => number }) {
    this.egress = o.egress;
    this.now = o.now ?? Date.now;
  }

  /** 게이트웨이에서 토큰을 받는다(만료 10분 전까지 메모리 캐시). */
  async token(): Promise<CodefGrant> {
    const g = this.grant;
    if (g && g.expiresAt - this.now() > GRANT_MARGIN_MS) return g;
    let r: unknown;
    try {
      r = await this.egress.toGateway({ surface: 'codefToken', body: {} });
    } catch (e) {
      if (e instanceof GatewayError && e.code === 'gateway.codef_off') throw new CodefError('codef_off');
      // 로그인·모델 동의 전이면 main이 헤더를 주지 않는다(gateway.unavailable)
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

  /** 한 번 부르고, 토큰 만료·무효면 토큰을 버리고 한 번만 다시 부른다. 결과 코드와 data를 돌려준다(성공 판정은 부른 쪽). */
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
    return { code, data: j?.data ?? null };
  }

  /** 실패면 CodefError. 계정 등록류는 errorList의 기관 코드가 더 구체적이다 */
  private static ensure(r: CodefReply): Json {
    const d = obj(r.data) ?? {};
    const errs = Array.isArray(d.errorList) ? (d.errorList as unknown[]) : [];
    const first = obj(errs[0]);
    const errCode = str(first?.code, 16);
    if (r.code !== CODEF_OK || first) {
      const cf = /^CF-\d{5}$/.test(errCode) ? errCode : r.code;
      throw new CodefError(failureOf(cf), cf);
    }
    return d;
  }

  private static loginEntry(org: CodefBankCode, clientType: CodefClientType, login?: SealedLogin): Json {
    const base: Json = { countryCode: 'KR', businessType: 'BK', clientType, organization: org, loginType: '0' };
    return login ? { ...base, certType: '1', derFile: login.derFile, keyFile: login.keyFile, password: login.password } : base;
  }

  /** 계정 등록(connectedId 새로 받기): 공동인증서 der·key + 감싼 비밀번호 */
  async createAccount(org: CodefBankCode, clientType: CodefClientType, login: SealedLogin): Promise<string> {
    const d = CodefClient.ensure(await this.call('/v1/account/create', { accountList: [CodefClient.loginEntry(org, clientType, login)] }));
    const id = str(d.connectedId, 128);
    if (!/^[A-Za-z0-9_.-]{8,128}$/.test(id)) throw new CodefError('bad_response');
    return id;
  }

  /** 계정 삭제. 그 기관 계정이 마지막이면 CODEF가 connectedId도 지운다. 이미 없으면 성공으로 본다 */
  async deleteAccount(connectedId: string, org: CodefBankCode, clientType: CodefClientType): Promise<void> {
    const r = await this.call('/v1/account/delete', { connectedId, accountList: [CodefClient.loginEntry(org, clientType)] });
    if (r.code !== CODEF_OK && failureOf(r.code) === 'session_lost') return;
    CodefClient.ensure(r);
  }

  /** 보유계좌(예금·신탁 중 수시입출). 계좌번호는 숫자만 */
  async accounts(connectedId: string, org: CodefBankCode, clientType: CodefClientType): Promise<CodefAccount[]> {
    const path = clientType === 'B' ? '/v1/kr/bank/b/account/account-list' : '/v1/kr/bank/p/account/account-list';
    const d = CodefClient.ensure(await this.call(path, { connectedId, organization: org }));
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

  /** 수시입출 거래내역. startDate·endDate YYYYMMDD, 과거순 */
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
