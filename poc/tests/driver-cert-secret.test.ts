// 공동인증서 비밀번호 차례(B1 로그인 s4·B2 발급 서명 s21, CertSecretPort): 금고 비밀 창 → 인증서 선택창(iframe#dscert)·칸 없음·금고가 못 찾음이면
// 곧바로 human.cert_waiting(B3 사람 대기로 기다린다). 끝 모양: done · ttl(창 닫기 요청) · [중지] · 틀린 비밀번호 · 누적 MAX_WRONG. 가짜 금고·가짜 화면.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CERT_FRAME_CSS, CERT_WAITING, CertSecretPort, MAX_WRONG, type CertSecretInput, type SecretTurnEvent, type SecretVault } from '@sax/engine';
import type { SelectorDict, SelectorEntry } from '@sax/engine/core';

type Json = Record<string, unknown>;
const entry = (o: Partial<SelectorEntry>): SelectorEntry => ({ role: 'textbox', namePattern: '^인증서 비밀번호$', landmark: 'p.root', candidates: [{ kind: 'css', value: '#certPw' }], frame: 'main', commits: false, lastVerified: '2026-11-11', ...o });
const WITH_PW: SelectorDict = { portal: 'hometax', commitEndpoints: [], knownEndpoints: [], entries: { 'f.certPw': entry({ secretKind: 'cert_password' } as Partial<SelectorEntry>), 'f.other': entry({}) } };
const NO_PW: SelectorDict = { portal: 'hometax', commitEndpoints: [], knownEndpoints: [], entries: { 'f.other': entry({}) } };

class FakeVault implements SecretVault {
  calls: Array<[string, Json]> = [];
  answers: Record<string, unknown> = { 'secretWindow.openForHuman': { ok: true }, 'secretWindow.requestClose': { ok: true } };
  ls = new Set<(d: Json) => void>();
  onOpen?: () => void;
  async rpc<T>(m: string, p: Json = {}): Promise<T> {
    this.calls.push([m, p]);
    if (m === 'secretWindow.openForHuman') queueMicrotask(() => this.onOpen?.());
    return this.answers[m] as T;
  }
  on(_n: string, fn: (d: Json) => void) {
    this.ls.add(fn);
    return () => this.ls.delete(fn);
  }
  close(targetId: string) {
    for (const f of [...this.ls]) f({ targetId });
  }
}

const tick = () => new Promise((r) => setImmediate(r));
const mk = (o: Partial<CertSecretInput> & { screen?: string[]; frame?: boolean } = {}) => {
  const vault = new FakeVault();
  const journal: Array<[string, unknown]> = [];
  const events: SecretTurnEvent[] = [];
  const timers: Array<() => void> = [];
  const fronts: number[] = [];
  const screen = o.screen ?? [];
  const abort = new AbortController();
  const port = new CertSecretPort({
    vault, targetId: () => 'T1', dict: WITH_PW, strings: {}, journal: (t, p) => journal.push([t, p]),
    page: { bringToFront: async () => void fronts.push(1), text: async () => screen.shift() ?? '', certFrame: async () => o.frame ?? false },
    event: (e) => events.push(e), signal: abort.signal,
    setTimer: (fn) => (timers.push(fn), () => {}), sleep: async () => {}, settleMs: 0, ...o,
  });
  return { port, vault, journal, events, timers, fronts, abort };
};
const REQ = { runId: 'r1', stepId: 's4', ttlMs: 120_000 };

