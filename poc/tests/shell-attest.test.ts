// M4-2 3부(3b): InDoubt 증언 바(ADR-021 결정 5, D03 §2 InDoubt 행). 엔진 계약은 @sax/engine/gate(#73)의 타입·함수 그대로다.
// - approval-gate: 증언 바 요약·정적 HTML·LocalAttestation 발급(승인과 다른 HMAC 문맥).
// - ShellRuns: 증언 요청은 무장만(summaryHash 일치·InDoubt 카드만), 철회·판정·엔진 종료.
// - 소스 경계: 렌더러는 카드 열림·닫힘만 알리고, 증언은 바 클릭 → main → 게이트 포트로만 간다.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildAttestRequest, buildGateRequest, checkAttestation, type AttestRequest } from '@sax/engine/gate';
import {
  ATTEST_ACTION_TEXT,
  ATTEST_FIXED,
  attestManualText,
  attestRefusalText,
  ATTEST_STOP_TEXT,
  ATTEST_TEXT,
  attestRows,
  attestText,
  buildCardHtml,
  issueLocalAttestation,
  overflowLine,
  REFUSAL_TEXT,
  summarizeAttest,
  verifyLocalApproval,
  verifyLocalAttestation,
  type LocalApproval,
  type SummaryLine,
} from '../apps/desktop/src/approval-gate.ts';
import { interpret, type Counterparty } from '../apps/desktop/src/shell-mock.ts';
import { ATTEST_NOTE, NOTE, ShellRuns } from '../apps/desktop/src/shell-runs.ts';
import { SHELL_METHODS, USER_ACTION_METHODS } from '../apps/desktop/src/ipc.ts';

const root = path.join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const between = (s: string, start: string, end: string) => {
  const i = s.indexOf(start);
  const j = s.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `${start} … ${end}`);
  return s.slice(i, j);
};
const FORBIDDEN = /세액 산정|절세|신고 대리|가산세|납부할 세액/;
const KEY = new Uint8Array(32).fill(7);

const CPS: Counterparty[] = [{ id: 'cp-c', name: 'C테크', bizNo: '4182577343', rep: '최다라', email: 'billing@ctech.example', item: '교육 용역', status: '계속사업자', checkedOn: '', lastIssuedOn: null }];

class FakeHost extends EventEmitter {
  readonly calls: Array<[string, unknown]> = [];
  async control(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push([method, params]);
    return {};
  }
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push([method, params]);
    return {};
  }
}

const attestFor = (runId: string, over: Partial<Record<'counterpartName' | 'counterpartBizNo' | 'totalAmount', string>> = {}, manualCheck = false): AttestRequest =>
  buildAttestRequest({ runId, intentId: 'i-1', stepId: 's22', portal: 'hometax', summary: { counterpartName: 'C테크', counterpartBizNo: '4182577343', totalAmount: '440000', ...over }, manualCheck });

/** C테크 실행을 InDoubt로 끝낸다(게이트 승인 뒤 엔진이 in_doubt). */
async function inDoubtRun() {
  const host = new FakeHost();
  const runs = new ShellRuns(host, { counterparties: () => CPS, auth: () => '사업자 간편인증' });
  const d = interpret('C테크에 40만원 세금계산서', null, 'business', runs);
  assert.ok(d.kind === 'draft');
  await runs.prepare(d.run.id);
  const readback = {
    supplierBizNo: '1234567891', supplierName: '가나다컴퍼니', counterpartBizNo: '4182577343', counterpartName: 'C테크', counterpartEmail: 'billing@ctech.example',
    itemName: '교육 용역', itemCount: '1', supplyAmount: '400000', taxAmount: '40000', totalAmount: '440000', issueDate: '2026-11-05', remark: '', receiptType: '영수',
  };
  host.emit('gate', buildGateRequest({ runId: d.run.id, gateStepId: 's20', readback, reserved: [], packageDigest: '0'.repeat(64), authorizes: ['s21'], intentId: 'i-1', waitMs: 1000 }));
  runs.approved(d.run.id);
  host.emit('run', { runId: d.run.id, type: 'end', status: 'in_doubt', code: 'verify.unknown' });
  assert.equal(runs.get(d.run.id)!.inDoubt, true);
  return { host, runs, id: d.run.id };
}

