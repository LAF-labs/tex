import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { MockOnboardingPorts } from '../apps/desktop/src/onboarding-mock.ts';
import { OnboardingFlow, onboardingTodos, parseOnbState, type OnbAnswer, type OnbProfile } from '../apps/desktop/src/onboarding.ts';
import { CERT_OTHER_TEXT, interpret, parseRegex, SETUP_LABEL, setupMissing, setupText } from '../apps/desktop/src/shell-model.ts';
import { CERT_NOTE, NOTE, ShellRuns, UNKNOWN_STOP_NOTE } from '../apps/desktop/src/shell-runs.ts';

const NOW = () => new Date('2026-11-10T01:00:00.000Z');
const walk = async (f: OnboardingFlow, as: OnbAnswer[]) => {
  for (const a of as) await f.answer(a);
};
async function skippedBoth() {
  const profiles: OnbProfile[] = [];
  const ports = Object.assign(new MockOnboardingPorts({ saveProfile: async (p) => void profiles.push(p) }), { profiles });
  const flow = new OnboardingFlow(ports, null, NOW);
  await walk(flow, [
    { step: 'terms', choice: 'agree' },
    { step: 'welcome', choice: 'later' },
    { step: 'auth', choice: 'later' },
    { step: 'first', choice: 'later' },
  ]);
  assert.deepEqual(flow.state.skipped, ['biz']);
  const legacy = { ...flow.state, auth: null, certId: null, skipped: ['biz', 'auth'] } as unknown as typeof flow.state;
  return { ports, flow: new OnboardingFlow(ports, legacy, NOW) };
}

