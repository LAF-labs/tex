// 발급 사다리(D03 §4.2)의 첫째 칸(홈택스 자동)과 둘째 칸(직접)이 실화면 패키지 hometax.invoice.issue 2.2.0과 맞물리는가.
// 하네스는 tests/h01-real-dryrun.ts(제품 원본 패키지 + 2026-11-11 실화면 기록으로 만든 가짜 홈택스, 실제 홈택스 접속 없음).
// 두 번 발급이 될 수 있는 갈래(커밋 후보 C04 뒤 결과 모름)에서는 다음 칸으로 가지 않고, 커밋 후보 전 실패에서만 직접 칸 안내로 간다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeIssueApi, RunEnd } from '@sax/engine';
import type { PackageFiles } from '@sax/engine/core';
import { realDryRun, type Outcome } from './h01-real-dryrun.ts';
import type { HometaxFake } from './hometax-fake.ts';

const show = (o: Outcome) => `ladder=${JSON.stringify({ state: o.ladder?.state, seen: o.ladder?.seen })} end=${JSON.stringify(o.end)} steps=${o.steps.join(' ')}`;
const commits = (o: Outcome) => o.actions.filter((a) => /^ATEETBAA002C0[458]$/.test(a));
const rows = (o: Outcome) => o.ladder!.rows.map((r) => [r.stepId, r.state]);
const certThen = (a: 'confirm' | 'cancel') => (fx: HometaxFake) => {
  if (fx.state.stage === 'cert' && Date.now() - fx.state.certAt > 1500) fx.cert(a);
};
const noChrome = () => () => Promise.reject(new RunEnd('failed', 'chrome.not_installed'));