describe('증언 바 내용(approval-gate, ADR-021 결정 5)', () => {
  it('요약 2줄(공급받는자 상호·사업자번호, 합계)과 E-13 고정 줄, 모두 주의 색. 정지 하향이면 직접 확인 줄을 더한다', () => {
    const lines = summarizeAttest(attestFor('r')) as SummaryLine[];
    assert.ok(Array.isArray(lines));
    assert.deepEqual(
      lines.map((l) => [l.label, l.pieces.map((p) => p.text).join(''), l.note === true, l.amount === true]),
      [
        ['합계', '440,000원', false, true],
        ['공급받는자', 'C테크 · 418-25-77343', false, false],
        ['', ATTEST_FIXED, true, false],
      ],
    );
    assert.ok(lines.every((l) => l.tone === 'attention'), '바 전체가 황토색');
    const manual = summarizeAttest(attestFor('r', {}, true)) as SummaryLine[];
    assert.equal(manual.length, 4);
    assert.equal(manual[3]!.pieces[0]!.text, '홈택스 발급목록을 직접 확인한 뒤 답해 주세요');
    assert.equal(attestManualText('unknown-portal'), '홈택스 발급목록을 직접 확인한 뒤 답해 주세요');
  });

  it('값이 없거나 이상하면 무장하지 않는다(승인 바와 같은 규칙, 문구는 "확인 결과를 받을 수 없어요")', () => {
    assert.deepEqual(summarizeAttest(attestFor('r', { counterpartBizNo: '41825' })), { reason: 'unsafe', label: '공급받는자' });
    assert.deepEqual(summarizeAttest(attestFor('r', { totalAmount: '0440000' })), { reason: 'unsafe', label: '합계' });
    assert.deepEqual(summarizeAttest(attestFor('r', { counterpartName: 'C‮テク' })), { reason: 'unsafe', label: '공급받는자' });
    assert.deepEqual(summarizeAttest(attestFor('r', { counterpartName: '' })), { reason: 'missing', label: '공급받는자' });
    assert.equal(attestRefusalText(REFUSAL_TEXT.hash()), '값 대조가 맞지 않아 확인 결과를 받을 수 없어요');
  });

  it('정적 HTML: 승인 카드와 같은 틀(값·비가역 한 줄·[닫기]·동작 버튼). 동작 글자는 승인과 다르고, 고정 줄·버튼이 넘치면 띠로 넓힌다', () => {
    const lines = summarizeAttest(attestFor('r', {}, true)) as SummaryLine[];
    assert.equal(lines.filter((l) => !l.amount).length, attestRows(true));
    assert.equal((summarizeAttest(attestFor('r')) as SummaryLine[]).filter((l) => !l.amount).length, attestRows(false));
    const html = buildCardHtml(lines, 'armed', undefined, attestText('C테크'));
    assert.ok(html.includes('class="armed attn"'), '주의 색');
    assert.ok(html.includes('<span class="tt">세금계산서 · C테크</span><span class="cp">확인 필요</span>'));
    assert.ok(html.includes(`<div class="btn st" role="button">${ATTEST_STOP_TEXT}</div><div class="btn ap" role="button"><span>${ATTEST_ACTION_TEXT}</span></div>`), '[닫기]·[홈택스 발급목록에 없음을 확인했어요]');
    assert.ok(html.includes(`<div class="irr">${ATTEST_TEXT.irreversible}</div>`) && ATTEST_TEXT.irreversible.includes('되돌릴 수 없어요'));
    assert.ok(html.includes(ATTEST_ACTION_TEXT) && html.includes(ATTEST_FIXED) && html.includes('직접 확인한 뒤 답해 주세요'));
    assert.ok(!/승인하고|발급하기|발급할게요/.test(html) && !FORBIDDEN.test(html));
    assert.ok(!ATTEST_ACTION_TEXT.includes('승인') && !ATTEST_ACTION_TEXT.includes('발급할'));
    assert.ok(!/<script|\son\w+=/i.test(html), "스크립트 없음");
    assert.equal(overflowLine(lines, 2000, ATTEST_TEXT), null);
    assert.equal(overflowLine(lines, 600, ATTEST_TEXT), null, '대화 열 폭(600)에는 들어간다');
    assert.equal(overflowLine(lines, 520, ATTEST_TEXT), '버튼', '증언 동작 글자가 길어 좁은 열에서는 띠로');
    assert.equal(overflowLine(lines, 440, ATTEST_TEXT), '안내', '라벨 없는 고정 줄이 넘쳐도 넘쳤다고 알린다');
  });

  it('LocalAttestation: 그 요청에 묶이고 엔진 checkAttestation을 지난다. 승인 근거로는 통하지 않는다(다른 HMAC 문맥)', () => {
    const req = attestFor('r');
    const now = Date.now();
    const a = issueLocalAttestation(KEY, req, undefined, now);
    assert.equal(a.kind, 'not_committed');
    assert.equal(a.exp, now + 120_000);
    assert.equal(checkAttestation(a, req, now), null);
    assert.equal(checkAttestation(a, attestFor('r'), now), 'attest.no_request', '다른 요청에는 쓸 수 없다');
    assert.ok(verifyLocalAttestation(KEY, a, now));
    assert.ok(!verifyLocalAttestation(KEY, { ...a, summaryHash: '0'.repeat(64) }, now), '요약 해시를 바꾸면 MAC이 맞지 않는다');
    assert.ok(!verifyLocalAttestation(KEY, a, now + 120_001), '만료');
    assert.ok(!verifyLocalApproval(KEY, a as unknown as LocalApproval, now), '증언은 승인 근거가 아니다');
  });
});

