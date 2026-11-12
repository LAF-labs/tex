// 발급 사다리의 API 칸(D03 §4.2). 원천은 칸 안에서 하나만 고른다: 팝빌이 연결돼 있으면 팝빌, 아니면 CODEF.
// 무장 뒤 발급 호출은 한 번뿐이다. 오류·끊김이면 다시 부르지 않고 우리 문서번호로 조회해 원장을 종결한다.
import { createHash } from 'node:crypto';
import { GateRepo, Ledger, RunJournal, RunRepo, type Db } from '@sax/db';
import { ulid, type RunService } from '../runs.ts';
import { errorCode } from './hometax.ts';
import { routeSpec } from './routes.ts';
import type { ApiProvider, AttemptEnd, IssueKey, Rung } from './types.ts';
import { API_PLAYBOOK } from './verdict.ts';

/** 원천에 보내는 문서(값 있음). 원장·저널에는 docKey만 남는다. */
export interface ApiIssueDoc {
  docKey: string;
  supplierBizNo: string;
  counterpart: { bizNo: string; name: string };
  supply: string;
  tax: string;
  total: string;
  itemName: string;
  issueDate: string;
  email: string | null;
}

export type ApiIssueResult = { t: 'issued'; ref: string } | { t: 'refused'; code: string } | { t: 'unknown' };
export type ApiLookupResult = { t: 'issued'; ref: string } | { t: 'absent' } | { t: 'unknown' };

/** 연결 원천 경계. 실제 팝빌·CODEF 어댑터는 연결 원천(파트너 키·회원 등록)이 생길 때 만든다. */
export interface IssueApiAdapter {
  readonly provider: ApiProvider;
  issue(doc: ApiIssueDoc): Promise<ApiIssueResult>;
  lookup(docKey: string): Promise<ApiLookupResult>;
}

const QUOTE: Readonly<Record<ApiProvider, { costKrw: number | null; costBasis: string }>> = {
  popbill: { costKrw: 200, costBasis: '팝빌 웹 종량제 건당 200원(파트너 원가 미확인)' },
  codef: { costKrw: null, costBasis: 'CODEF 발행 상품 요금 미확인' },
};

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf: Buffer): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of buf) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** 팝빌 MgtKey(24자, 영문 대문자·숫자). 같은 키·같은 시도 의도면 언제나 같은 번호라 응답이 끊겨도 조회로 결론이 난다. */
export const docKeyOf = (issueKey: IssueKey, intentId: string): string => 'SAX' + base32(createHash('sha256').update(`${issueKey}\0${intentId}`).digest()).slice(0, 21);

const safeCode = (c: string): string => (/^[A-Za-z0-9_.:-]{1,40}$/.test(c) ? c : 'invalid');

