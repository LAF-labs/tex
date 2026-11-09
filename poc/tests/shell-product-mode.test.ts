// 제품(엔진 모드) 셸은 견본 데이터를 보이지 않는다(팀장 2026-11-09 "설치본으로 직접 써 볼 수 있게"). 시연(fixture)은 그대로다.
// 엔진 모드는 금고 utilityProcess·OS 키체인을 쓰므로 여기서는 소스로 경계를 본다(동작은 fixture e2e와 설치본 수동 확인).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

const src = fs.readFileSync(new URL('../apps/desktop/src/shell-app.ts', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../apps/desktop/static/shell/shell.js', import.meta.url), 'utf8');

describe('제품 모드: 견본 데이터 없음', () => {
  it('견본 대화·빠른 실행·견본 표시·정부24 견본 후보는 fixture에서만', () => {
    assert.match(src, /timeline: fixture \? seedTimeline\(\) : \[\],/);
    assert.match(src, /quick: fixture \? QUICK : QUICK\.filter\(/);
    assert.match(src, /sample: !!fixture,/);
    assert.match(src, /'g24\.candidates': \(p\) => \(fixture \? g24Candidates\(/);
    assert.match(js, /state\.boot\?\.sample === false \? null : h\('span', \{ class: 'mock-badge' \}, '견본 데이터 · PoC 데모'\)/);
  });
  it('견본 서류·견본 사업장 없음, 꾸러미·카드 목업 칸 없음', () => {
    assert.match(src, /if \(opts\.engine\) store\.docs\.length = 0;/);
    assert.match(src, /fixture \? \{ business: business \?\? PROFILES\.business, personal: PROFILES\.personal \} : \{ business: business \?\? NO_BUSINESS, personal: NO_PERSONAL \}/);
    assert.match(src, /bundle: fixture \? mockBundle\(today\) : null,/);
    assert.match(src, /cardEnabled: !!fixture,/);
  });
  it('온보딩: 진위확인은 견본 결과 대신 조회하지 못함, 보안카드 등록은 지금은 할 수 없음(견본 등록 없음)', () => {
    assert.match(src, /checkBizNo: async \(\) => \(\{ status: 'unknown', label: '조회하지 못했어요'/);
    assert.match(src, /registerSecrets: async \(\) => \(\{ ok: false, reason: 'unavailable' \}\),/);
    // 제품 쪽 바깥 일 묶음에 onbMock.checkBizNo·registerSecrets가 남지 않는다
    const product = src.slice(src.indexOf('const onbExternal: OnboardingExternal = fixture'), src.indexOf('const onbPorts = onboardingPorts('));
    assert.ok(!product.includes('onbMock.checkBizNo') && !product.includes('onbMock.registerSecrets'));
  });
});