describe('ShellRuns 증언(무장만, 상태는 엔진 이벤트만 따른다)', () => {
  it('InDoubt 카드에 summaryHash가 맞는 요청만 무장한다. 렌더러로 가는 RunView에는 요청 값(nonce 등)이 없다', async () => {
    const { host, runs, id } = await inDoubtRun();
    const ready: string[] = [];
    runs.on('attest-ready', (x: string) => ready.push(x));
    host.emit('attest', { ...attestFor(id), summaryHash: 'f'.repeat(64) });
    host.emit('attest', { ...attestFor(id), fields: attestFor(id).fields.slice(0, 2) });
    host.emit('attest', attestFor('run-none'));
    assert.equal(runs.attestFor(id), null);
    assert.deepEqual(ready, []);
    const req = attestFor(id, {}, true);
    host.emit('attest', req);
    assert.equal(runs.attestFor(id)?.attestReqId, req.attestReqId);
    assert.deepEqual(ready, [id]);
    const view = runs.get(id)!;
    assert.deepEqual(view.attest, { state: 'ready', note: ATTEST_NOTE.manual });
    assert.ok(!JSON.stringify(view).includes(req.attestNonce), 'nonce는 렌더러로 가지 않는다');
  });

  it('InDoubt가 아닌 실행(진행 중·실패)에는 무장하지 않는다', async () => {
    const host = new FakeHost();
    const runs = new ShellRuns(host, { counterparties: () => CPS, auth: () => '사업자 간편인증' });
    const d = interpret('C테크에 40만원 세금계산서', null, 'business', runs);
    assert.ok(d.kind === 'draft');
    await runs.prepare(d.run.id);
    host.emit('attest', attestFor(d.run.id));
    assert.equal(runs.attestFor(d.run.id), null);
    host.emit('run', { runId: d.run.id, type: 'end', status: 'failed', code: 'assert.fields_missing' });
    host.emit('attest', attestFor(d.run.id));
    assert.equal(runs.attestFor(d.run.id), null);
  });

  it('철회: 그 요청일 때만 지우고 바를 내리라고 알린다(resolved·gate·aborted)', async () => {
    const { host, runs, id } = await inDoubtRun();
    const req = attestFor(id);
    host.emit('attest', req);
    const gone: unknown[] = [];
    runs.on('attest-withdrawn', (...a: unknown[]) => gone.push(a));
    host.emit('attest-withdrawn', { runId: id, attestReqId: 'other', reason: 'resolved' });
    assert.equal(runs.attestFor(id)?.attestReqId, req.attestReqId, '다른 요청 철회는 무시');
    host.emit('attest-withdrawn', { runId: id, attestReqId: req.attestReqId, reason: 'gate' });
    assert.equal(runs.attestFor(id), null);
    assert.equal(runs.get(id)!.attest, null);
    assert.deepEqual(gone, [[id, req.attestReqId, 'gate']]);
  });

  it('판정: 받으면 "기록했어요"만, 거부·못 보냄·모름은 각자 고정 문구. 같은 요청은 한 번만 쓴다. 셸은 실행 상태를 바꾸지 않는다', async () => {
    const { host, runs, id } = await inDoubtRun();
    const req = attestFor(id);
    host.emit('attest', req);
    runs.attestUsed(id, 'other');
    assert.ok(runs.attestFor(id), '다른 id로는 지우지 않는다');
    runs.attestUsed(id, req.attestReqId);
    assert.equal(runs.attestFor(id), null, '한 번 쓴 요청은 다시 바에 올리지 않는다');
    const cases: Array<[Parameters<ShellRuns['onAttestAnswer']>[1], string, string]> = [
      [{ ok: true, verdict: 'engine' }, 'sent', ATTEST_NOTE.sent],
      [{ ok: false, code: 'attest.expired', verdict: 'engine' }, 'refused', ATTEST_NOTE.expired],
      [{ ok: false, code: 'attest.mismatch', verdict: 'engine' }, 'refused', ATTEST_NOTE.stale],
      [{ ok: false, code: 'attest.no_request', verdict: 'engine' }, 'refused', ATTEST_NOTE.stale],
      [{ ok: false, code: 'engine_exit', verdict: 'not_sent' }, 'refused', ATTEST_NOTE.not_sent],
      [{ ok: false, code: 'engine_exit', verdict: 'unknown' }, 'refused', ATTEST_NOTE.unknown],
    ];
    for (const [a, state, note] of cases) {
      runs.onAttestAnswer(id, a);
      assert.deepEqual(runs.get(id)!.attest, { state, note }, JSON.stringify(a));
      assert.equal(runs.get(id)!.status, 'attention', '상태는 엔진 이벤트로만 바뀐다');
      assert.equal(runs.get(id)!.inDoubt, true);
    }
    for (const t of Object.values(ATTEST_NOTE)) assert.ok(!FORBIDDEN.test(t), t);
    assert.ok(!host.calls.some(([m]) => /approv|answer|attest/i.test(m)), '중계 통로로 증언을 보내지 않는다');
  });

  it('엔진이 끝나면 무장한 요청과 "확인 바가 떠요" 문구를 거둔다', async () => {
    const { host, runs, id } = await inDoubtRun();
    host.emit('attest', attestFor(id));
    host.emit('exit', 'engine');
    assert.equal(runs.attestFor(id), null);
    assert.equal(runs.get(id)!.attest, null);
  });
});