export function apiRung(adapters: { popbill?: IssueApiAdapter | null; codef?: IssueApiAdapter | null }, deps: { runs: RunService; db: Db }): Rung {
  const source = adapters.popbill ?? adapters.codef ?? null;
  const repo = new RunRepo(deps.db);
  const gates = new GateRepo(deps.db);
  const ledger = new Ledger(deps.db);
  const journal = new RunJournal(deps.db);
  return {
    route: routeSpec('api'),
    available: () => (source ? { ok: true } : { ok: false, code: 'api.not_connected' }),
    ...(source ? { quote: () => ({ provider: source.provider, ...QUOTE[source.provider] }) } : {}),
    run: async (req, _io, consent): Promise<AttemptEnd> => {
      if (!source) return { code: 'api.not_connected' };
      if (!consent || consent.issueKey !== req.issueKey || consent.route !== 'api') return { code: 'issue.consent_missing' };
      const runId = `issue-${ulid()}`;
      let p;
      try {
        p = deps.runs.prepareIssue(req, { runId, stepId: 'api.issue', playbookId: API_PLAYBOOK });
      } catch (e) {
        return { code: errorCode(e) };
      }
      const { intentId } = p.row;
      repo.create({ id: runId, playbookId: API_PLAYBOOK, playbookVersion: '1', packageDigest: p.row.packageDigest, profileId: p.profileId, trigger: 'local', inputsHash: p.row.inputsHash });
      journal.append(runId, 'run.started', { intentId, provider: source.provider });
      journal.append(runId, 'issue.rung', { issueKey: req.issueKey, rung: 'api', provider: source.provider });
      // 사장님 [동의하고 발급]이 이 칸의 승인이다. 게이트 표에 approved로 남기고 무장이 소비한다(홈택스 승인 근거는 쓰지 않는다).
      gates.open(consent.reqId, runId);
      gates.decide(consent.reqId, 'approved', 'consent');
      journal.append(runId, 'gate.approved', { reqId: consent.reqId, by: 'consent' });
      try {
        p.arm(consent.reqId);
      } catch (e) {
        if (gates.withdraw(consent.reqId, 'run_ended')) journal.append(runId, 'gate.withdrawn', { reqId: consent.reqId });
        const code = errorCode(e);
        repo.finish(runId, 'failed');
        journal.append(runId, 'run.ended', { status: 'failed', code });
        return { code };
      }
      journal.append(runId, 'ledger.armed', { reqId: consent.reqId });
      const docKey = docKeyOf(req.issueKey, intentId);
      const end = (status: string, code: string): AttemptEnd => {
        repo.finish(runId, status);
        journal.append(runId, 'run.ended', { status, code });
        return { code };
      };
      try {
        ledger.dispatched(intentId, 'api.issue');
        journal.append(runId, 'ledger.dispatched', { docKey });
        const r = await source.issue({
          docKey, supplierBizNo: p.supplierBizNo, counterpart: { bizNo: p.inputs.counterpart.bizNo, name: p.inputs.counterpart.name },
          supply: p.inputs.amounts.supply, tax: p.inputs.amounts.tax, total: p.inputs.amounts.total, itemName: p.inputs.items[0]!.name, issueDate: p.inputs.issueDate, email: p.inputs.email,
        }).catch((): ApiIssueResult => ({ t: 'unknown' }));
        if (r.t === 'issued') {
          ledger.resolve(intentId, 'api.issue', 'committed', null, r.ref);
          journal.append(runId, 'ledger.committed', { reason: '' });
          return end('success', 'api.issued');
        }
        journal.append(runId, 'api.issue_failed', { kind: r.t, ...(r.t === 'refused' ? { providerCode: safeCode(r.code) } : {}) });
        const l = await source.lookup(docKey).catch((): ApiLookupResult => ({ t: 'unknown' }));
        journal.append(runId, 'api.lookup', { result: l.t });
        if (l.t === 'issued') {
          ledger.resolve(intentId, 'api.issue', 'committed', null, l.ref);
          journal.append(runId, 'ledger.committed', { reason: '' });
          return end('success', 'api.issued');
        }
        if (l.t === 'absent') {
          ledger.resolve(intentId, 'api.issue', 'not_committed', 'verify', null);
          journal.append(runId, 'ledger.not_committed', { reason: 'verify' });
          return end('failed', r.t === 'refused' ? 'api.refused' : 'api.not_committed');
        }
        ledger.resolve(intentId, 'api.issue', 'in_doubt');
        journal.append(runId, 'ledger.in_doubt', { reason: '' });
        return end('in_doubt', 'api.unknown');
      } catch {
        // 무장 뒤 예외: 열린 행을 숨기지 않는다(발급됐는지 모른다).
        const row = ledger.get(intentId, 'api.issue');
        if (row && (row.state === 'armed' || row.state === 'dispatched')) ledger.resolve(intentId, 'api.issue', 'in_doubt');
        return end('in_doubt', 'api.unknown');
      }
    },
  };
}

export type FakeIssueKnob = 'ok' | 'refuse' | 'drop_then_absent' | 'drop_then_issued' | 'drop_unknown';

/** 시험·개발용 원천(네트워크 없음). calls = 발급 호출 수, lookups = 조회 수. */
export class FakeIssueApi implements IssueApiAdapter {
  readonly provider: ApiProvider;
  knob: FakeIssueKnob;
  calls = 0;
  lookups = 0;
  private readonly issued = new Map<string, string>();
  constructor(knob: FakeIssueKnob = 'ok', provider: ApiProvider = 'popbill') {
    this.knob = knob;
    this.provider = provider;
  }

  async issue(doc: ApiIssueDoc): Promise<ApiIssueResult> {
    this.calls++;
    if (this.knob === 'refuse') return { t: 'refused', code: 'fake.refused' };
    if (this.knob === 'ok' || this.knob === 'drop_then_issued') this.issued.set(doc.docKey, `FAKE-NTS-${this.issued.size + 1}`);
    if (this.knob === 'ok') return { t: 'issued', ref: this.issued.get(doc.docKey)! };
    throw new Error('fake.dropped');
  }

  async lookup(docKey: string): Promise<ApiLookupResult> {
    this.lookups++;
    if (this.knob === 'drop_unknown') return { t: 'unknown' };
    const ref = this.issued.get(docKey);
    return ref ? { t: 'issued', ref } : { t: 'absent' };
  }
}
