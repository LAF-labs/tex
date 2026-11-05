// M5-1 게이트 우회 회귀 CE-7~16(D13 §7, D02 §6.2 반례 표). 반례마다 두 반쪽이 있다:
//   정적: 검증기·핫픽스 CI·내장 상한이 거부한다 — 엔진 M1-4 시험(core-validate·core-selector-ci)이 이미 고정한다. 여기서는 그 시험이
//         이름 그대로 있고 skip·todo가 아닌지 본다(승격 점검 (가)와 같은 함수). 시험을 지우거나 이름을 바꾸면 이 스위트가 빨개진다.
//   실행: 검증을 통과한 패키지라도 런타임(스텝 핸들러·Actuator·게이트 토큰)이 같은 우회를 막는다 — 엔진 M2-1~M2-4 뒤. 지금은 todo.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CAPTCHA_RELAY_CEILING, MODE_ORDER, PORTAL_MODE_CEILING } from '@sax/engine/core';
// @ts-expect-error 타입 선언 없는 .mjs 스크립트
import { checkRef } from '../../scripts/ci-promotion-check.mjs';

interface Ce {
  id: string;
  what: string;
  rule: string;
  /** 정적 반쪽 시험(`파일 > 이름 일부`). */
  staticTests: string[];
  /** 실행 반쪽(아직 없는 것): 무엇을, 어느 M 항목 뒤에. */
  runtime: string;
}

export const CE: readonly Ce[] = [
  { id: 'CE-7', what: '비밀 칸을 extract해 다른 칸에 fill', rule: 'V-20', staticTests: ['tests/core-validate.test.ts > CE-7 비밀 칸 extract'], runtime: 'Actuator DOM 읽기가 secretKind·type=password 요소 value를 읽지 않는다(V-20 런타임 가드) — M2-1·M2-4' },
  { id: 'CE-8', what: '비밀 칸 랜드마크를 포함하는 decide.scope', rule: 'V-20', staticTests: ['tests/core-validate.test.ts > CE-8 비밀 칸 랜드마크'], runtime: 'decide 관측 추출이 비밀 칸 서브트리를 넣지 않는다(마스킹 트리 + 금고 AX 정리) — M2-2' },
  { id: 'CE-9', what: '타깃 없는 press Enter로 폼 암묵 제출', rule: '스키마, V-03k', staticTests: ['tests/core-validate.test.ts > CE-9 타깃 없는 press Enter'], runtime: 'press 핸들러가 타깃 없는 키 입력을 거부하고 커밋 랜드마크 포커스 중 Enter를 막는다 — M2-1' },
  { id: 'CE-10', what: '게이트 하나가 독립 submit 둘을 authorizes', rule: 'V-03i', staticTests: ['tests/core-validate.test.ts > CE-10 게이트 하나가 독립 submit 둘'], runtime: '게이트 토큰 1개는 비가역 1회만 무장(원장 PK (intent_id, step_id)) — M2-3' },
  { id: 'CE-11', what: '커밋 랜드마크 fieldKey 누락 readback', rule: 'V-03j', staticTests: ['tests/core-validate.test.ts > CE-11 커밋 랜드마크 fieldKey 누락'], runtime: 'readback이 승인 바에 보인 칸과 제출 직전 DOM을 대조(R-C1) — M2-3' },
  { id: 'CE-12', what: 'nameTemplate에 허용 밖 토큰', rule: 'V-23', staticTests: ['tests/core-validate.test.ts > CE-12 nameTemplate'], runtime: 'save_pdf 파일 이름 렌더러가 허용 토큰 밖을 거부 — M2-3' },
  { id: 'CE-13', what: 'expectConfirm: ".*"', rule: 'V-24', staticTests: ['tests/core-validate.test.ts > CE-13 expectConfirm'], runtime: '대화상자 정책이 문구 불일치 확인창을 누르지 않는다 — M2-4' },
  { id: 'CE-14', what: '조회 하위 플레이북의 decide', rule: 'V-22', staticTests: ['tests/core-validate.test.ts > CE-14 조회 하위 플레이북'], runtime: 'verify가 부르는 조회 실행기에서 decide·커밋 타깃 클릭이 거부 — M2-3' },
  { id: 'CE-15', what: '핫픽스의 commits:true 항목·랜드마크 항목 변경', rule: 'SV-01·적격 조건·R-A1·R-A2', staticTests: ['tests/core-selector-ci.test.ts > CE-15 commits:true 항목', 'tests/core-selector-ci.test.ts > CE-15 비커밋 항목 후보를 발급 버튼'], runtime: 'Actuator 커밋 그림자(R-A1·R-A2)가 핫픽스 적용 뒤에도 비커밋 스텝의 커밋 요소 클릭을 막는다 — M2-4' },
  { id: 'CE-16', what: '정책 gov24: auto', rule: '내장 상한 PORTAL_MODE_CEILING', staticTests: [], runtime: '정책 로더가 서명된 정책의 portalMode를 내장 상한으로 접고 gov24 자동화를 시작하지 않는다 — M1-4 뒷절반(정책 로더)·M2-4' },
];

describe('M5-1 게이트 우회 CE-7~16: 정적 반쪽 시험이 있다', () => {
  for (const ce of CE) {
    if (!ce.staticTests.length) continue;
    it(`${ce.id} ${ce.what} (${ce.rule})`, () => {
      for (const ref of ce.staticTests) {
        const r = checkRef(ref);
        assert.ok(r.ok, `${ce.id} 정적 회귀 시험 ${ref}: ${r.problem}`);
      }
    });
  }
});

describe('M5-1 게이트 우회 CE-16: 내장 상한(앱 업데이트로만 바뀐다)', () => {
  it('gov24는 postprocess·캡차 중계 disabled_until_permission, hometax만 auto(정부24 자동화 금지)', () => {
    assert.equal(PORTAL_MODE_CEILING.gov24, 'postprocess');
    assert.equal(CAPTCHA_RELAY_CEILING.gov24, 'disabled_until_permission');
    const auto = Object.entries(PORTAL_MODE_CEILING).filter(([, m]) => MODE_ORDER[m] >= MODE_ORDER.auto).map(([p]) => p);
    assert.deepEqual(auto, ['hometax']);
  });

  it('상한 표는 얼어 있어 런타임에 고칠 수 없다', () => {
    assert.ok(Object.isFrozen(PORTAL_MODE_CEILING) && Object.isFrozen(CAPTCHA_RELAY_CEILING));
    assert.throws(() => {
      (PORTAL_MODE_CEILING as Record<string, string>).gov24 = 'auto';
    }, TypeError);
    assert.equal(PORTAL_MODE_CEILING.gov24, 'postprocess');
  });
});

describe('M5-1 게이트 우회 CE-7~16: 실행 반쪽(엔진 M2 뒤)', () => {
  // TODO(M5-1): 엔진 M2-1~M2-4가 머지되면 각 항목을 "검증을 우회해 실행기에 직접 넣은 IR"로 바꾼다.
  //   방법: validatePackage를 거치지 않는 테스트 전용 로더로 반례 IR을 가짜 포털(tests/fixtures/server.ts)에서 돌리고,
  //   포털이 비가역 요청(/submit)을 받지 않았는지·게이트 원장이 비어 있는지·실행이 어느 코드로 끝났는지 본다.
  for (const ce of CE) it.todo(`${ce.id} 실행: ${ce.runtime}`);
});
