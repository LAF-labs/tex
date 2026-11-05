// 온보딩 상태 기계(08 §4 O-01~O-06, D14 M4-2)와 동의 화면 4종(F-06 자리표시, 팀장 승인 2026-11-05). Electron 없이 돈다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MockOnboardingPorts, MOCK_CONSENT_CONFIG } from '../apps/desktop/src/onboarding-mock.ts';
import { certExpiringSoon, CONSENT_KINDS, CONSENT_NOTICES, ONB_CHOICES, OnboardingFlow, onboardingTodos, type OnbAnswer, type OnbProfile } from '../apps/desktop/src/onboarding.ts';

const NOW = () => new Date('2026-11-05T01:00:00Z');
function make(o: Partial<ConstructorParameters<typeof MockOnboardingPorts>[0]> = {}) {
  const saved: OnbProfile[] = [];
  const ports = new MockOnboardingPorts({ saveProfile: async (p) => void saved.push(p), ...o });
  return { flow: new OnboardingFlow(ports, null, NOW), ports, saved };
}
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => e.message);
async function walk(flow: OnboardingFlow, answers: OnbAnswer[]) {
  for (const a of answers) await flow.answer(a);
}

describe('온보딩: 한 번에 하나씩', () => {
  it('처음 단계는 약관(④). 지금 단계가 아닌 답은 stale_step, 표에 없는 답은 bad_choice, 실패한 답은 상태를 바꾸지 않는다', async () => {
    const { flow } = make();
    assert.equal(flow.state.step, 'terms');
    assert.equal(await code(flow.answer({ step: 'welcome', choice: 'upload' })), 'stale_step');
    assert.equal(await code(flow.answer({ step: 'terms', choice: 'later' as never })), 'bad_choice');
    await flow.answer({ step: 'terms', choice: 'agree' });
    await flow.answer({ step: 'welcome', choice: 'number' });
    const before = flow.state;
    assert.equal(await code(flow.answer({ step: 'biz-number', choice: 'submit', fields: { bizNo: '123-45' } })), 'bad_biz_no');
    assert.equal(await code(flow.answer({ step: 'biz-number', choice: 'submit', fields: { bizNo: '123-45-67890' } })), 'bad_biz_no', '체크섬이 틀린 번호(DB profile.upsert와 같은 규칙)');
    assert.deepEqual(flow.state, before);
  });

  it('등록증 올리기 → 인식 카드(진위확인 배지·출처) → 맞아요 → 인증 고르기(이 PC 인증서 목록)', async () => {
    const { flow } = make();
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'upload' },
    ]);
    const s = flow.state;
    assert.equal(s.step, 'biz-confirm');
    assert.equal(s.biz?.name, '가나다컴퍼니');
    assert.deepEqual(s.check, { status: 'active', label: '계속사업자 · 일반과세자', taxType: '일반과세자', source: '국세청 조회' });
    await flow.answer({ step: 'biz-confirm', choice: 'edit', fields: { email: 'new@ganada.example' } });
    assert.equal(flow.state.biz?.email, 'new@ganada.example');
    await flow.answer({ step: 'biz-confirm', choice: 'confirm' });
    assert.equal(flow.state.step, 'auth');
    assert.equal(flow.state.certs.length, 2);
    assert.ok(certExpiringSoon(flow.state.certs[1]!, '2026-11-05'), '12일 뒤 만료는 경고');
  });

  it('등록증을 못 읽으면 번호 입력으로, 휴·폐업이면 확정하지 않는다(08 §4 O-02)', async () => {
    const a = make({ bizCert: null });
    await walk(a.flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'upload' },
    ]);
    assert.equal(a.flow.state.step, 'biz-number');
    assert.match(a.flow.state.notice ?? '', /읽지 못했어요/);
    const b = make({ bizStatus: 'closed' });
    await walk(b.flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'number' },
      { step: 'biz-number', choice: 'submit', fields: { bizNo: '123-45-67891' } },
    ]);
    assert.equal(b.flow.state.check?.label, '폐업자');
    assert.equal(await code(b.flow.answer({ step: 'biz-confirm', choice: 'confirm' })), 'biz_inactive');
    assert.equal(b.flow.state.step, 'biz-confirm');
  });

  it('공동인증서는 이 PC에서 찾은 것만 고를 수 있다. 잘 모르겠어요는 설명을 펼치고 그 자리', async () => {
    const { flow } = make();
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'later' },
      { step: 'auth', choice: 'unsure' },
    ]);
    assert.equal(flow.state.step, 'auth');
    assert.equal(flow.state.explain, true);
    assert.equal(await code(flow.answer({ step: 'auth', choice: 'cert', certId: 'npki-x' })), 'bad_cert');
    await flow.answer({ step: 'auth', choice: 'cert', certId: 'npki-1' });
    assert.equal(flow.state.step, 'model', '보안카드가 아니면 ① 없이 ②로');
    assert.equal(flow.state.certId, 'npki-1');
  });
});

