// 공동인증서 비밀번호 차례(B1 로그인 s4·B2 발급 서명 s21, CertSecretPort): 금고 비밀 창 → 열지 못하면 사람 직접 입력 대기([다 했어요]).
// 끝 모양: done · ttl(창 닫기 요청) · [중지] · 틀린 비밀번호(sign.password_wrong) · 누적 MAX_WRONG(sign.password_retry_limit). 가짜 금고·가짜 화면.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CertSecretPort, MAX_WRONG, type CertSecretInput, type SecretTurnEvent, type SecretVault } from '@sax/engine';
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
const mk = (o: Partial<CertSecretInput> & { screen?: string[] } = {}) => {
  const vault = new FakeVault();
  const journal: Array<[string, unknown]> = [];
  const events: SecretTurnEvent[] = [];
  const timers: Array<() => void> = [];
  const fronts: number[] = [];
  const screen = o.screen ?? [];
  let done: (() => void) | null = null;
  const abort = new AbortController();
  const port = new CertSecretPort({
    vault, targetId: () => 'T1', dict: WITH_PW, strings: {}, journal: (t, p) => journal.push([t, p]),
    page: { bringToFront: async () => void fronts.push(1), text: async () => screen.shift() ?? '' },
    event: (e) => events.push(e), manualDone: () => new Promise<void>((r) => (done = r)), signal: abort.signal,
    setTimer: (fn) => (timers.push(fn), () => {}), sleep: async () => {}, settleMs: 0, ...o,
  });
  return { port, vault, journal, events, timers, fronts, abort, finish: () => done?.() };
};
const REQ = { runId: 'r1', stepId: 's4', ttlMs: 120_000 };

describe('CertSecretPort(공동인증서 비밀번호, B1·B2)', () => {
  it('사전의 cert_password 칸으로 금고 비밀 창을 연다(실행 탭을 먼저 앞으로). 닫히면 done, 값은 엔진에 오지 않는다', async () => {
    const h = mk();
    h.vault.onOpen = () => h.vault.close('T1');
    assert.equal(await h.port.secret(REQ), 'done');
    assert.deepEqual(h.vault.calls, [['secretWindow.openForHuman', { runId: 'r1', targetId: 'T1', frame: 'main', element: '#certPw' }]]);
    assert.equal(h.fronts.length, 1);
    assert.deepEqual(h.events, [{ state: 'open', stepId: 's4', mode: 'window', ttlMs: 120_000 }, { state: 'closed', stepId: 's4', mode: 'window', why: 'done' }]);
    assert.ok(!JSON.stringify(h.journal).includes('value'));
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
    assert.deepEqual(h.events.at(-1), { state: 'closed', stepId: 's4', mode: 'window', why: 'ttl' });
  });

  it('[중지]면 창 닫기를 요청하고 끝낸다(조율기는 중지를 먼저 본다)', async () => {
    const h = mk();
    const w = h.port.secret(REQ);
    await tick();
    h.abort.abort();
    assert.equal(await w, 'ttl');
    assert.equal(h.vault.calls.at(-1)![0], 'secretWindow.requestClose');
    assert.deepEqual(h.events.at(-1), { state: 'closed', stepId: 's4', mode: 'window', why: 'aborted' });
    assert.ok(h.journal.some(([t]) => t === 'human.secret_aborted'));
  });

  it('사전에 비밀번호 칸이 없으면(별도 인증서 프로그램 등) 사람 직접 입력 대기: 금고를 부르지 않고 [다 했어요]로 done', async () => {
    const h = mk({ dict: NO_PW });
    const w = h.port.secret(REQ);
    await tick();
    assert.deepEqual(h.events, [{ state: 'open', stepId: 's4', mode: 'manual', ttlMs: 120_000 }]);
    h.finish();
    assert.equal(await w, 'done');
    assert.deepEqual(h.vault.calls, []);
    assert.equal(h.fronts.length, 1, '대기 전에 실행 탭을 앞으로');
    assert.deepEqual(h.journal.map(([t]) => t), ['human.secret_manual', 'human.manual_done']);
    assert.deepEqual(h.journal[0]![1], { stepId: 's4', reason: 'no_field' });
  });

  it('금고가 칸을 찾지 못하면(not_found) 사유를 남기고 사람 직접 입력 대기로 바꾼다. 대기도 TTL이면 ttl', async () => {
    const h = mk();
    h.vault.answers['secretWindow.openForHuman'] = { ok: false, reason: 'not_found' };
    const w = h.port.secret(REQ);
    await tick();
    assert.deepEqual(h.events, [{ state: 'open', stepId: 's4', mode: 'manual', ttlMs: 120_000 }], '창을 열지 못했으니 window 안내는 없다');
    h.timers.at(-1)!();
    assert.equal(await w, 'ttl');
    assert.ok(h.journal.some(([t, p]) => t === 'human.secret_manual' && (p as Json).reason === 'not_found'));
    assert.deepEqual(h.events.at(-1), { state: 'closed', stepId: 's4', mode: 'manual', why: 'ttl' });
  });

  it('입력 뒤 화면에 틀린 비밀번호 안내가 보이면 sign.password_wrong, MAX_WRONG번째는 sign.password_retry_limit, 그 뒤로는 창을 열지 않는다', async () => {
    const screen: string[] = [];
    const h = mk({ screen });
    h.vault.onOpen = () => h.vault.close('T1');
    for (let n = 1; n <= MAX_WRONG; n++) {
      screen.push('인증서 암호가 일치하지 않습니다. (남은 횟수 안내)');
      const r = await h.port.secret(REQ);
      assert.deepEqual(r, { code: n < MAX_WRONG ? 'sign.password_wrong' : 'sign.password_retry_limit' });
      assert.deepEqual(h.events.at(-1), { state: 'closed', stepId: 's4', mode: 'window', why: n < MAX_WRONG ? 'password_wrong' : 'retry_limit' });
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