/** C테크 실행을 게이트 승인 뒤 엔진 상태 in_doubt로 둔다(M2-3 RunEvent: InDoubt는 end가 아니라 state). */
async function liveInDoubtRun() {
  const host = new FakeHost();
  const runs = new ShellRuns(host, { counterparties: () => CPS, auth: () => '사업자 간편인증' });
  const d = interpret('C테크에 40만원 세금계산서', null, 'business', runs);
  assert.ok(d.kind === 'draft');
  await runs.prepare(d.run.id);
  const gate = (id: string) =>
    buildGateRequest({
      runId: id, gateStepId: 's20', packageDigest: '0'.repeat(64), authorizes: ['s21'], intentId: 'i-1', waitMs: 1000, reserved: [],
      readback: { supplierBizNo: '1234567891', supplierName: '가나다컴퍼니', counterpartBizNo: '4182577343', counterpartName: 'C테크', counterpartEmail: 'billing@ctech.example', itemName: '교육 용역', itemCount: '1', supplyAmount: '400000', taxAmount: '40000', totalAmount: '440000', issueDate: '2026-11-05', remark: '', receiptType: '영수' },
    });
  host.emit('gate', gate(d.run.id));
  runs.approved(d.run.id);
  host.emit('run', { runId: d.run.id, type: 'phase', phase: 'verify', state: 'now' });
  host.emit('run', { runId: d.run.id, type: 'state', state: 'in_doubt', code: 'verify.unknown' });
  return { host, runs, id: d.run.id, gate };
}
const runEnds = (host: FakeHost, id: string) => host.calls.filter(([m, p]) => m === 'run.end' && (p as { runId: string }).runId === id).length;