describe('동의 화면 4종', () => {
  it('키에 판이 붙은 자리표시 문구(F-06 초안 전), 문구에 세무 판단 표현이 없다', () => {
    assert.deepEqual([...CONSENT_KINDS].sort(), ['delegation', 'model', 'telemetry', 'terms']);
    for (const k of CONSENT_KINDS) {
      const n = CONSENT_NOTICES[k];
      assert.equal(n.key, `consent.${k}`);
      assert.match(n.version, /^f06-pre\.\d+$/);
      assert.equal(n.draft, 'F-06 초안 전 문구');
      const text = [n.title, ...n.lines].join(' ');
      for (const bad of ['세액 산정', '절세', '신고 대리', '가산세', '납부할 세액']) assert.ok(!text.includes(bad), `${k}: ${bad}`);
    }
    assert.match(CONSENT_NOTICES.delegation.lines.join(' '), /악성코드로부터는 보호하지 못해요/, 'D05 §9 범위 문구');
    assert.match(CONSENT_NOTICES.delegation.lines.join(' '), /인증서 비밀번호는 저장하지 않아요/);
  });

  it('동의는 화면마다 한 번씩 명시 답: 묶음 답이 없다, 텔레메트리는 기본 꺼짐(답 전에는 기록 없음)', () => {
    for (const step of ['terms', 'model', 'telemetry', 'delegation'] as const) {
      const ch = ONB_CHOICES[step] as readonly string[];
      assert.ok(!ch.some((c) => /all|bundle|every/.test(c)), step);
    }
    assert.deepEqual(ONB_CHOICES.telemetry, ['on', 'off']);
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../apps/desktop/src/onboarding.ts'), 'utf8');
    assert.ok(!/agreeAll|모두 동의|전체 동의/.test(src));
  });

  it('보안카드: ① 동의 → 금고 등록 창 결속(store, 아이디·비밀번호와 보안카드, notice 판) → 금고 동의 레코드. 비밀 값은 상태 기계를 지나지 않는다', async () => {
    const { flow, ports, saved } = make();
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'upload' },
      { step: 'biz-confirm', choice: 'confirm' },
      { step: 'auth', choice: 'card' },
    ]);
    assert.equal(flow.state.step, 'delegation');
    const view = await flow.view();
    assert.equal(view.consent?.key, 'consent.delegation');
    await flow.answer({ step: 'delegation', choice: 'agree' });
    assert.deepEqual(ports.binds, [
      [
        { mode: 'store', kind: 'portal_password', scope: 'business', notice: { version: CONSENT_NOTICES.delegation.version } },
        { mode: 'store', kind: 'security_card', scope: 'business', notice: { version: CONSENT_NOTICES.delegation.version } },
      ],
    ]);
    assert.deepEqual(flow.state.registered, { at: flow.state.registered!.at, noticeVersion: 'f06-pre.1', items: 31 });
    assert.equal(flow.state.step, 'model');
    await walk(flow, [
      { step: 'model', choice: 'decline' },
      { step: 'telemetry', choice: 'off' },
      { step: 'tasks', choice: 'submit', tasks: { 'H-03': true, 'H-02': true } },
      { step: 'summary', choice: 'ok' },
    ]);
    assert.equal(saved[0]?.portalLoginId, 'ganada01', '포털 아이디는 비밀 아닌 값으로 프로필에(DB portal_login_id)');
    assert.equal(saved[0]?.signMethod, 'security_card');
    const persisted = JSON.stringify(ports.saved);
    assert.ok(!persisted.includes('ganada01'), '이어 하기 저장·대화 기록에는 포털 아이디를 넣지 않는다');
  });

  it('금고 창을 닫으면 ①에 머무르고 안내, [다른 인증으로 바꾸기]는 인증 고르기로', async () => {
    const { flow } = make({ register: 'cancelled' });
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'later' },
      { step: 'auth', choice: 'card' },
      { step: 'delegation', choice: 'agree' },
    ]);
    assert.equal(flow.state.step, 'delegation');
    assert.match(flow.state.notice ?? '', /금고 창을 닫았어요/);
    assert.equal(flow.state.consents.delegation, undefined);
    await flow.answer({ step: 'delegation', choice: 'switch' });
    assert.equal(flow.state.step, 'auth');
    assert.equal(flow.state.auth, null);
  });

  it('②③④ 동의 레코드: 판·선택·시각, ②는 처리자 표 판(설정 데이터)도. 모델을 거절하면 modelAllowed false', async () => {
    const { flow, ports } = make();
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'later' },
      { step: 'auth', choice: 'simple' },
    ]);
    const view = await flow.view();
    assert.deepEqual(view.config, MOCK_CONSENT_CONFIG, '② 화면은 설정 데이터의 처리자 표를 그대로 받는다');
    await walk(flow, [
      { step: 'model', choice: 'decline' },
      { step: 'telemetry', choice: 'on' },
    ]);
    assert.deepEqual(
      ports.consents.map((c) => [c.kind, c.noticeKey, c.noticeVersion, c.choice, c.processorsVersion ?? null, c.at]),
      [
        ['terms', 'consent.terms', 'f06-pre.1', 'agreed', null, '2026-11-05T01:00:00.000Z'],
        ['model', 'consent.model', 'f06-pre.1', 'declined', 'mock-2026-11-05', '2026-11-05T01:00:00.000Z'],
        ['telemetry', 'consent.telemetry', 'f06-pre.1', 'agreed', null, '2026-11-05T01:00:00.000Z'],
      ],
    );
    assert.equal(flow.modelAllowed(), false);
  });
});