describe('CertSecretPort(공동인증서 비밀번호, B1·B2)', () => {
  it('사전의 cert_password 칸으로 금고 비밀 창을 연다(실행 탭을 먼저 앞으로). 닫히면 done, 값은 엔진에 오지 않는다', async () => {
    const h = mk();
    h.vault.onOpen = () => h.vault.close('T1');
    assert.equal(await h.port.secret(REQ), 'done');
    assert.deepEqual(h.vault.calls, [['secretWindow.openForHuman', { runId: 'r1', targetId: 'T1', frame: 'main', element: '#certPw' }]]);
    assert.equal(h.fronts.length, 1);
    assert.deepEqual(h.events, [{ state: 'open', stepId: 's4', ttlMs: 120_000 }, { state: 'closed', stepId: 's4', why: 'done' }]);
    assert.ok(!JSON.stringify(h.journal).includes('value'));
  });

  it('넣은 뒤 첫 기다림 스텝이 통과하면 typist.authOk(금고가 그때 기억), 실패하면 typist.authFailed(버리고 지움). 서명 차례는 다시 재지 않는다', async () => {
    const ok = mk();
    ok.vault.onOpen = () => ok.vault.close('T1');
    assert.equal(await ok.port.secret(REQ), 'done');
    await ok.port.stepFinished('click', false); // 로그인 [확인]은 상관없다
    await ok.port.stepFinished('wait', false);
    assert.deepEqual(ok.vault.calls.at(-1), ['typist.authOk', { runId: 'r1', kind: 'cert_password', scope: 'business' }]);
    // 발급 서명의 비밀번호 차례 뒤 기다림이 실패해도 맞는 기억값을 지우지 않는다
    assert.equal(await ok.port.secret({ ...REQ, stepId: 's21' }), 'done');
    const n = ok.vault.calls.length;
    await ok.port.stepFinished('wait', true);
    assert.equal(ok.vault.calls.length, n);

    const bad = mk();
    bad.vault.onOpen = () => bad.vault.close('T1');
    assert.equal(await bad.port.secret(REQ), 'done');
    await bad.port.stepFinished('wait', true); // H-01 s5 시간 초과(틀린 비밀번호 포함)
    assert.deepEqual(bad.vault.calls.at(-1), ['typist.authFailed', { runId: 'r1', kind: 'cert_password', scope: 'business' }]);

    // 사이에 다른 스텝이 실패하면(비밀번호 탓 아님) 알리지 않는다
    const other = mk();
    other.vault.onOpen = () => other.vault.close('T1');
    assert.equal(await other.port.secret(REQ), 'done');
    await other.port.stepFinished('click', true);
    await other.port.stepFinished('wait', true);
    assert.ok(!other.vault.calls.some(([m]) => m.startsWith('typist.auth')));
  });

  it('스텝 target이 있으면 그 칸을 쓴다', async () => {
    const h = mk();
    h.vault.onOpen = () => h.vault.close('T1');
    assert.equal(await h.port.secret({ ...REQ, target: 'f.other' }), 'done');
    assert.equal(h.vault.calls[0]![1].element, '#certPw');
    assert.equal(h.port.targetKey('f.other'), 'f.other');
    assert.equal(h.port.targetKey(), 'f.certPw');
  });

  it('TTL(120초)이 지나면 창 닫기를 요청하고 ttl(조율기 human.ttl_expired → 재개하면 창을 다시 연다)', async () => {
    const h = mk();
    const w = h.port.secret(REQ);
    await tick();
    h.timers.at(-1)!();
    assert.equal(await w, 'ttl');
    assert.deepEqual(h.vault.calls.at(-1), ['secretWindow.requestClose', { runId: 'r1', targetId: 'T1' }]);
    assert.deepEqual(h.events.at(-1), { state: 'closed', stepId: 's4', why: 'ttl' });
  });

  it('[중지]면 창 닫기를 요청하고 끝낸다(조율기는 중지를 먼저 본다)', async () => {
    const h = mk();
    const w = h.port.secret(REQ);
    await tick();
    h.abort.abort();
    assert.equal(await w, 'ttl');
    assert.equal(h.vault.calls.at(-1)![0], 'secretWindow.requestClose');
    assert.deepEqual(h.events.at(-1), { state: 'closed', stepId: 's4', why: 'aborted' });
    assert.ok(h.journal.some(([t]) => t === 'human.secret_aborted'));
  });

  it('홈택스 인증서 선택창(iframe#dscert, 다른 출처)이 떠 있으면 금고 창을 열지 않고 곧바로 human.cert_waiting(사람이 직접 넣는다, B3 사람 대기)', async () => {
    const h = mk({ frame: true });
    assert.deepEqual(await h.port.secret(REQ), { code: CERT_WAITING });
    assert.deepEqual(h.vault.calls, []);
    assert.equal(h.fronts.length, 1, '실행 탭을 앞으로(앱 창 뒤에 가려지지 않게)');
    assert.deepEqual(h.journal, [['human.secret_manual', { stepId: 's4', reason: 'cert_frame' }]]);
    assert.deepEqual(h.events, [], '금고 창 안내는 없다(사람 대기는 handoff로 보인다)');
    assert.match(CERT_FRAME_CSS, /dscert/);
  });

  it('사전에 비밀번호 칸이 없으면 금고를 부르지 않고 human.cert_waiting', async () => {
    const h = mk({ dict: NO_PW });
    assert.deepEqual(await h.port.secret(REQ), { code: CERT_WAITING });
    assert.deepEqual(h.vault.calls, []);
    assert.deepEqual(h.journal[0], ['human.secret_manual', { stepId: 's4', reason: 'no_field' }]);
  });

  it('금고가 칸을 찾지 못하면(not_found) 사유를 남기고 human.cert_waiting', async () => {
    const h = mk();
    h.vault.answers['secretWindow.openForHuman'] = { ok: false, reason: 'not_found' };
    assert.deepEqual(await h.port.secret(REQ), { code: CERT_WAITING });
    assert.equal(h.vault.calls.length, 1);
    assert.ok(h.journal.some(([t, p]) => t === 'human.secret_manual' && (p as Json).reason === 'not_found'));
    assert.deepEqual(h.events, [], '창을 열지 못했으니 안내는 없다');
  });

  it('입력 뒤 화면에 틀린 비밀번호 안내가 보이면 sign.password_wrong, MAX_WRONG번째는 sign.password_retry_limit, 그 뒤로는 창을 열지 않는다', async () => {
    const screen: string[] = [];
    const h = mk({ screen });
    h.vault.onOpen = () => h.vault.close('T1');
    for (let n = 1; n <= MAX_WRONG; n++) {
      screen.push('인증서 암호가 일치하지 않습니다. (남은 횟수 안내)');
      const r = await h.port.secret(REQ);
      assert.deepEqual(r, { code: n < MAX_WRONG ? 'sign.password_wrong' : 'sign.password_retry_limit' });
      assert.deepEqual(h.events.at(-1), { state: 'closed', stepId: 's4', why: n < MAX_WRONG ? 'password_wrong' : 'retry_limit' });
    }
    const opened = h.vault.calls.length;
    assert.deepEqual(await h.port.secret(REQ), { code: 'sign.password_retry_limit' });
    assert.equal(h.vault.calls.length, opened, '한도 뒤에는 창을 다시 열지 않는다');
  });

  it('맞는 비밀번호(안내 없음)면 done. 포털 패턴 strings cert.passwordWrong이 있으면 그것으로 본다', async () => {
    const h = mk({ screen: ['로그인되었습니다'] });
    h.vault.onOpen = () => h.vault.close('T1');
    assert.equal(await h.port.secret(REQ), 'done');

    const k = mk({ strings: { 'cert.passwordWrong': '^오류코드 W-1$' }, screen: ['오류코드 W-1'] });
    k.vault.onOpen = () => k.vault.close('T1');
    assert.deepEqual(await k.port.secret(REQ), { code: 'sign.password_wrong' });
  });
});