describe('엔진 상태 이벤트(state, InDoubt는 종료가 아님)', () => {
  it('state in_doubt → 확인 필요 카드, 금고 실행은 끝내지 않는다. 증언 뒤 state running → 게이트 앞부터 다시(새 게이트 요청을 받는다)', async () => {
    const { host, runs, id, gate } = await liveInDoubtRun();
    let r = runs.get(id)!;
    assert.equal(r.status, 'attention');
    assert.equal(r.inDoubt, true);
    assert.match(r.stoppedNote ?? '', /중복 발급될 수 있어요/);
    assert.equal(runEnds(host, id), 0, 'InDoubt는 끝이 아니다');
    host.emit('attest', attestFor(id));
    runs.attestUsed(id, runs.attestFor(id)!.attestReqId);
    runs.onAttestAnswer(id, { ok: true, verdict: 'engine' });
    host.emit('run', { runId: id, type: 'state', state: 'running' });
    r = runs.get(id)!;
    assert.equal(r.status, 'preparing');
    assert.equal(r.inDoubt, false);
    assert.equal(r.attest, null);
    assert.equal(r.stoppedNote, undefined);
    assert.deepEqual(r.steps.slice(4).map((s) => s.state), ['todo', 'todo', 'todo', 'todo'], '승인부터 다시');
    host.emit('gate', gate(id));
    assert.equal(runs.get(id)!.status, 'waiting', '새 게이트 요청(새 승인)을 받는다');
  });

  it('state paused(policy_downgrade) → 확인 필요와 고정 문구. InDoubt 뒤의 end(completed_with_issues)는 받는다', async () => {
    const a = await liveInDoubtRun();
    a.host.emit('run', { runId: a.id, type: 'state', state: 'paused', code: 'policy_downgrade' });
    const r = a.runs.get(a.id)!;
    assert.equal(r.status, 'attention');
    assert.equal(r.inDoubt, false);
    assert.equal(r.stoppedNote, NOTE.policy_downgrade);
    assert.ok(!/세액 산정|절세|신고 대리|가산세/.test(NOTE.policy_downgrade!));
    const b = await liveInDoubtRun();
    b.host.emit('run', { runId: b.id, type: 'end', status: 'completed_with_issues', code: 'verify.not_committed' });
    assert.equal(b.runs.get(b.id)!.inDoubt, false);
    assert.equal(runEnds(b.host, b.id), 1, '종료 상태에서만 금고 실행을 끝낸다');
    b.host.emit('run', { runId: b.id, type: 'end', status: 'completed_with_issues' });
    assert.equal(runEnds(b.host, b.id), 1, '끝난 실행의 end는 무시');
  });

  it('진행 중 실행의 running·모르는 상태·끝난 실행의 state는 무시한다', async () => {
    const host = new FakeHost();
    const runs = new ShellRuns(host, { counterparties: () => CPS, auth: () => '사업자 간편인증' });
    const d = interpret('C테크에 40만원 세금계산서', null, 'business', runs);
    assert.ok(d.kind === 'draft');
    await runs.prepare(d.run.id);
    const before = JSON.stringify(runs.get(d.run.id));
    host.emit('run', { runId: d.run.id, type: 'state', state: 'running' });
    host.emit('run', { runId: d.run.id, type: 'state', state: 'exploded' });
    assert.equal(JSON.stringify(runs.get(d.run.id)), before);
    host.emit('run', { runId: d.run.id, type: 'end', status: 'failed', code: 'assert.fields_missing' });
    host.emit('run', { runId: d.run.id, type: 'state', state: 'in_doubt' });
    assert.equal(runs.get(d.run.id)!.inDoubt, false, '끝난 실패 카드는 InDoubt로 바뀌지 않는다');
  });

  it('엔진이 끝나면 InDoubt 상태 실행은 카드를 그대로 두고 금고 실행만 끝낸다', async () => {
    const { host, runs, id } = await liveInDoubtRun();
    host.emit('exit', 'engine');
    assert.equal(runs.get(id)!.inDoubt, true);
    assert.equal(runs.get(id)!.status, 'attention');
    assert.equal(runEnds(host, id), 1);
  });
});

