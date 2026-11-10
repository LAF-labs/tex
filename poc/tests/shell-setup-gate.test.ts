// 발급에 필요한 등록이 빠졌을 때(0.1.5 실사용: 사업자를 건너뛴 채 세금계산서 카드가 "멈췄어요(profile_missing)"):
// 카드 전에 막는 검사(setupMissing·setupText·setupGate 배선), 건너뛴 단계 다시 열기(OnboardingFlow.reopen), 멈춤 문구에 내부 코드 없음.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { MockOnboardingPorts } from '../apps/desktop/src/onboarding-mock.ts';
import { OnboardingFlow, onboardingTodos, parseOnbState, type OnbAnswer, type OnbProfile } from '../apps/desktop/src/onboarding.ts';
import { SETUP_LABEL, setupMissing, setupText } from '../apps/desktop/src/shell-model.ts';
import { NOTE, UNKNOWN_STOP_NOTE } from '../apps/desktop/src/shell-runs.ts';

const NOW = () => new Date('2026-11-10T01:00:00.000Z');
const walk = async (f: OnboardingFlow, as: OnbAnswer[]) => {
  for (const a of as) await f.answer(a);
};
/** 사업자·인증을 둘 다 건너뛰고 끝낸 온보딩 */
async function skippedBoth() {
  const profiles: OnbProfile[] = [];
  const ports = Object.assign(new MockOnboardingPorts({ saveProfile: async (p) => void profiles.push(p) }), { profiles });
  const flow = new OnboardingFlow(ports, null, NOW);
  await walk(flow, [
    { step: 'terms', choice: 'agree' },
    { step: 'welcome', choice: 'later' },
    { step: 'auth', choice: 'later' },
    { step: 'model', choice: 'agree' },
    { step: 'telemetry', choice: 'off' },
    { step: 'tasks', choice: 'later' },
    { step: 'summary', choice: 'ok' },
    { step: 'first', choice: 'later' },
  ]);
  return { ports, flow };
}