describe('발급 사다리 × H-01 2.2.0 실화면 패키지(가짜 홈택스)', () => {
  it('첫째 칸으로 발급: issued, s21 행에 발급 키, 커밋 요청 각 1번. 같은 키 재요청은 홈택스에 아무 요청도 보내지 않는다', async () => {
    const api = new FakeIssueApi('ok');
    const o = await realDryRun({ ladder: { api, again: true } });
    assert.equal(o.ladder?.state?.s, 'issued', show(o));
    assert.equal(o.end?.status, 'success', show(o));
    assert.deepEqual(rows(o), [['s21', 'committed']]);
    assert.equal(o.ladder!.rows[0]!.issueKey, o.ladder!.issueKey);
    assert.equal(o.ladder!.rows[0]!.verifyRef, o.fx.state.invoices[0]?.etan, '원장 verify_ref = 목록 승인번호');
    assert.deepEqual(commits(o), ['ATEETBAA002C04', 'ATEETBAA002C05', 'ATEETBAA002C08']);
    assert.deepEqual(o.ladder!.again, { s: 'issued', route: 'hometax.auto', ref: o.fx.state.invoices[0]?.etan });
    assert.equal(o.ladder!.actionsAfterAgain, o.actions.length, '재요청 뒤 홈택스 요청 수가 그대로');
    assert.ok(!o.ladder!.seen.includes('human') && !o.ladder!.seen.includes('consent'));
    assert.equal(api.calls, 0);
  });

  it('인증서 창 [취소](C04 나감 → in_doubt): held, 직접 칸·동의 카드 없음, API 0. 재요청도 held', async () => {
    const api = new FakeIssueApi('ok');
    const o = await realDryRun({ loggedIn: true, verifyMaxMs: 5000, human: certThen('cancel'), ladder: { api, manual: 'cannot', consent: 'granted', again: true } });
    assert.deepEqual(o.ladder?.state, { s: 'held', state: 'in_doubt' }, show(o));
    assert.deepEqual(commits(o), ['ATEETBAA002C04']);
    assert.deepEqual(rows(o), [['s21', 'in_doubt']]);
    assert.ok(!o.ladder!.seen.includes('human') && !o.ladder!.seen.includes('consent'), show(o));
    assert.deepEqual(o.ladder!.again, { s: 'held', state: 'in_doubt' });
    assert.equal(o.ladder!.actionsAfterAgain, o.actions.length);
    assert.equal(api.calls, 0);
  });

  it('서명 뒤 응답 없음(C05 무응답): held, API 0', async () => {
    const api = new FakeIssueApi('ok');
    const o = await realDryRun({ loggedIn: true, verifyMaxMs: 5000, knobs: { hangC05: true }, ladder: { api, manual: 'cannot', consent: 'granted' } });
    assert.deepEqual(o.ladder?.state, { s: 'held', state: 'in_doubt' }, show(o));
    assert.deepEqual(commits(o), ['ATEETBAA002C04', 'ATEETBAA002C05']);
    assert.equal(api.calls, 0);
  });

  it('완료 창은 떴지만 목록 반영 지연: held(부재로 다음 길로 가지 않는다), API 0', async () => {
    const api = new FakeIssueApi('ok');
    const o = await realDryRun({ loggedIn: true, verifyMaxMs: 5000, knobs: { listLagMs: 600_000 }, ladder: { api, manual: 'cannot', consent: 'granted' } });
    assert.deepEqual(o.ladder?.state, { s: 'held', state: 'in_doubt' }, show(o));
    assert.equal(api.calls, 0);
  });

  it('비정상 사업자번호(내용 오류, 커밋 요청 0): stopped counterpart.bizno_rejected, 직접 칸 안내 없음', async () => {
    const o = await realDryRun({ loggedIn: true, bizNo: '1208100002', knobs: { registry: { '1208100002': '휴업자 사업자번호입니다.' } }, ladder: { manual: 'cannot' } });
    assert.deepEqual(o.ladder?.state, { s: 'stopped', route: 'hometax.auto', code: 'counterpart.bizno_rejected' }, show(o));
    assert.deepEqual(commits(o), []);
    assert.ok(!o.ladder!.seen.includes('human'));
  });

  it('미리보기 값 불일치(assert.input_mismatch): stopped, 직접 칸 안내 없음', async () => {
    const o = await realDryRun({ loggedIn: true, knobs: { tamperPreview: true }, ladder: { manual: 'cannot' } });
    assert.deepEqual(o.ladder?.state, { s: 'stopped', route: 'hometax.auto', code: 'assert.input_mismatch' }, show(o));
    assert.ok(!o.ladder!.seen.includes('human'));
  });

  it('Chrome 없음(#288 갈래 chrome.not_installed): 첫 칸 실패로 직접 칸 안내 → [발급했어요]면 held(observed_manual), 홈택스 요청 0', async () => {
    const o = await realDryRun({ page: noChrome, ladder: { manual: 'issued' } });
    assert.deepEqual(o.ladder?.state, { s: 'held', state: 'observed_manual' }, show(o));
    assert.ok(o.ladder!.seen.includes('human'), '직접 칸 안내가 떴다');
    assert.equal(o.end?.code, 'chrome.not_installed');
    assert.deepEqual(rows(o), [['manual.issue', 'observed_manual']]);
    assert.equal(o.actions.length, 0, '홈택스에 요청이 가지 않았다');
  });

  it('Chrome 없음 → 직접 칸 [못 해요] → API 연결 없음: exhausted, 마지막 api.not_connected(사장님 할 일 안내 코드)', async () => {
    const o = await realDryRun({ page: noChrome, ladder: { manual: 'cannot' } });
    assert.deepEqual(o.ladder?.state, { s: 'exhausted', tried: [{ route: 'hometax.auto', code: 'chrome.not_installed' }, { route: 'hometax.manual', code: 'issue.manual_declined' }, { route: 'api', code: 'api.not_connected' }] }, show(o));
    assert.deepEqual(o.ladder!.rows, []);
  });

  it('로그인을 끝내 하지 않음(s5 로그인 대기 초과): 첫 칸 실패로 직접 칸 안내, 커밋 요청 0', async () => {
    // 게시본 s5는 10분을 기다린다. 이 시험만 3초로 줄인다(바꾼 것은 이 한 값).
    const shortLogin = (files: PackageFiles) => {
      const s5 = files.playbook.steps.find((x) => x.id === 's5') as { timeoutMs?: number } | undefined;
      assert.ok(s5, 's5가 있다');
      s5.timeoutMs = 3000;
    };
    const o = await realDryRun({ human: () => {}, handoffCapMs: 3000, maxMs: 60_000, patchIssue: shortLogin, ladder: { manual: 'issued' } });
    assert.ok(o.ladder!.seen.includes('human'), show(o));
    assert.deepEqual(o.ladder?.state, { s: 'held', state: 'observed_manual' }, show(o));
    assert.deepEqual(commits(o), []);
    assert.equal(o.ladder!.rows.length, 1);
  });
});