describe('증언 경계(소스)', () => {
  it('렌더러 메서드는 카드 열림·닫힘뿐이고 이름에 증언·승인이 없다. 열기는 실제 입력 3초 안에만', () => {
    assert.ok('incident.open' in SHELL_METHODS && 'incident.close' in SHELL_METHODS);
    assert.equal(USER_ACTION_METHODS['incident.open'], 3_000);
    const app = read('apps/desktop/src/shell-app.ts');
    const handlers = between(app, "'incident.open': (p) =>", "'docs.list'");
    assert.ok(handlers.includes('needGesture(3_000)') && handlers.includes('incidents.open(') && handlers.includes('incidents.close('));
    // 바는 카드를 연 실행의 요청만, 바 자리가 비었을 때만 올린다.
    const show = between(app, 'const showAttest =', 'const incidents =');
    assert.ok(show.includes('incidentOpen !== runId') && show.includes('bar.visible') && show.includes('verifyLocalAttestation(key, o.attestation)') && show.includes('runs.attestUsed('));
    assert.ok(show.indexOf('runs.attestUsed(') < show.indexOf('host.answerAttest('), '보내기 전에 요청을 쓴 것으로 표시한다');
  });

  it('렌더러: 카드·안내에 증언 버튼이 없고, 패널 열림·닫힘만 알린다', () => {
    const js = read('apps/desktop/static/shell/shell.js');
    const views = read('apps/desktop/static/shell/shell-views.js');
    const sync = between(js, 'function syncIncident(p)', 'function openPanel(p)');
    assert.deepEqual([...sync.matchAll(/call\('([^']+)'/g)].map((m) => m[1]), ['incident.close', 'incident.open']);
    assert.ok(between(js, 'function openPanel(p) {', 'renderPanel();').includes('syncIncident(p)'));
    for (const src of [js, views]) assert.ok(!/attest\.answer|answerAttest|LocalAttestation|발급목록에 없음을 확인했어요/.test(src));
    const inDoubt = between(views, "st === 'attention' && run.inDoubt", "st === 'attention') {");
    assert.equal([...inDoubt.matchAll(/btn\(/g)].length, 1, '버튼은 [홈택스에서 직접 확인] 하나');
  });

  it('승인 바: 게이트 > 증언. 게이트가 오면 증언 바를 내리고, 증언은 게이트가 떠 있으면 busy. 근거 종류는 바 종류와 같아야 한다', () => {
    const bar = read('apps/desktop/src/approval-bar.ts');
    const open = between(bar, '  open(req: GateRequest, auth?: string)', '  openAttest(');
    assert.ok(open.includes("this.req?.kind === 'gate'") && open.includes("this.finish({ decision: 'closed', reason: 'gate' })"));
    const openAttest = between(bar, '  openAttest(req: AttestRequest)', '  close(reason');
    assert.ok(openAttest.includes("if (this.req) return Promise.resolve({ decision: 'closed', reason: 'busy' })") && openAttest.includes('attestSelfCheck(req)') && openAttest.includes('this.text = attestText('));
    const approve = between(bar, '  private approve(): void {', '  /** 창 크기와');
    assert.ok(approve.includes("req.kind === 'gate'") && approve.includes('issueLocalApproval(this.key, req.gate') && approve.includes('issueLocalAttestation(this.key, req.attest)'));
    assert.ok(bar.includes("reason: 'kind_mismatch'"));
    // 키보드 경로는 게이트에만(키보드 승인은 꺼져 있고, 증언에는 처음부터 없다).
    assert.ok(bar.includes("if (this.req?.kind === 'gate' && this.shown && !this.refusal"));
  });
});
