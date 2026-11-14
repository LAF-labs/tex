// 온보딩 상태 기계(08 §4 O-01~O-06, D14 M4-2)와 동의 화면 4종(F-06 자리표시, 팀장 승인 2026-11-05). Electron 없이 돈다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MockOnboardingPorts, MOCK_BIZ_CERT, MOCK_CONSENT_CONFIG } from '../apps/desktop/src/onboarding-mock.ts';
import { BIZ_NAME_NOTICE, certExpiringSoon, CONSENT_KINDS, CONSENT_NOTICES, ONB_CHOICES, OnboardingFlow, onboardingTodos, parseOnbState, type OnbAnswer, type OnbProfile } from '../apps/desktop/src/onboarding.ts';

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
      { step: 'biz-number', choice: 'submit', fields: { name: ' 가나다상사 ', bizNo: '123-45-67891' } },
    ]);
    assert.equal(b.flow.state.biz?.name, '가나다상사', '번호 화면에서 상호도 받는다(B4: [고칠게요]로 다시 채우지 않게)');
    assert.equal(b.flow.state.notice, null);
    assert.equal(b.flow.state.check?.label, '폐업자');
    assert.equal(await code(b.flow.answer({ step: 'biz-confirm', choice: 'confirm' })), 'biz_inactive');
    assert.equal(await code(b.flow.answer({ step: 'biz-confirm', choice: 'confirm_unverified' })), 'bad_choice', '휴·폐업으로 확인된 번호는 [맞습니다]로도 확정하지 않는다');
    assert.equal(b.flow.state.step, 'biz-confirm');
  });

  it('진위확인을 하지 못한 번호(unknown)는 [맞습니다]를 눌러야 확정되고, 상태는 확인 못 함 그대로 남는다(팀장 결정 2026-11-10)', async () => {
    const { flow, ports } = make();
    ports.checkBizNo = async () => ({ status: 'unknown', label: '조회하지 못했어요', taxType: null, source: '국세청 조회' });
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'number' },
      { step: 'biz-number', choice: 'submit', fields: { bizNo: '123-45-67891' } },
    ]);
    assert.equal(await code(flow.answer({ step: 'biz-confirm', choice: 'confirm' })), 'biz_inactive', '그냥 [맞아요]로는 확정하지 않는다');
    // 번호로 등록하면 상호가 비어 있다: 확정 전에 채워야 한다(0.1.6 실사용: 상호 없이 확정되어 제목줄에 번호가 보였다)
    assert.equal(flow.state.notice, BIZ_NAME_NOTICE);
    assert.equal(await code(flow.answer({ step: 'biz-confirm', choice: 'confirm_unverified' })), 'name_required');
    await flow.answer({ step: 'biz-confirm', choice: 'edit', fields: { name: '가나다상사' } });
    assert.equal(flow.state.notice, null, '상호를 채우면 안내가 없어진다');
    await flow.answer({ step: 'biz-confirm', choice: 'confirm_unverified' });
    assert.equal(flow.state.step, 'auth');
    assert.deepEqual([flow.state.check?.status, flow.state.check?.label], ['unknown', '조회하지 못했어요'], '확인됐다고 바꾸지 않는다');
  });

  it('사업자 칸: 상한 안의 값은 자르지 않는다(이메일 320자). 모양이 틀린 이메일은 받을 때 거부, 등록증에서 읽은 틀린 이메일은 비운다', async () => {
    const { flow } = make({ bizCert: { ...MOCK_BIZ_CERT, email: '모양틀림' } });
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'upload' },
    ]);
    assert.equal(flow.state.biz?.email, '', '등록증의 틀린 이메일은 비워 둔다');
    const long = `${'a'.repeat(300)}@ganada.example`;
    await flow.answer({ step: 'biz-confirm', choice: 'edit', fields: { email: long } });
    assert.equal(flow.state.biz?.email, long);
    const before = flow.state;
    assert.equal(await code(flow.answer({ step: 'biz-confirm', choice: 'edit', fields: { email: 'a@b' } })), 'bad_email', 'DB profile.upsert와 같은 모양 검사');
    assert.deepEqual(flow.state, before);
  });

  it('등록증에서 읽은 번호가 체크섬에 맞지 않으면 조회하지 않고, [맞아요]는 bad_biz_no. 번호를 고치면 조회한다', async () => {
    const { flow, ports } = make({ bizCert: { ...MOCK_BIZ_CERT, bizNo: '1234567890' } });
    let calls = 0;
    const real = ports.checkBizNo.bind(ports);
    ports.checkBizNo = async (n: string) => (calls++, real(n));
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'upload' },
    ]);
    assert.deepEqual([flow.state.step, flow.state.check, calls], ['biz-confirm', null, 0]);
    assert.match(flow.state.notice ?? '', /사업자번호가 맞지 않아요/);
    assert.equal(await code(flow.answer({ step: 'biz-confirm', choice: 'confirm' })), 'bad_biz_no');
    await flow.answer({ step: 'biz-confirm', choice: 'edit', fields: { bizNo: '123-45-67891' } });
    assert.deepEqual([flow.state.check?.status, calls], ['active', 1]);
    await flow.answer({ step: 'biz-confirm', choice: 'confirm' });
    assert.equal(flow.state.step, 'auth');
  });

  it('진위확인을 하지 못했으면 [다시 조회]로 같은 번호를 다시 본다. 같은 번호로 고쳐 저장해도 다시 조회한다', async () => {
    const { flow, ports } = make();
    const real = ports.checkBizNo.bind(ports);
    let fail = true;
    let calls = 0;
    ports.checkBizNo = async (n: string) => {
      calls++;
      if (fail) throw new Error('net');
      return real(n);
    };
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'upload' },
    ]);
    assert.equal(flow.state.check?.status, 'unknown');
    assert.equal(await code(flow.answer({ step: 'biz-confirm', choice: 'confirm' })), 'biz_inactive');
    await flow.answer({ step: 'biz-confirm', choice: 'recheck' });
    assert.equal(flow.state.check?.status, 'unknown', '아직 실패');
    await flow.answer({ step: 'biz-confirm', choice: 'edit', fields: { email: 'x@ganada.example' } });
    assert.equal(calls, 3, '같은 번호로 저장해도 지난 조회가 실패했으면 다시 조회');
    fail = false;
    await flow.answer({ step: 'biz-confirm', choice: 'recheck' });
    assert.equal(flow.state.check?.status, 'active');
    assert.equal(await code(flow.answer({ step: 'biz-confirm', choice: 'recheck' })), 'bad_choice', '조회가 된 뒤에는 다시 조회 없음');
    await flow.answer({ step: 'biz-confirm', choice: 'confirm' });
    assert.equal(flow.state.step, 'auth');
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
    assert.equal(flow.state.step, 'first', '모델 동의는 약관 화면에서 받았으니 바로 첫 작업 제안(B4)');
    assert.equal(flow.state.certId, 'npki-1');
    assert.equal(flow.state.log.at(-1)?.text, '공동인증서 · 가나다컴퍼니');
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

  it('동의 답은 명시 클릭 하나씩: 묶음(전체 동의) 답이 없다. 텔레메트리 화면은 첫 실행에서 묻지 않는다(기본 꺼짐, 기록 없음)', () => {
    for (const step of ['terms', 'model', 'telemetry', 'delegation'] as const) {
      const ch = ONB_CHOICES[step] as readonly string[];
      assert.ok(!ch.some((c) => /all|bundle|every/.test(c)), step);
    }
    assert.deepEqual(ONB_CHOICES.telemetry, ['on', 'off']);
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../apps/desktop/src/onboarding.ts'), 'utf8');
    assert.ok(!/agreeAll|모두 동의|전체 동의/.test(src));
  });

  it('보안카드도 다른 인증처럼 바로 ②로: 금고 창을 열지 않고 위임 동의도 남기지 않는다(발급할 때 번호를 직접 넣는다)', async () => {
    const { flow, ports, saved } = make();
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'upload' },
      { step: 'biz-confirm', choice: 'confirm' },
      { step: 'auth', choice: 'card' },
    ]);
    assert.equal(flow.state.step, 'first');
    assert.deepEqual(ports.binds, [], '금고 등록 창을 열지 않는다');
    assert.equal(flow.state.consents.delegation, undefined, '위임 동의 레코드가 없다');
    assert.deepEqual([saved[0]?.signMethod, saved[0]?.certId], ['security_card', null]);
  });

  it('이어 하기 저장 읽기: 모양이 틀리면 처음부터(null), 모르는 키는 버린다, 예전 저장(포털 아이디 칸 없음)도 받는다', () => {
    assert.equal(parseOnbState(null), null);
    assert.equal(parseOnbState({ step: 'nope', tasks: [], skipped: [], log: [], consents: {} }), null);
    assert.equal(parseOnbState({ step: 'done', tasks: [], skipped: ['admin'], log: [], consents: {} }), null);
    assert.equal(parseOnbState({ step: 'done', tasks: [], skipped: [], log: [{ text: 1 }], consents: {} }), null);
    const ok = parseOnbState({ step: 'done', tasks: ['H-03'], skipped: ['biz'], log: [], consents: { terms: { version: 'f06-pre.1', choice: 'agreed', at: 'x' } }, evil: '<img>' });
    assert.ok(ok && ok.step === 'done' && ok.portalLoginId === null && !Object.hasOwn(ok, 'evil'));
    assert.deepEqual(onboardingTodos(ok), [{ id: 'biz', label: '사업자 등록 마치기', view: 'biz' }]);
  });

  it('엔진 모드: 이어 하기 저장이 있으면 그 자리부터, 끝낸 온보딩은 대화 없이 불러온다(사업자를 건너뛰어도 약관부터 다시 묻지 않음)', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../apps/desktop/src/shell-app.ts'), 'utf8');
    const i = src.indexOf("if (opts.onboarding) onb = new OnboardingFlow(onbPorts);");
    const body = src.slice(i, src.indexOf('await win.loadURL', i));
    // 이어 하기는 DB(엔진 onboarding.load)에서, 없으면 옛 목업 파일을 한 번 옮긴다(onboarding-store.ts).
    assert.match(body, /const saved = \(await onbStore\.load\(\)\) \?\? \(await onbStore\.importLegacyFile\(legacyOnbFile\)\);/);
    // 모델 거절이 저장된 끝낸 온보딩은 ②를 다시 묻는다(reaskModel): 보일지는 불러온 뒤의 단계로 정한다.
    assert.match(body, /onb = new OnboardingFlow\(onbPorts, saved\);\s*onbShow = !onb\.done;/);
    assert.ok(body.indexOf('onbStore.load') < body.indexOf('!business'), '저장을 먼저 본다');
    // 저장은 엔진 명령으로만(앱 폴더 JSON에 쓰지 않는다). 목업은 바깥 일에만.
    assert.doesNotMatch(src, /MockOnboardingPorts/, '제품 셸은 견본 바깥 일을 만들지 않는다(시연 연결 ShellDev.sample만)');
    assert.match(src, /const onbPorts = onboardingPorts\(onbExternal, onbStore, refresh\);/);
    // 제품 공동인증서 목록은 금고 npki.list → 샌드박스 certInfo(npki-certs.ts). 목업 목록은 fixture만.
    assert.match(src, /const onbExternal: OnboardingExternal = fixture\s*\? sample!\.onboarding\(\)/);
    assert.match(src, /findCerts: \(\) => listNpkiCerts\(\(m, p\) => host\.control\(m, p\), \(der\) => certInfoInSandbox\(der\)/);
    assert.ok(!src.includes('persistOnb') && !/writeFile\([^)]*onb/i.test(src));
  });

  it('예전 이어 하기 저장이 ①(위임 등록)에 멈춰 있으면 ①을 다시 그리지 않고 발급 인증을 다시 묻는다(앱이 대신 입력한다는 옛 약속 없음)', async () => {
    const a = make();
    await walk(a.flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'later' },
    ]);
    const old = parseOnbState({ ...JSON.parse(JSON.stringify(a.flow.state)), step: 'delegation', auth: 'card' });
    assert.ok(old);
    assert.equal(old.step, 'auth');
    assert.equal(old.auth, null, '옛 보안카드 선택은 비운다');
    const resumed = new OnboardingFlow(make().ports, old, NOW);
    const v = await resumed.view();
    assert.equal(v.step, 'auth');
    assert.equal(v.consent, null, '① 위임 동의 고지를 보이지 않는다');
    assert.doesNotMatch(JSON.stringify(v), /대신 입력|알아서 입력|금고에 한 번 등록/);
    await resumed.answer({ step: 'auth', choice: 'card' });
    assert.equal(resumed.state.step, 'first', '다시 보안카드를 골라도 ①을 거치지 않는다');
    // ② 다시 묻기(reaskModel)로 ①이 resumeStep에 남은 저장도 같다
    const parked = parseOnbState({ ...JSON.parse(JSON.stringify(a.flow.state)), step: 'model', resumeStep: 'delegation', auth: 'card' });
    assert.equal(parked?.resumeStep, 'auth');
    assert.equal(parked?.auth, null);
  });

  it('약관 화면 한 클릭에 약관·모델 레코드 둘(각 키·판, 모델은 처리자 표 판). ②는 필수라 거절 답이 없다. 텔레메트리는 기록하지 않는다(B4)', async () => {
    const { flow, ports } = make();
    const view = await flow.view();
    assert.equal(view.step, 'terms');
    assert.deepEqual(view.config, MOCK_CONSENT_CONFIG, '약관 화면이 설정 데이터의 처리자 표를 그대로 받는다');
    assert.match(view.consent?.lines.join(' ') ?? '', /AI 모델로 해석해요/);
    assert.deepEqual(ONB_CHOICES.model, ['agree'], '② 거절 선택지 없음');
    assert.equal(flow.modelAllowed(), false, '동의 전에는 모델을 쓰지 않는다');
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'later' },
      { step: 'auth', choice: 'simple' },
    ]);
    assert.deepEqual(
      ports.consents.map((c) => [c.kind, c.noticeKey, c.noticeVersion, c.choice, c.processorsVersion ?? null, c.at]),
      [
        ['terms', 'consent.terms', 'f06-pre.2', 'agreed', null, '2026-11-05T01:00:00.000Z'],
        ['model', 'consent.model', 'f06-pre.2', 'agreed', 'mock-2026-11-05', '2026-11-05T01:00:00.000Z'],
      ],
    );
    assert.equal(flow.modelAllowed(), true);
    assert.equal(flow.state.step, 'first');
    // 모델 동의 없이 인증까지 온 옛 저장은 인증 뒤 ②를 묻는다
    const old = make();
    const s0 = parseOnbState({ step: 'auth', tasks: [], skipped: ['biz'], log: [], consents: { terms: { version: 'f06-pre.1', choice: 'agreed', at: 'x' } } })!;
    const f = new OnboardingFlow(old.ports, s0, NOW);
    await f.answer({ step: 'auth', choice: 'simple' });
    assert.equal(f.state.step, 'model');
    await f.answer({ step: 'model', choice: 'agree' });
    assert.equal(f.state.step, 'first');
  });

  it('모델 거절이 저장된 프로필은 ②를 다시 묻고, 동의하면 있던 단계로 돌아간다(끝낸 온보딩 포함)', async () => {
    const declined = { version: 'f06-pre.1', choice: 'declined' as const, at: '2026-11-05T01:00:00.000Z' };
    const base = { tasks: ['H-03'], skipped: [], log: [{ step: 'terms', text: '동의했어요' }], consents: { terms: { version: 'f06-pre.1', choice: 'agreed', at: 'x' }, model: declined } };
    for (const at of ['done', 'summary', 'first'] as const) {
      const { ports } = make();
      const flow = new OnboardingFlow(ports, parseOnbState({ ...base, step: at })!, NOW);
      assert.equal(flow.state.step, 'model', at);
      assert.equal(flow.state.resumeStep, at);
      assert.equal(flow.done, false, '끝낸 온보딩도 ②를 다시 그린다');
      await flow.answer({ step: 'model', choice: 'agree' });
      assert.equal(flow.state.step, at, '동의하면 있던 자리로');
      assert.equal(flow.state.resumeStep, null);
      assert.equal(flow.modelAllowed(), true);
      assert.deepEqual(ports.consents.map((c) => [c.kind, c.choice]), [['model', 'agreed']]);
    }
    // ②를 아직 지나지 않았거나 이미 동의했으면 그대로
    const { ports } = make();
    assert.equal(new OnboardingFlow(ports, parseOnbState({ ...base, step: 'auth' })!, NOW).state.step, 'auth');
    assert.equal(new OnboardingFlow(ports, parseOnbState({ ...base, step: 'done', consents: { ...base.consents, model: { ...declined, choice: 'agreed' } } })!, NOW).state.step, 'done');
    // 없어진 화면(텔레메트리·업무·거래처)에 멈춘 옛 저장은 요약에서 마친다
    assert.equal(new OnboardingFlow(ports, parseOnbState({ ...base, step: 'tasks' })!, NOW).state.resumeStep, 'summary');
    assert.equal(parseOnbState({ ...base, step: 'telemetry', consents: { ...base.consents, model: { ...declined, choice: 'agreed' } } })?.step, 'summary');
    // 기억해 둔 단계가 모르는 값이면 저장을 버린다(처음부터)
    assert.equal(parseOnbState({ ...base, step: 'model', resumeStep: 'nope' }), null);
  });
});

