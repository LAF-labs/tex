// H-01 실화면 패키지(hometax.invoice.issue 2.2.0) 건조 실행: 가짜 홈택스(tests/hometax-fake.ts)에 로그인부터 메일 확인까지. 실제 홈택스에 접속하지 않는다.
// 하네스: tests/h01-real-dryrun.ts(제품 원본 패키지에서 origin·host·domains·portal·서명만 바꾼다).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EndpointClassifier, endpointUnion, knownUnion } from '@sax/engine';
import { loadPkg } from './core-fixtures.ts';
import { fixtureFiles, PACKAGE_IDS, REAL_ORIGIN, REAL_TEET, realDryRun, type Outcome } from './h01-real-dryrun.ts';
import type { HometaxFake } from './hometax-fake.ts';

const show = (o: Outcome) => `end=${JSON.stringify(o.end)} steps=${o.steps.join(' ')} journal=${o.journal.join(',')}`;
const commits = (o: Outcome) => o.actions.filter((a) => /^ATEETBAA002C0[458]$/.test(a));
const certThen = (a: 'confirm' | 'cancel') => (fx: HometaxFake) => {
  if (fx.state.stage === 'cert' && Date.now() - fx.state.certAt > 1500) fx.cert(a);
};

describe('H-01 실화면 패키지: 가짜 홈택스 건조 실행', () => {
  it('로그아웃에서 시작: 로그인 화면 → 사람 로그인 → 건별발급 → alert → 미리보기 대조 → 게이트 → 확인 창 → 인증유형 → 인증서 창(사람) → 완료 창 → 목록 etan → PDF → 메일', async () => {
    const o = await realDryRun();
    assert.equal(o.end?.status, 'success', show(o));
    assert.equal(o.end?.mailConfirmed, true);
    assert.match(o.end?.approvalNo ?? '', /^\d{8}-\d{8}-\d{8}$/);
    assert.equal(o.end?.approvalNo, o.fx.state.invoices[0]?.etan, '승인번호는 목록 etan과 같다');
    assert.deepEqual(o.steps.slice(0, 6), ['s0', 's2', 's3', 's4', 's5', 's6']);
    assert.ok(o.journal.includes('dialog.alert_accepted') && o.journal.includes('signflow.done_seen'), show(o));
    // 실화면 요청 순서(log.md "요청 순서"): 미리보기·확인 창까지 C 계열 0건, 인증유형 클릭 때 C04, 서명 뒤 C05 → C08 → 완료 창.
    const ix = (a: string) => o.actions.indexOf(a);
    assert.deepEqual(commits(o), ['ATEETBAA002C04', 'ATEETBAA002C05', 'ATEETBAA002C08'], '커밋 요청 각 1번');
    assert.ok(ix('perm:UTEETZZA08') < ix('ATEETBAA002C04') && ix('ATEETBAA002C08') < ix('perm:UTEETZZA87'), o.actions.join(' '));
    assert.ok(ix('perm:UTEETBAA09') < ix('ATEETBAA002R04'), '미리보기 뒤에 미리보기 [발급하기]');
  });

  it('이미 로그인: s2에서 s10. 화면이 5초 늦게 그려져도(실화면 5~8초) 기다린다', async () => {
    const o = await realDryRun({ loggedIn: true, knobs: { renderDelayMs: 5000 }, maxMs: 150_000 });
    assert.equal(o.end?.status, 'success', show(o));
    assert.deepEqual(o.steps.slice(0, 4), ['s0', 's0a', 's2', 's10']);
  });

  it('비정상 사업자번호: [확인] alert 문구가 "정상적인…"이 아니면 게이트 전에 failed counterpart.bizno_rejected(커밋 요청 0)', async () => {
    const o = await realDryRun({ loggedIn: true, bizNo: '1208100002', knobs: { registry: { '1208100002': '휴업자 사업자번호입니다.' } } });
    assert.deepEqual([o.end?.status, o.end?.code, o.gate], ['failed', 'counterpart.bizno_rejected', false], show(o));
    assert.equal(o.steps.at(-1), 's13a!counterpart.bizno_rejected');
    assert.deepEqual(commits(o), []);
  });

  it('미리보기 값 불일치(창의 등록번호가 입력과 다름): 게이트 전에 failed assert.input_mismatch', async () => {
    const o = await realDryRun({ loggedIn: true, knobs: { tamperPreview: true } });
    assert.deepEqual([o.end?.status, o.end?.code, o.gate], ['failed', 'assert.input_mismatch', false], show(o));
    assert.deepEqual(commits(o), []);
  });

  it('인증서 창에서 [취소]: C04가 나갔으므로 in_doubt(verify.unknown). 엔진은 창이 닫힌 것을 보고 verify로 간다', async () => {
    const o = await realDryRun({ loggedIn: true, verifyMaxMs: 5000, human: certThen('cancel') });
    assert.deepEqual([o.end?.status, o.end?.code], ['in_doubt', 'verify.unknown'], show(o));
    assert.ok(o.journal.includes('signflow.window_closed') && o.journal.includes('ledger.in_doubt'), show(o));
    assert.deepEqual(commits(o), ['ATEETBAA002C04']);
  });

  it('서명 뒤 응답 없음(C05 무응답, 완료 창 없음·목록 없음): in_doubt', async () => {
    const o = await realDryRun({ loggedIn: true, verifyMaxMs: 5000, knobs: { hangC05: true } });
    assert.deepEqual([o.end?.status, o.end?.code], ['in_doubt', 'verify.unknown'], show(o));
    assert.deepEqual(commits(o), ['ATEETBAA002C04', 'ATEETBAA002C05']);
  });

  it('완료 창은 떴지만 목록에 행이 없음(반영 지연): 부재로 재발급하지 않고 in_doubt', async () => {
    const o = await realDryRun({ loggedIn: true, verifyMaxMs: 5000, knobs: { listLagMs: 600_000 } });
    assert.deepEqual([o.end?.status, o.end?.code], ['in_doubt', 'verify.unknown'], show(o));
    assert.ok(o.journal.includes('signflow.done_seen'));
    assert.equal(o.actions.filter((a) => a === 'ATEETBAA002C05').length, 1, '다시 발급하지 않는다');
  });

  it('메일 발송중(발송결과 빈칸): 발급은 success 경로, 메일은 확인 못 함 → completed_with_issues mail.not_confirmed', async () => {
    const o = await realDryRun({ loggedIn: true, knobs: { mail: 'sending' } });
    assert.deepEqual([o.end?.status, o.end?.code, o.end?.mailConfirmed], ['completed_with_issues', 'mail.not_confirmed', false], show(o));
    assert.match(o.end?.approvalNo ?? '', /^\d{8}-\d{8}-\d{8}$/);
  });
});