describe('카드 전 검사: 무엇이 빠졌는지', () => {
  it('사업자번호·발급 인증', () => {
    assert.deepEqual(setupMissing({ kind: 'business', name: '내 사업장', email: '', auth: '' }), ['biz', 'auth']);
    assert.deepEqual(setupMissing({ kind: 'business', name: 'A', bizNo: '1234567891', email: '', auth: '발급 인증 미설정' }), ['auth']);
    assert.deepEqual(setupMissing({ kind: 'business', name: 'A', email: '', auth: '공동·금융인증서' }), ['biz']);
    assert.deepEqual(setupMissing({ kind: 'business', name: 'A', bizNo: '1234567891', email: '', auth: '사업자 간편인증(카카오뱅크)' }), []);
  });
  it('발급 인증이 비어 있는 프로필(되돌린 보안카드 포함)은 "고르지 않음"으로 보이고 다시 고르게 한다(대표 결정 2026-11-19)', () => {
    const app = fs.readFileSync(new URL('../apps/desktop/src/shell-app.ts', import.meta.url), 'utf8');
    assert.match(app, /auth: p\.signMethod \? SIGN_LABEL\[p\.signMethod\] : NO_AUTH \}/);
    assert.deepEqual(setupMissing({ kind: 'business', name: 'A', bizNo: '1234567891', email: '', auth: '발급 인증 미설정' }), ['auth']);
    assert.match(setupText('invoice', ['auth']), /공동인증서·간편인증/);
    assert.doesNotMatch(setupText('invoice', ['auth']), /보안카드/);
    const ui = fs.readFileSync(new URL('../apps/desktop/static/shell/shell.js', import.meta.url), 'utf8');
    const desc = ui.slice(ui.indexOf('const AUTH_DESC = {'), ui.indexOf('};', ui.indexOf('const AUTH_DESC = {')));
    assert.ok(!desc.includes('보안카드') && !desc.includes('발급 인증 미설정'), '설명 표에 없는 값이면 고르지 않은 것으로 그린다');
    assert.match(ui, /desc \? auth : '발급 인증을 아직 고르지 않았어요'/);
  });
  it('안내 문장은 빠진 것을 말한다, 버튼 이름', () => {
    assert.match(setupText('invoice', ['biz']), /^세금계산서를 발급하려면 먼저 사업자 정보\(사업자번호\)를 등록해 주세요/);
    assert.match(setupText('invoice', ['biz', 'auth']), /사업자 정보와 발급 인증/);
    assert.match(setupText('cert', ['auth']), /^증명서를 떼려면 .*인증/);
    assert.deepEqual(SETUP_LABEL, { biz: '사업자 등록 마치기', auth: '발급 인증 고르기', chrome: 'Chrome 설치하기', security: '보안 프로그램 설치하기' });
    assert.equal(setupText('invoice', ['security']), '세금계산서를 발급하려면 먼저 홈택스 공동인증서 프로그램(MagicLine4NX)을 설치하거나 켜 주세요.');
    assert.match(setupText('invoice', ['chrome', 'security']), /Chrome을 설치해 주세요\..*MagicLine4NX\)도 켜 주세요\.$/);
  });
  it('Chrome(U6): 빠지면 그것만 말하거나 뒤에 한 문장을 붙인다', () => {
    assert.equal(setupText('invoice', ['chrome']), '세금계산서를 발급하려면 먼저 이 PC에 Chrome을 설치해 주세요. 홈택스 작업은 Chrome 창에서 해요.');
    assert.equal(setupText('invoice', ['biz', 'chrome']), '세금계산서를 발급하려면 먼저 사업자 정보(사업자번호)를 등록해 주세요. Chrome도 설치해 주세요.');
    assert.match(setupText('cert', ['auth', 'chrome']), /^증명서를 떼려면 .*인증.*Chrome도 설치해 주세요\.$/);
  });
  it('Chrome(U6) 배선: 판의 할 일·첫 발급 요청·[홈택스에서 준비]가 같은 점검, [다시 확인]은 chrome.check(읽기만, 판을 새로)', () => {
    const src = fs.readFileSync(new URL('../apps/desktop/src/shell-app.ts', import.meta.url), 'utf8');
    assert.match(src, /const chromeReady = opts\.chromeReady \?\? \(\(\) => (?:embedded \|\| )?findInstalledChrome\(\) !== null\);/);
    assert.match(src, /new ShellRuns\(host, \{ [^}]*chromeReady, /);
    assert.match(src, /profile === 'business' && !chromeReady\(\) \? \[\{ id: 'chrome', label: SETUP_LABEL\.chrome, view: 'chrome' as const \}\]/);
    assert.match(src, /const needsHometax = parsed\.intent !== 'cert' \|\| \(!!parsed\.cert && !certDocByCode\(parsed\.cert\)\?\.hidden\);/);
    assert.match(src, /const needsChrome = needsHometax && !chromeReady\(\);/);
    assert.match(src, /const missing: SetupItem\[\] = \[\.\.\.setupMissing\(profiles\(\)\.business\), \.\.\.\(needsChrome \? \(\['chrome'\] as const\) : \[\]\), \.\.\.\(needsSecurity \? \(\['security'\] as const\) : \[\]\)\];/);
    assert.match(src, /const securityMissing = \(\) => profile === 'business' && profiles\(\)\.business\.auth === SIGN_LABEL\.cert && securityBlocks\(securityNow\(\)\);/);
    assert.match(src, /const needsSecurity = needsHometax && securityMissing\(\);/);
    const check = src.slice(src.indexOf("'chrome.check': async"), src.indexOf("'onboarding.reopen': async"));
    assert.ok(check.includes('const ready = chromeReady();') && check.includes('pushBoard();') && !/host\.|needGesture|openExternal/.test(check), check);
    const shell = fs.readFileSync(new URL('../apps/desktop/static/shell/shell.js', import.meta.url), 'utf8');
    assert.match(shell, /if \(item === 'chrome'\) return chromeGuide\(\);/);
    assert.match(shell, /const r = await call\('chrome\.check'\);/);
    assert.ok(!/openExternal|window\.open|href:/.test(shell.slice(shell.indexOf('function chromeGuide'), shell.indexOf('async function reopenSetup'))));
  });
  it('배선: 세 경로(제품·시연 모델·시연 정규식) 모두 카드(interpret) 전에 setupGate, 렌더러는 kind setup → [사업자 등록 마치기] → onboarding.reopen', () => {
    const src = fs.readFileSync(new URL('../apps/desktop/src/shell-app.ts', import.meta.url), 'utf8');
    const send = src.slice(src.indexOf("'request.send': async"), src.indexOf("'draft.update':"));
    assert.equal((send.match(/setupGate\(/g) ?? []).length, 4);
    assert.match(send, /if \(profile === 'business' && local\.cert\) return \(certDocByCode\(local\.cert\)\?\.hidden \? null : setupGate\(local\)\) \?\? finishReply\(interpret\(/);
    assert.match(send, /const gate = setupGate\(to\.parsed\);\s*if \(gate\) return \{ \.\.\.gate, via, note: to\.note, sent \};\s*return finishReply\(interpret\(/);
    assert.match(src, /if \(!\(parsed\.intent === 'invoice' \|\| parsed\.intent === 'cert' \|\| answersPending\(parsed, runs\)\)\) return null;/);
    const shell = fs.readFileSync(new URL('../apps/desktop/static/shell/shell.js', import.meta.url), 'utf8');
    assert.match(shell, /if \(r\.kind === 'setup'\) \{/);
    assert.match(shell, /const r = await call\('onboarding\.reopen', \{ item \}\);/);
    assert.match(shell, /x\.id === 'biz' \|\| x\.id === 'auth' \|\| x\.id === 'chrome' \|\| x\.id === 'security' \? reopenSetup\(x\.id\) : go\(x\.view\)/);
    assert.match(shell, /if \(item === 'security'\) return securityGuide\(\);/);
  });
  it('[홈택스에서 준비]만 실행을 시작한다(카드를 만들 때 run.prepare를 부르지 않는다, 실제 입력 2초)', () => {
    const shell = fs.readFileSync(new URL('../apps/desktop/static/shell/shell.js', import.meta.url), 'utf8');
    const views = fs.readFileSync(new URL('../apps/desktop/static/shell/shell-views.js', import.meta.url), 'utf8');
    assert.equal((shell.match(/'run\.prepare'/g) ?? []).length, 1);
    assert.equal((views.match(/act\.prepare\(/g) ?? []).length, 2);
    assert.match(views, /btn\('홈택스에서 준비', \(\) => act\.prepare\(run\.id\)/);
    assert.match(views, /btn\('홈택스에서 떼기', \(\) => act\.prepare\(run\.id\)/);
    const src = fs.readFileSync(new URL('../apps/desktop/src/shell-app.ts', import.meta.url), 'utf8');
    assert.match(src, /'run\.prepare': async \(p\) => \{\s*needGesture\(2_000\);/);
  });
});

describe('건너뛴 사업자·인증 다시 열기(reopen)', () => {
  it('사업자: O-01부터 묻고, 인증도 빠졌으면 인증, 동의는 다시 묻지 않고, 프로필을 저장하고 첫 작업 제안 없이 끝', async () => {
    const { ports, flow } = await skippedBoth();
    assert.deepEqual(flow.missing(), ['biz', 'auth']);
    assert.deepEqual(onboardingTodos(flow.state).map((t) => t.id), ['biz', 'auth']);
    const consents = ports.consents.length;
    const logLen = flow.state.log.length;
    await flow.reopen('biz');
    assert.equal(flow.state.step, 'welcome');
    assert.equal(flow.state.redo, 'biz');
    assert.equal(flow.state.redoFrom, logLen);
    await walk(flow, [
      { step: 'welcome', choice: 'upload' },
      { step: 'biz-confirm', choice: 'confirm' },
    ]);
    assert.equal(flow.state.step, 'auth', '인증도 빠졌으면 인증');
    await flow.answer({ step: 'auth', choice: 'simple' });
    assert.equal(flow.state.step, 'done', '동의·요약을 다시 묻지 않는다');
    assert.equal(flow.state.redo, null);
    assert.deepEqual(flow.missing(), []);
    assert.equal(ports.consents.length, consents, '동의 기록이 늘지 않는다');
    assert.equal(ports.profiles.at(-1)?.signMethod, 'simple_auth');
    assert.ok(ports.profiles.at(-1)?.bizNo);
    assert.deepEqual(onboardingTodos(flow.state).map((t) => t.id), []);
    assert.ok(parseOnbState(JSON.parse(JSON.stringify(flow.state))));
  });
  it('인증만: O-03 → 금융인증서도 바로 끝(① 위임 없음), 보안카드는 고를 수 없다(대표 결정 2026-11-19)', async () => {
    const { flow } = await skippedBoth();
    await flow.reopen('auth');
    assert.equal(flow.state.step, 'auth');
    await assert.rejects(flow.answer({ step: 'auth', choice: 'card' as never }), /bad_choice/);
    await flow.answer({ step: 'auth', choice: 'fincert' });
    assert.equal(flow.state.step, 'done');
  });
  it('다시 연 단계에서 또 [나중에]면 끝으로 돌아간다(할 일은 남는다)', async () => {
    const { flow } = await skippedBoth();
    await flow.reopen('biz');
    await flow.answer({ step: 'welcome', choice: 'later' });
    assert.equal(flow.state.step, 'done');
    assert.deepEqual(flow.missing(), ['biz', 'auth']);
    await flow.reopen('auth');
    await flow.answer({ step: 'auth', choice: 'later' });
    assert.equal(flow.state.step, 'done');
  });
  it('끝나지 않았거나 빠진 것이 아니면 거부', async () => {
    const ports = new MockOnboardingPorts({ saveProfile: async () => {} });
    const flow = new OnboardingFlow(ports, null, NOW);
    await assert.rejects(flow.reopen('biz'), /onboarding_not_done/);
    const { flow: f2 } = await skippedBoth();
    await f2.reopen('auth');
    await f2.answer({ step: 'auth', choice: 'simple' });
    assert.equal(f2.state.step, 'done');
    assert.deepEqual((await f2.reopen('auth')).state.redoPrev, { auth: 'simple', certId: null });
    assert.equal(parseOnbState({ ...f2.state, redo: 'x' }), null);
    assert.equal(parseOnbState({ ...f2.state, redoFrom: -1 }), null);
  });
});

describe('멈춤 문구에 내부 코드가 보이지 않는다', () => {
  it('엔진이 던지는 RunEnd 코드는 표에 사람 말로 있고, 모르는 코드는 일반 문구', () => {
    const engine = ['runs.ts', 'h01/runner.ts', 'policy.ts', 'ir/runner.ts', 'browser.ts']
      .map((f) => new URL(`../packages/engine/src/${f}`, import.meta.url))
      .filter((u) => fs.existsSync(u))
      .map((u) => fs.readFileSync(u, 'utf8'))
      .join('\n');
    const codes = new Set([...engine.matchAll(/RunEnd\(\s*'[a-z_]+',\s*'([a-z_.]+)'/g), ...engine.matchAll(/fail\('([a-z_.]+)'/g)].map((m) => m[1]!));
    assert.ok(codes.size > 20, String(codes.size));
    const missing = [...codes].filter((c) => !NOTE[c]);
    assert.deepEqual(missing, [], '표에 없는 엔진 코드');
    for (const [k, v] of Object.entries(NOTE)) assert.ok(!/[a-z]+[._][a-z]/.test(v!), `${k}: 문구에 코드 모양이 있다 → ${v}`);
    assert.ok(Object.keys(CERT_NOTE).length > 0);
    for (const [k, v] of Object.entries(CERT_NOTE)) assert.ok(!/[a-z]+[._][a-z]/.test(v), `${k}: 민원증명 문구에 코드 모양이 있다 → ${v}`);
    assert.ok(!/[a-z_]+\.[a-z_]+|\(/.test(UNKNOWN_STOP_NOTE));
    const src = fs.readFileSync(new URL('../apps/desktop/src/shell-runs.ts', import.meta.url), 'utf8');
    assert.match(src, /const note = \(code\?: string, r\?: RunView\) => \(code && \(\(r\?\.cert && CERT_NOTE\[code\]\) \|\| NOTE\[code\]\)\) \|\| UNKNOWN_STOP_NOTE;/);
    assert.doesNotMatch(src, /멈췄어요\(\$\{code\}\)/);
  });
});

describe('출시판에서 숨긴 민원증명(cert-docs hidden, H-04)', () => {
  it('「납세증명서 떼 줘」는 증명서 의도로 읽되 카드를 만들지 않고 「떼지 못해요」로 답한다(설치 안내·실행 없음)', () => {
    const runs = new ShellRuns({ control: async () => ({}), on: () => {} } as never, { counterparties: () => [], auth: () => '' });
    const parsed = parseRegex('납세증명서 떼 줘', []);
    assert.deepEqual([parsed.intent, parsed.cert], ['cert', 'H-04']);
    assert.deepEqual(interpret('납세증명서 떼 줘', null, 'business', runs, parsed), { kind: 'say', text: CERT_OTHER_TEXT });
    assert.ok(!CERT_OTHER_TEXT.includes('납세증명서'), '「바로 뗄 수 있어요」 목록에 숨긴 서류가 없다');
  });
});