describe('요약·첫 작업·이어 하기', () => {
  it('세금계산서를 고르면 거래처 단계, 나머지는 바로 요약. 곧 되는 일은 고를 수 없다', async () => {
    const { flow } = make();
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'later' },
      { step: 'auth', choice: 'later' },
      { step: 'model', choice: 'agree' },
      { step: 'telemetry', choice: 'off' },
    ]);
    assert.equal(await code(flow.answer({ step: 'tasks', choice: 'submit', tasks: { 'H-02': true } })), 'no_tasks');
    await flow.answer({ step: 'tasks', choice: 'submit', tasks: { 'H-01': true, 'H-04': true } });
    assert.equal(flow.state.step, 'counterparties');
    await flow.answer({ step: 'counterparties', choice: 'later' });
    assert.equal(flow.state.step, 'summary');
  });

  it('요약에서 프로필을 저장하고(건너뛴 사업자는 저장하지 않음), 첫 작업은 입력창에 채우기만', async () => {
    const { flow, saved } = make();
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'upload' },
      { step: 'biz-confirm', choice: 'confirm' },
      { step: 'auth', choice: 'simple' },
      { step: 'model', choice: 'agree' },
      { step: 'telemetry', choice: 'off' },
      { step: 'tasks', choice: 'later' },
      { step: 'summary', choice: 'ok' },
    ]);
    assert.deepEqual(saved, [{ kind: 'business', displayName: '가나다컴퍼니', bizNo: '1234567891', repName: '김가나', bizType: '서비스업', bizItem: '경영 컨설팅', address: '서울특별시 가나구 다라로 12, 3층', email: 'office@ganada.example', signMethod: 'simple_auth' }]);
    const r = await flow.answer({ step: 'first', choice: 'try' });
    assert.equal(r.fill, '사업자등록증명 떼 줘');
    assert.ok(flow.done);
    assert.equal(await code(flow.answer({ step: 'first', choice: 'try' })), 'onboarding_done');
    assert.deepEqual(onboardingTodos(flow.state), [{ id: 'tasks', label: '맡길 업무 고르기', view: 'biz' }]);

    const skipped = make();
    await walk(skipped.flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'later' },
      { step: 'auth', choice: 'later' },
      { step: 'model', choice: 'agree' },
      { step: 'telemetry', choice: 'off' },
      { step: 'tasks', choice: 'later' },
      { step: 'summary', choice: 'ok' },
    ]);
    assert.equal(skipped.saved.length, 0);
    assert.deepEqual(
      onboardingTodos({ ...skipped.flow.state, step: 'done' }).map((t) => t.id),
      ['biz', 'auth', 'tasks'],
    );
  });

  it('앱을 껐다 켜면 멈춘 질문부터(저장한 상태로 다시 만든다)', async () => {
    const { flow, ports } = make();
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'upload' },
    ]);
    const again = new OnboardingFlow(ports, ports.saved, NOW);
    assert.equal(again.state.step, 'biz-confirm');
    assert.deepEqual(again.state.log.map((l) => l.text), ['동의했어요', '사업자등록증 올리기']);
  });
});
