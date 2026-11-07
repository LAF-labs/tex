// ADR-039 fixture 출처 허가(팀장 결정 2026-11-07): 액추에이터·goto 핸들러의 출처 판정은 제품의 마지막 방어선이다.
// 허용 목록을 넓히지 않고, fixture 패키지 실행일 때만 loader.fixtureOriginGrant 허가를 따로 주입한다. 관문은 로더 거부(결정 2 ②)와 같고
// (FIXTURE_LOAD_ALLOWED, development 조건 소스에서만 참), 제품 dist는 발급도 인정도 하지 않는다. 가짜 포트, 실제 포털 접속 없음.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BASIC_HANDLERS, FIXTURE_LOAD_ALLOWED, fixtureOriginGrant, GuardedActuator, navigationUrlProblem, newScope, stepEnv,
  type ActionPolicy, type ActResult, type FixtureOriginGrant, type GuardedActuatorInput, type LoadedPackage, type SelectorDict, type StepOf,
} from '@sax/engine/core';
import { FakeAct, FakeClock, FakePage } from './core-page-fakes.ts';

const LOOP = 'http://127.0.0.1:4100/invoice/issue';
const LOOP6 = 'http://[::1]:4100/invoice/issue';
const REAL = 'https://hometax.go.kr/invoice/issue';
const pkgOf = (portal: string, domains: string[]) => ({ files: { manifest: { portal, domains } } }) as unknown as Pick<LoadedPackage, 'files'>;
const FIX = pkgOf('fixture', ['127.0.0.1', '[::1]']);
const DICT = (portal: string): SelectorDict => ({ portal, commitEndpoints: [], knownEndpoints: [], entries: {} }) as unknown as SelectorDict;

const allow: ActionPolicy = { beforeAction: async (): Promise<ActResult> => ({ ok: true }), noteDialog: () => {} } as unknown as ActionPolicy;
const actuatorInput = (page: FakePage, raw: FakeAct, domains: string[], fixtureGrant?: FixtureOriginGrant | null): GuardedActuatorInput => ({
  driver: raw, reader: page, dict: DICT('fixture'), domains, policy: allow, events: { security: () => {}, journal: () => {} }, fixtureGrant,
});

const dist = async () => ({
  loader: (await import(new URL('../packages/engine/dist/core/loader.js', import.meta.url).href)) as {
    FIXTURE_LOAD_ALLOWED: boolean;
    fixtureOriginGrant: typeof fixtureOriginGrant;
    navigationUrlProblem: typeof navigationUrlProblem;
  },
  actuator: (await import(new URL('../packages/engine/dist/core/actuator.js', import.meta.url).href)) as { GuardedActuator: typeof GuardedActuator },
  steps: (await import(new URL('../packages/engine/dist/core/steps.js', import.meta.url).href)) as { BASIC_HANDLERS: typeof BASIC_HANDLERS; stepEnv: typeof stepEnv },
});

