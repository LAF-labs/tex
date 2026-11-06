// release-readiness.json betaDistributable 채널별 판정표(팀장 결정 2026-11-06, apps/desktop/build/SIGNING-SETUP.md §4).
// unsigned_build는 stable에서만 블로커, windows_run_unverified는 WIN-REALDEVICE.md 요약 표의 `설치·첫 실행` ✅가 있으면 해제.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// @ts-expect-error 타입 선언 없는 .mjs 스크립트
import { readiness, windowsRunVerified } from '../scripts/release-readiness.mjs';

type Blocker = { code: string };
type R = { betaDistributable: boolean; channel: string; signed: boolean; blockers: Blocker[] };

const PASS = '| # | 항목 | 결과 |\n|---|---|---|\n| 4 | 설치·첫 실행 | ✅ 미서명 설치본 설치, 첫 실행 통과(SmartScreen 경고 뒤 실행) |\n';
const unsigned = { mode: 'unsigned', reason: '인증서 없음', missing: ['AZURE_TENANT_ID'] };
const signed = { mode: 'azure' };
const base = { publisherName: 'CN=Test', devOnly: [] as string[], outside: [] as string[], testBuild: false };
const judge = (o: Record<string, unknown>): R => readiness({ ...base, ...o }) as R;
const codes = (r: R) => r.blockers.map((b) => b.code);

describe('betaDistributable 채널별 판정표', () => {
  // [채널, 서명, 실기기 보고서, 기대 betaDistributable, 기대 블로커]
  const table: Array<[string, typeof unsigned | typeof signed, string | null, boolean, string[]]> = [
    ['beta', unsigned, PASS, true, []],
    ['beta', signed, PASS, true, []],
    ['beta', unsigned, null, false, ['windows_run_unverified']],
    ['stable', unsigned, PASS, false, ['unsigned_build']],
    ['stable', signed, PASS, true, []],
    ['stable', unsigned, null, false, ['unsigned_build', 'windows_run_unverified']],
    ['stable', signed, null, false, ['windows_run_unverified']],
  ];
  for (const [channel, signing, report, ok, want] of table) {
    it(`${channel}·${signing.mode}·보고서 ${report ? '통과' : '없음'} → ${ok}`, () => {
      const r = judge({ channel, signing, winReport: report });
      assert.equal(r.betaDistributable, ok);
      assert.deepEqual(codes(r), want);
      assert.equal(r.signed, signing.mode === 'azure', '미서명 beta는 통과해도 signed:false');
      assert.equal(r.channel, channel);
    });
  }

  it('채널과 상관없이 다른 블로커는 그대로 막는다', () => {
    for (const channel of ['beta', 'stable']) {
      const r = judge({ channel, signing: signed, winReport: PASS, publisherName: '', devOnly: ['demo.js'], outside: ['tokens.js'], testBuild: true });
      assert.equal(r.betaDistributable, false);
      assert.deepEqual(codes(r), ['publisher_dn_unset', 'dev_only_code_included', 'runtime_reads_outside_app', 'test_build']);
    }
  });

  it('모르는 채널은 판정하지 않는다(실패 닫힘)', () => {
    assert.throws(() => judge({ channel: 'nightly', signing: signed, winReport: PASS }), /알 수 없는 채널/);
  });
});

describe('WIN-REALDEVICE.md 설치·첫 실행 표시', () => {
  const row = (item: string, result: string) => `| # | 항목 | 결과 |\n|---|---|---|\n| 4 | ${item} | ${result} |\n`;
  it('요약 표의 `설치·첫 실행` 행이 ✅로 시작하면 통과', () => {
    assert.equal(windowsRunVerified(PASS), true);
    assert.equal(windowsRunVerified(PASS.replaceAll('\n', '\r\n')), true, 'CRLF');
  });
  it('그 밖은 통과가 아니다', () => {
    assert.equal(windowsRunVerified(null), false, '보고서 없음');
    assert.equal(windowsRunVerified(''), false);
    assert.equal(windowsRunVerified(row('설치·첫 실행', '⏳ 보류')), false);
    assert.equal(windowsRunVerified(row('설치·첫 실행', '❌ 설치 실패')), false);
    assert.equal(windowsRunVerified(row('설치·첫 실행', '✅ 설치 통과. ⚠️ 첫 실행 확인 못 함')), false, '경고 섞임');
    assert.equal(windowsRunVerified(row('설치', '✅ 통과')), false, '항목 이름이 정확해야 한다');
    assert.equal(windowsRunVerified('설치·첫 실행 ✅ (표 밖 문장)'), false, '표 밖');
    assert.equal(windowsRunVerified(PASS + '| 5 | 설치·첫 실행 | ❌ 재시험 실패 |\n'), false, '행이 둘이면 통과가 아니다');
  });
});
