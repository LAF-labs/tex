import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

const src = fs.readFileSync(new URL('../apps/desktop/src/shell-app.ts', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../apps/desktop/static/shell/shell.js', import.meta.url), 'utf8');

describe('제품 모드: 견본 데이터 없음', () => {
  it('견본 대화·빠른 실행·견본 표시·정부24 견본 후보는 시연 견본(ShellDev.sample)에서만', () => {
    assert.match(src, /const sample = dev\?\.sample \?\? null;/);
    assert.match(src, /timeline: sample \? sample\.timeline\(\) : \[\],/);
    assert.match(src, /quick: sample \? sample\.quick : QUICK\.filter\(/);
    assert.match(src, /sample: !!sample,/);
    assert.match(src, /'g24\.candidates': \(p\) => \(sample \? sample\.g24Candidates\(/);
    assert.match(js, /\.\.\.\(state\.boot\?\.sample === false \? \[\] : \[h\('span', \{ class: 'mock-badge' \}, '견본 데이터 · PoC 데모'\)\]\)/);
  });
  it('견본 서류·견본 사업장 없음, 꾸러미·카드 견본 칸 없음, 처리자 표는 앱 내장 판', () => {
    assert.match(src, /const store: DocStore = opts\.engine \? emptyDocStore\(\) : opts\.dev!\.sample\.store\(\);/);
    assert.match(src, /sample \? \{ business: business \?\? sample\.profiles\.business, personal: sample\.profiles\.personal \} : \{ business: business \?\? NO_BUSINESS, personal: NO_PERSONAL \}/);
    assert.match(src, /bundle: sample \? sample\.bundle\(today\) : null,/);
    assert.match(src, /cardEnabled: !!sample,/);
    assert.match(src, /consentConfig: async \(\) => structuredClone\(CONSENT_CONFIG\),/);
  });
  it('온보딩: 진위확인은 견본 결과 대신 조회하지 못함, 금고 위임 등록(보안카드, 지원 안 함)은 길 자체가 없다', () => {
    assert.match(src, /checkBizNo: async \(\) => \(\{ status: 'unknown', label: '조회하지 못했어요'/);
    assert.doesNotMatch(src, /registerSecrets/);
    const product = src.slice(src.indexOf('const onbExternal: OnboardingExternal = fixture'), src.indexOf('const onbPorts = onboardingPorts('));
    assert.ok(!/onbMock|MockOnboardingPorts/.test(product));
  });
  it('레지스트리 동기화(제품만): 기동 때 기다리지 않고 한 번, 15분마다, 절전 복귀, 실행 직전(15분 넘었으면 최대 10초)', () => {
    assert.match(src, /const REGISTRY_EVERY_MS = 15 \* 60_000;/);
    assert.match(src, /if \(fixture\) return Promise\.resolve\(\);\s*return \(registryInflight \?\?= host\s*\.rpc\('registry\.sync', \{\}\)/);
    assert.match(src, /void registrySync\('boot'\);/);
    assert.match(src, /setInterval\(\(\) => void registrySync\('timer'\), REGISTRY_EVERY_MS\)/);
    assert.match(src, /const onResume = \(\) => \{[^}]*?\n\s*void registrySync\('resume'\);/);
    assert.match(src, /await registryFresh\(\);\s*(?:\/\/[^\n]*\n\s*)*await waitReverify\(\);\s*const r = await runs\.prepare\(id\);/);
    assert.match(src, /setTimeout\(r, 10_000\)/);
    assert.match(src, /clearInterval\(registryTimer\);/);
  });
});