describe('카드 전 검사: 무엇이 빠졌는지', () => {
  it('사업자번호·발급 인증', () => {
    assert.deepEqual(setupMissing({ kind: 'business', name: '내 사업장', email: '', auth: '' }), ['biz', 'auth']);
    assert.deepEqual(setupMissing({ kind: 'business', name: 'A', bizNo: '1234567891', email: '', auth: '발급 인증 미설정' }), ['auth']);
    assert.deepEqual(setupMissing({ kind: 'business', name: 'A', email: '', auth: '보안카드' }), ['biz']);
    assert.deepEqual(setupMissing({ kind: 'business', name: 'A', bizNo: '1234567891', email: '', auth: '사업자 간편인증(카카오뱅크)' }), []);
  });
  it('안내 문장은 빠진 것을 말한다, 버튼 이름', () => {
    assert.match(setupText('invoice', ['biz']), /^세금계산서를 발급하려면 먼저 사업자 정보\(사업자번호\)를 등록해 주세요/);
    assert.match(setupText('invoice', ['biz', 'auth']), /사업자 정보와 발급 인증/);
    assert.match(setupText('cert', ['auth']), /^증명서를 떼려면 .*인증/);
    assert.deepEqual(SETUP_LABEL, { biz: '사업자 등록 마치기', auth: '발급 인증 고르기' });
  });
  it('배선: 세 경로(제품·시연 모델·시연 정규식) 모두 카드(interpret) 전에 setupGate, 렌더러는 kind setup → [사업자 등록 마치기] → onboarding.reopen', () => {
    const src = fs.readFileSync(new URL('../apps/desktop/src/shell-app.ts', import.meta.url), 'utf8');
    const send = src.slice(src.indexOf("'request.send': async"), src.indexOf("'draft.update':"));
    assert.equal((send.match(/setupGate\(/g) ?? []).length, 3);
    assert.match(send, /const gate = setupGate\(to\.parsed\);\s*if \(gate\) return \{ \.\.\.gate, via, note: to\.note, sent \};\s*return finishReply\(interpret\(/);
    assert.match(src, /if \(!\(parsed\.intent === 'invoice' \|\| parsed\.intent === 'cert' \|\| answersPending\(parsed, runs\)\)\) return null;/);
    const shell = fs.readFileSync(new URL('../apps/desktop/static/shell/shell.js', import.meta.url), 'utf8');
    assert.match(shell, /if \(r\.kind === 'setup'\) \{/);
    assert.match(shell, /const r = await call\('onboarding\.reopen', \{ item \}\);/);
    assert.match(shell, /x\.id === 'biz' \|\| x\.id === 'auth' \? reopenSetup\(x\.id\) : go\(x\.view\)/);
  });
  it('[홈택스에서 준비]만 실행을 시작한다(카드를 만들 때 run.prepare를 부르지 않는다, 실제 입력 2초)', () => {
    const shell = fs.readFileSync(new URL('../apps/desktop/static/shell/shell.js', import.meta.url), 'utf8');
    const views = fs.readFileSync(new URL('../apps/desktop/static/shell/shell-views.js', import.meta.url), 'utf8');
    assert.equal((shell.match(/'run\.prepare'/g) ?? []).length, 1);
    assert.equal((views.match(/act\.prepare\(/g) ?? []).length, 1);
    assert.match(views, /btn\('홈택스에서 준비', \(\) => act\.prepare\(run\.id\)/);
    const src = fs.readFileSync(new URL('../apps/desktop/src/shell-app.ts', import.meta.url), 'utf8');
    assert.match(src, /'run\.prepare': async \(p\) => \{\s*needGesture\(2_000\);/);
  });
});

describe('건너뛴 사업자·인증 다시 열기(reopen)', () => {
  it('사업자: O-01부터 묻고, 인증도 빠졌으면 인증, 동의는 다시 묻지 않고, 요약(프로필 저장) 뒤 첫 작업 제안 없이 끝', async () => {
    const { ports, flow } = await skippedBoth();
    assert.deepEqual(flow.missing(), ['biz', 'auth']);
    assert.deepEqual(onboardingTodos(flow.state).map((t) => t.id), ['biz', 'auth', 'tasks']);
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
    assert.equal(flow.state.step, 'summary', '②③은 다시 묻지 않는다');
    await flow.answer({ step: 'summary', choice: 'ok' });
    assert.equal(flow.state.step, 'done');
    assert.equal(flow.state.redo, null);
    assert.deepEqual(flow.missing(), []);
    assert.equal(ports.consents.length, consents, '동의 기록이 늘지 않는다');
    assert.equal(ports.profiles.at(-1)?.signMethod, 'simple_auth');
    assert.ok(ports.profiles.at(-1)?.bizNo);
    assert.deepEqual(onboardingTodos(flow.state).map((t) => t.id), ['tasks']);
    // 저장된 상태도 다시 읽힌다
    assert.ok(parseOnbState(JSON.parse(JSON.stringify(flow.state))));
  });
  it('인증만: O-03 → 보안카드면 ① 위임 → 요약으로', async () => {
    const { flow } = await skippedBoth();
    await flow.reopen('auth');
    assert.equal(flow.state.step, 'auth');
    await flow.answer({ step: 'auth', choice: 'card' });
    assert.equal(flow.state.step, 'delegation');
    await flow.answer({ step: 'delegation', choice: 'agree' });
    assert.equal(flow.state.step, 'summary');
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
    // biz는 아직 건너뜀 → summary(프로필 저장 없음) → done
    await f2.answer({ step: 'summary', choice: 'ok' });
    await assert.rejects(f2.reopen('auth'), /nothing_to_reopen/);
    assert.equal(parseOnbState({ ...f2.state, redo: 'x' }), null);
    assert.equal(parseOnbState({ ...f2.state, redoFrom: -1 }), null);
  });
});

describe('멈춤 문구에 내부 코드가 보이지 않는다', () => {
  it('엔진이 던지는 RunEnd 코드는 표에 사람 말로 있고, 모르는 코드는 일반 문구', () => {
    const engine = ['runs.ts', 'h01/runner.ts', 'policy.ts', 'ir/runner.ts']
      .map((f) => new URL(`../packages/engine/src/${f}`, import.meta.url))
      .filter((u) => fs.existsSync(u))
      .map((u) => fs.readFileSync(u, 'utf8'))
      .join('\n');
    const codes = new Set([...engine.matchAll(/RunEnd\(\s*'[a-z_]+',\s*'([a-z_.]+)'/g), ...engine.matchAll(/fail\('([a-z_.]+)'/g)].map((m) => m[1]!));
    assert.ok(codes.size > 20, String(codes.size));
    const missing = [...codes].filter((c) => !NOTE[c]);
    assert.deepEqual(missing, [], '표에 없는 엔진 코드');
    for (const [k, v] of Object.entries(NOTE)) assert.ok(!/[a-z]+[._][a-z]/.test(v!), `${k}: 문구에 코드 모양이 있다 → ${v}`);
    assert.ok(!/[a-z_]+\.[a-z_]+|\(/.test(UNKNOWN_STOP_NOTE));
    const src = fs.readFileSync(new URL('../apps/desktop/src/shell-runs.ts', import.meta.url), 'utf8');
    assert.match(src, /const note = \(code\?: string\) => \(code && NOTE\[code\]\) \|\| UNKNOWN_STOP_NOTE;/);
    assert.doesNotMatch(src, /멈췄어요\(\$\{code\}\)/);
  });
});