describe('H-01 실화면 패키지: 가짜 = 실제 패키지(바꾼 곳은 다섯 가지뿐)', () => {
  it('fixtureFiles는 origin·teet host·domains·portal 말고 아무것도 바꾸지 않는다', () => {
    for (const id of PACKAGE_IDS) {
      const real = loadPkg(id);
      const fx = fixtureFiles(real, 'http://127.0.0.1:1', '127.0.0.1:2');
      const back = JSON.parse(JSON.stringify(fx).replaceAll('"http://127.0.0.1:1', `"${REAL_ORIGIN}`).replaceAll('"host":"127.0.0.1:2"', `"host":"${REAL_TEET}"`));
      back.manifest.domains = real.manifest.domains;
      back.manifest.portal = back.playbook.portal = back.selectors.portal = real.manifest.portal;
      assert.deepEqual(back, real, id);
    }
  });

  it('네트워크 가드 분류: teet 호스트의 C04·C05·C08만 커밋, 같은 경로의 R 계열·다른 호스트는 아님', () => {
    const sel = loadPkg('hometax.invoice.issue').selectors;
    const c = new EndpointClassifier(endpointUnion([sel]), knownUnion([sel]), ['hometax.go.kr', '*.hometax.go.kr']);
    const kind = (url: string) => c.classify({ url, method: 'POST' }).kind;
    const q = '&screenId=UTEETBAA01&popupYn=false&realScreenId=';
    for (const a of ['ATEETBAA002C04', 'ATEETBAA002C05', 'ATEETBAA002C08']) assert.equal(kind(`https://teet.hometax.go.kr/wqAction.do?actionId=${a}${q}`), 'commit', a);
    assert.equal(kind(`https://teet.hometax.go.kr/wqAction.do?actionId=ATEETBAA002R03${q}`), 'known');
    assert.equal(kind(`https://hometax.go.kr/wqAction.do?actionId=ATEETBAA002C05${q}`), 'unclassified', 'host가 다르면 커밋 항목이 아니다(known에도 없음)');
  });
});