describe('fixture 출처 허가(ADR-039 결정 2 ②와 같은 관문)', () => {
  it('개발 조건(소스): fixture 패키지에만 허가를 낸다', () => {
    assert.equal(FIXTURE_LOAD_ALLOWED, true);
    assert.ok(fixtureOriginGrant(FIX));
    assert.equal(fixtureOriginGrant(pkgOf('hometax', ['hometax.go.kr'])), null);
  });

  it('허가가 있으면 fixture 규칙으로 바꾼다(루프백만, 실제 포털 URL은 그때도 거부). 없으면 실제 포털 규칙만', () => {
    const g = fixtureOriginGrant(FIX);
    const fixDomains = ['127.0.0.1', '[::1]'];
    assert.equal(navigationUrlProblem(LOOP, fixDomains, g), null);
    assert.equal(navigationUrlProblem(LOOP6, fixDomains, g), null);
    assert.ok(navigationUrlProblem(REAL, ['hometax.go.kr'], g), '허용 목록을 합치지 않는다');
    assert.ok(navigationUrlProblem('http://localhost:4100/', ['localhost'], g));
    assert.ok(navigationUrlProblem('http://127.0.0.1/', fixDomains, g), '포트 필수');
    assert.ok(navigationUrlProblem(LOOP, fixDomains), '허가 없음');
    assert.ok(navigationUrlProblem(LOOP, fixDomains, null));
    assert.equal(navigationUrlProblem(REAL, ['hometax.go.kr']), null);
  });

  it('로더가 발급하지 않은 허가(같은 모양의 객체)는 인정하지 않는다', () => {
    const forged = Object.freeze({ portal: 'fixture' }) as FixtureOriginGrant;
    assert.ok(navigationUrlProblem(LOOP, ['127.0.0.1'], forged));
  });

  it('GuardedActuator.goto: 허가를 주입했을 때만 루프백으로 간다. 주입하지 않으면 step.url_not_allowed(드라이버 호출 없음)', async () => {
    const page = new FakePage(new FakeClock(), []);
    const raw = new FakeAct(page);
    const withGrant = new GuardedActuator(actuatorInput(page, raw, ['127.0.0.1'], fixtureOriginGrant(FIX)));
    assert.deepEqual(await withGrant.goto(LOOP), { ok: true });
    assert.deepEqual(await withGrant.goto(REAL), { ok: false, code: 'step.url_not_allowed' });
    const without = new GuardedActuator(actuatorInput(page, raw, ['127.0.0.1']));
    assert.deepEqual(await without.goto(LOOP), { ok: false, code: 'step.url_not_allowed' });
    assert.deepEqual(raw.log, ['goto 127.0.0.1']);
  });

  it('goto 핸들러(StepEnv.fixtureGrant)도 같은 판정이다', async () => {
    const page = new FakePage(new FakeClock(), []);
    const act = new FakeAct(page);
    const env = (fixtureGrant?: FixtureOriginGrant | null) =>
      stepEnv({ page, act, clock: new FakeClock(), dict: DICT('fixture'), strings: {}, scope: newScope({ inputs: {}, profile: {}, intentId: 'i1' }), domains: ['127.0.0.1'], fixtureGrant, irreversible: new Set() });
    const s = { id: 's10', type: 'goto', url: LOOP } as StepOf<'goto'>;
    assert.deepEqual(await BASIC_HANDLERS.goto!(s, env(fixtureOriginGrant(FIX))), { t: 'next' });
    assert.deepEqual(await BASIC_HANDLERS.goto!(s, env()), { t: 'fail', code: 'step.url_not_allowed' });
  });

  it('제품 dist: 허가를 내지 않고, 소스가 낸 허가를 넘겨도 액추에이터·goto 핸들러가 루프백을 거부한다', async () => {
    const d = await dist();
    assert.equal(d.loader.FIXTURE_LOAD_ALLOWED, false);
    assert.equal(d.loader.fixtureOriginGrant(FIX), null);
    const smuggled = fixtureOriginGrant(FIX);
    assert.ok(smuggled);
    assert.ok(d.loader.navigationUrlProblem(LOOP, ['127.0.0.1'], smuggled));
    assert.equal(d.loader.navigationUrlProblem(REAL, ['hometax.go.kr'], smuggled), null, '실제 포털 규칙은 그대로');

    const page = new FakePage(new FakeClock(), []);
    const raw = new FakeAct(page);
    const act = new d.actuator.GuardedActuator(actuatorInput(page, raw, ['127.0.0.1'], smuggled));
    assert.deepEqual(await act.goto(LOOP), { ok: false, code: 'step.url_not_allowed' });
    assert.deepEqual(await act.goto(LOOP6), { ok: false, code: 'step.url_not_allowed' });
    assert.deepEqual(raw.log, [], '드라이버까지 가지 않는다');

    const env = d.steps.stepEnv({ page, act: raw, clock: new FakeClock(), dict: DICT('fixture'), strings: {}, scope: newScope({ inputs: {}, profile: {}, intentId: 'i1' }), domains: ['127.0.0.1'], fixtureGrant: smuggled, irreversible: new Set() });
    assert.deepEqual(await d.steps.BASIC_HANDLERS.goto!({ id: 's10', type: 'goto', url: LOOP } as StepOf<'goto'>, env), { t: 'fail', code: 'step.url_not_allowed' });
  });
});