describe('요약·첫 작업·이어 하기', () => {
  it('맡길 업무·거래처·요약 확인은 묻지 않는다(B4): 인증 뒤 바로 첫 작업 제안, 업무는 지금 되는 일(세금계산서)', async () => {
    const { flow } = make();
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'later' },
      { step: 'auth', choice: 'later' },
    ]);
    assert.equal(flow.state.step, 'first');
    assert.deepEqual(flow.state.tasks, ['H-01']);
    // 옛 요약 화면에 멈춘 저장은 [확인했어요]로 마친다
    const old = make();
    const f = new OnboardingFlow(old.ports, { ...flow.state, step: 'summary' }, NOW);
    await f.answer({ step: 'summary', choice: 'ok' });
    assert.equal(f.state.step, 'first');
  });

  it('마칠 때 프로필을 저장하고(건너뛴 사업자는 저장하지 않음, 고른 인증서 id 포함), 첫 작업은 입력창에 채우기만', async () => {
    const { flow, saved } = make();
    await walk(flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'upload' },
      { step: 'biz-confirm', choice: 'confirm' },
      { step: 'auth', choice: 'cert', certId: 'npki-1' },
    ]);
    assert.deepEqual(saved, [{ kind: 'business', displayName: '가나다컴퍼니', bizNo: '1234567891', repName: '김가나', bizType: '서비스업', bizItem: '경영 컨설팅', address: '서울특별시 가나구 다라로 12, 3층', email: 'office@ganada.example', signMethod: 'cert', certId: 'npki-1' }]);
    assert.equal(await code(flow.answer({ step: 'first', choice: 'invoice' as never })), 'bad_choice', '첫 작업 선택지는 [지금 해 보기]·[나중에] 둘');
    const r = await flow.answer({ step: 'first', choice: 'try' });
    assert.equal(r.fill, '세금계산서 발급해 줘', 'F-13: 지금 되는 일(세금계산서)로 채운다');
    assert.ok(flow.done);
    assert.equal(await code(flow.answer({ step: 'first', choice: 'try' })), 'onboarding_done');
    assert.deepEqual(onboardingTodos(flow.state), []);

    const skipped = make();
    await walk(skipped.flow, [
      { step: 'terms', choice: 'agree' },
      { step: 'welcome', choice: 'later' },
      { step: 'auth', choice: 'later' },
    ]);
    assert.equal(skipped.saved.length, 0);
    assert.deepEqual(
      onboardingTodos({ ...skipped.flow.state, step: 'done' }).map((t) => t.id),
      ['biz', 'auth'],
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
    assert.deepEqual(again.state.log.map((l) => l.text), ['동의하고 시작할게요', '사업자등록증 올리기']);
  });
});
