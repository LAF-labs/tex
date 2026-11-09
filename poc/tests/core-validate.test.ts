// D02 §6.1 정적 검증 V-01~V-24(V-03a~l·V-03c′·V-03j′·V-03j″)와 반례 회귀 CE-1~CE-14·CE-17·CE-18(D02 §6.2, D13 §7).
// 골든 H-01 v2.1(제품 원본 packages/engine/playbooks)을 복제해 한 군데만 바꾸고, 기대한 규칙 번호로 거부되는지 본다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCfg, commitWindow, fixtureUrlProblem, hostAllowed, lookupViolations, nameTemplateProblem, re2Problem, urlProblem, validatePackage, looksLikeUserData, type PackageFiles, type Step } from '@sax/engine/core';
import { bundleOutcomes, h01, lookups } from './core-fixtures.ts';

const bundles = bundleOutcomes();
const run = (p: PackageFiles) => validatePackage(p, { bundles, lookups: lookups() });
const rulesOf = (p: PackageFiles) => new Set(run(p).map((x) => x.rule));

type Mut = (p: PackageFiles, s: (id: string) => Step & Record<string, unknown>, steps: Step[]) => void;
function mutate(f: Mut): PackageFiles {
  const p = h01();
  const find = (id: string) => p.playbook.steps.find((s) => s.id === id) as Step & Record<string, unknown>;
  f(p, find, p.playbook.steps);
  return p;
}
const insertAfter = (steps: Step[], id: string, ...add: Step[]) => steps.splice(steps.findIndex((s) => s.id === id) + 1, 0, ...add);
const expectRule = (rule: string, f: Mut) => {
  const got = rulesOf(mutate(f));
  assert.ok(got.has(rule), `${rule} 기대, 실제 ${[...got].join(',') || '없음'}`);
};

/** H-01 + 후속 비가역 send_email(Phase 2 재발송 모양, V-03c′ 양성 기준). */
const withFollowUp: Mut = (p, s, steps) => {
  p.manifest.effects = ['issue_document', 'send'];
  (s('s20') as { authorizes: string[] }).authorizes = ['s21', 's36'];
  (s('s32b') as { cases: Record<string, string> }).cases = { true: 's32c' };
  // W(Y)에 낀 스텝(주 verify·사후 스텝)도 V-03f: {retry:0, then:handoff}
  for (const id of ['s30', 's32', 's32b']) s(id).onFail = { retry: 0, then: 'handoff' };
  insertAfter(steps, 's32b',
    { id: 's32c', type: 'readback', fields: ['counterpartEmail'], onFail: { retry: 0, then: 'handoff' } },
    { id: 's36', type: 'send_email', via: 'portal', to: '$inputs.email', followUpOf: 's21', intent: '$intent.id', verify: 's37', onFail: { retry: 0, then: 'handoff' } },
    { id: 's37', type: 'verify', lookup: { playbook: 'hometax.invoice.email_status', match: { approvalNo: '$vars.approvalNo' }, window: 'today', baseline: 'none', notCommittedPolicy: { minElapsedMs: 60000, lookups: 2 }, rowVerdict: { column: 'status', sent: 'mail.status.sent', notSent: 'mail.status.notSent' } }, on: { committed: 's33', not_committed: 's35', unknown: 's35' } },
  );
};

describe('골든 패키지', () => {
  it('H-01 v2.1과 조회 패키지 2개는 위반 없음', () => {
    assert.deepEqual(run(h01()), []);
    for (const p of lookups().values()) assert.deepEqual(validatePackage(p, { bundles }), []);
  });
  it('W(s21) = {s20, s21}이고 s20이 s21을 지배한다(D02 §8 검증 근거)', () => {
    const p = h01();
    const cfg = buildCfg(p.playbook, { irreversible: new Set(['s21']) });
    assert.deepEqual([...commitWindow(cfg, 's20', 's21')].sort(), ['s20', 's21']);
    assert.ok(cfg.dom.get('s21')!.has('s20'));
  });
  it('후속 비가역(send_email) 변형도 V-03c′를 통과한다', () => {
    assert.deepEqual(run(mutate(withFollowUp)), []);
  });
});

describe('V-01 스키마·RE2', () => {
  it('미정의 필드는 거부', () => expectRule('V-01', (_p, s) => (s('s1').extra = 1)));
  it('CE-6 javascript: URL은 스키마에서 거부', () => expectRule('V-01', (_p, s) => (s('s1').url = 'javascript:alert(1)')));
  it('namePattern 전후방 탐색은 RE2 밖', () => expectRule('V-01', (p) => (p.selectors.entries['hometax.nav.home']!.namePattern = '^(?=홈)홈$')));
  it('patternRef 역참조는 RE2 밖', () => expectRule('V-01', (p) => (p.strings['counterpart.nameRegex'] = '^(a)\\1$')));
  it('patternRef가 strings에 없으면 거부', () => expectRule('V-01', (p) => delete p.strings['counterpart.nameRegex']));
  it('verify.rowVerdict 문구 키가 strings에 없으면 거부(v1.3.4)', () => expectRule('V-01', (p) => delete p.strings['mail.status.notSent']));
  it('verify.rowVerdict 문구도 RE2로 본다(역참조 거부)', () => expectRule('V-01', (p) => (p.strings['mail.status.sent'] = '^(전송)\\1$')));
  it('verify.rowVerdict 미정의 필드·빈 column은 스키마에서 거부', () => {
    expectRule('V-01', (_p, s) => ((s('s33') as { lookup: Record<string, unknown> }).lookup.rowVerdict = { column: 'status', sent: 'mail.status.sent', notSent: 'mail.status.notSent', extra: 1 }));
    expectRule('V-01', (_p, s) => ((s('s33') as { lookup: Record<string, unknown> }).lookup.rowVerdict = { column: '', sent: 'mail.status.sent', notSent: 'mail.status.notSent' }));
  });
  it('expectConfirm 정규식도 RE2로 본다(전후방 탐색 거부)', () => expectRule('V-01', (p) => (p.strings['confirm.issue'] = '^(?=발급)발급하시겠습니까\\?$')));
  it('사후조건 textMatches의 patternRef도 RE2로 본다', () =>
    expectRule('V-01', (p) => {
      p.playbook.postconditions.push({ textMatches: { target: 'hometax.page.root', patternRef: 'post.done' } });
      p.strings['post.done'] = '^(a)\\1$';
    }));
  it('전제조건 전용 조건을 스텝에서 쓰면 거부', () => expectRule('V-01', (_p, s) => (s('s14').cond = { profileHas: 'signMethod' })));
  it('re2Problem: 역참조·전후방·원자 그룹·중첩 반복·빈 패턴', () => {
    assert.equal(re2Problem('^a(b)\\1$'), 'backreference');
    assert.equal(re2Problem('^(?<=a)b$'), 'lookaround');
    assert.equal(re2Problem('^(?>ab)$'), 'unsupported_group');
    assert.equal(re2Problem('^(a+)+$'), 'nested_quantifier');
    assert.equal(re2Problem(''), 'empty');
    assert.equal(re2Problem('^[(]$'), null);
    assert.equal(re2Problem('^발급(이|에) 실패했습니다.*$'), null);
  });
});

describe('V-02 타깃·속성', () => {
  it('CE-3 타깃 오탈자', () => expectRule('V-02', (_p, s) => (s('s12').target = 'hometax.invoice.form.counterpartBizN0')));
  it('secret_fill.secret과 secretKind 불일치', () =>
    expectRule('V-02', (p, _s, steps) => {
      p.selectors.entries['hometax.login.pw'] = { candidates: [{ kind: 'css', value: '#pw' }], role: 'textbox', namePattern: '^비밀번호$', frame: 'main', landmark: 'hometax.login.root', commits: false, inputType: 'password', secretKind: 'portal_password', secretPurpose: 'login', lastVerified: '2026-11-01' };
      insertAfter(steps, 's3', { id: 's3a', type: 'secret_fill', target: 'hometax.login.pw', secret: 'cert_password' });
    }));
  it('sign 용도 칸을 독립 secret_fill로 쓰면 거부(ADR-026)', () =>
    expectRule('V-02', (p, _s, steps) => {
      p.selectors.entries['hometax.login.pw'] = { candidates: [{ kind: 'css', value: '#pw' }], role: 'textbox', namePattern: '^비밀번호$', frame: 'main', landmark: 'hometax.login.root', commits: false, inputType: 'password', secretKind: 'portal_password', secretPurpose: 'sign', lastVerified: '2026-11-01' };
      insertAfter(steps, 's3', { id: 's3a', type: 'secret_fill', target: 'hometax.login.pw', secret: 'portal_password' });
    }));
  it('signFlow.confirmTarget commitEffect가 submit 타깃과 다름', () => expectRule('V-02', (p) => (p.selectors.entries['hometax.invoice.sign.confirmButton']!.commitEffect = 'sign')));
  it('signFlow.confirmTarget이 commits:false', () => expectRule('V-02', (p) => {
    const e = p.selectors.entries['hometax.invoice.sign.confirmButton']!;
    e.commits = false;
    delete e.commitEffect;
  }));
  it('strings 키(card) 없음', () => expectRule('V-02', (p) => delete p.strings['invoice.confirm']));
  it('readback 필드의 fieldKey 항목 없음', () => expectRule('V-02', (_p, s) => (s('s19b').fields as string[]).push('ghostField')));
});

describe('V-03m 금액·상대방 입력 대조(팀장 결정 2026-11-07, D02 §8 s19d·s19f)', () => {
  const v03m = (f: Mut) => run(mutate(f)).filter((x) => x.rule === 'V-03m').map((x) => x.message.match(/필드 (\w+)/)?.[1]).sort();
  const remove = (steps: Step[], id: string) => steps.splice(steps.findIndex((s) => s.id === id), 1);
  it('골든 H-01은 통과한다(s19f가 공급받는자·공급가액·세액, s19d가 합계)', () => assert.deepEqual(v03m(() => {}), []));
  it('s19f가 빠지면 금액·상대방·받는 이메일 필드 전부, 합계도(parts가 대조되지 않음) 거부', () =>
    assert.deepEqual(v03m((_p, _s, steps) => remove(steps, 's19f')), ['counterpartBizNo', 'counterpartEmail', 'supplyAmount', 'taxAmount', 'totalAmount']));
  it('s19d가 빠지면 합계만 거부', () => assert.deepEqual(v03m((_p, _s, steps) => remove(steps, 's19d')), ['totalAmount']));
  it('대조가 any·not 안에 있으면 셈하지 않는다', () => {
    const f19 = (wrap: (c: unknown) => unknown) => v03m((_p, s) => (s('s19f').cond = wrap(s('s19f').cond)));
    const all5 = ['counterpartBizNo', 'counterpartEmail', 'supplyAmount', 'taxAmount', 'totalAmount'];
    assert.deepEqual(f19((c) => ({ any: [c, { inputPresent: 'issueDate' }] })), all5);
    assert.deepEqual(f19((c) => ({ not: { not: c } })), all5);
    assert.deepEqual(f19((c) => ({ all: [c] })), [], 'all 중첩은 셈한다');
  });
  it('$inputs가 아닌 참조($profile)와의 대조는 입력 대조가 아니다', () =>
    assert.deepEqual(v03m((_p, s) => (s('s19f').cond = { all: [
      { readbackEquals: { fieldKey: 'counterpartBizNo', ref: '$profile.bizNo' } },
      { readbackEquals: { fieldKey: 'supplyAmount', ref: '$inputs.amounts.supply' } },
      { readbackEquals: { fieldKey: 'taxAmount', ref: '$inputs.amounts.tax' } },
      { readbackEquals: { fieldKey: 'counterpartEmail', ref: '$inputs.email', ifAbsent: 'empty' } },
    ] })), ['counterpartBizNo']));
  const withoutEmailEq = (cond: { all: Array<Record<string, unknown>> }) => cond.all.filter((c) => !('readbackEquals' in c && (c.readbackEquals as { fieldKey: string }).fieldKey === 'counterpartEmail'));
  it('받는 이메일: 이메일 입력 있음 + 대조 assert 없음 → 거부', () =>
    assert.deepEqual(v03m((_p, s) => (s('s19f').cond = { all: withoutEmailEq(s('s19f').cond as never) })), ['counterpartEmail']));
  it('받는 이메일: 이메일 입력 없음 + readbackEmpty 없음 → 거부, readbackEmpty가 있으면 통과', () => {
    const noInput: Mut = (p, s) => {
      delete (p.playbook.inputs as Record<string, unknown>).email;
      s('s15').value = '$inputs.counterpart.email';
      s('s19f').cond = { all: withoutEmailEq(s('s19f').cond as never) };
    };
    assert.deepEqual(v03m(noInput), ['counterpartEmail']);
    assert.deepEqual(v03m((p, s, steps) => {
      noInput(p, s, steps);
      (s('s19f').cond as { all: unknown[] }).all.push({ readbackEmpty: 'counterpartEmail' });
    }), []);
  });
  it("받는 이메일: 선택 입력과 대조하면서 ifAbsent:'empty'가 없으면 거부(입력이 빈 실행을 덮지 않음)", () =>
    assert.deepEqual(v03m((_p, s) => {
      const c = s('s19f').cond as { all: Array<Record<string, unknown>> };
      c.all = [...withoutEmailEq(c as never), { readbackEquals: { fieldKey: 'counterpartEmail', ref: '$inputs.email' } }];
    }), ['counterpartEmail']));
  it('합계를 입력과 직접 대조하면 s19d 없이도 된다', () =>
    assert.deepEqual(v03m((_p, s) => (s('s19d').cond = { readbackEquals: { fieldKey: 'totalAmount', ref: '$inputs.amounts.total' } })), []));
});

describe('V-03 커밋 구간', () => {
  it('V-03a 게이트 둘이 같은 X를 허가', () => expectRule('V-03a', (_p, _s, steps) => insertAfter(steps, 's19e', { id: 's19g', type: 'gate', card: 'invoice.confirm', authorizes: ['s21'] })));
  it('V-03b 게이트를 우회하는 경로', () =>
    expectRule('V-03b', (_p, _s, steps) => insertAfter(steps, 's18', { id: 's18a', type: 'branch', on: { inputPresent: 'email' }, cases: { true: 's21' }, default: 's19' })));
  it('CE-17 커밋 구간 안 decide', () =>
    expectRule('V-03c', (p, s, steps) => {
      (s('s20') as { authorizes: string[] }).authorizes = ['s21'];
      insertAfter(steps, 's20', { id: 's20a', type: 'decide', bundle: 'form_ready_v2', scope: 'hometax.invoice.form.root', on: { no_visible_error: 's21', validation_error: 'abort', unknown: 'abort' }, onFail: { retry: 0, then: 'abort' } });
      void p;
    }));
  it('CE-4 게이트–제출 사이 사람 입력', () => expectRule('V-03c', (_p, _s, steps) => insertAfter(steps, 's20', { id: 's20a', type: 'human', kind: 'manual', prompt: 'captcha.prompt', ttlMs: 60000, onFail: { retry: 0, then: 'abort' } })));
  it('CE-1 게이트 뒤 체크포인트', () => expectRule('V-03c', (_p, _s, steps) => insertAfter(steps, 's20', { id: 's20a', type: 'checkpoint', name: 'late', expect: { exists: 'hometax.invoice.form.root' }, onFail: { retry: 0, then: 'abort' } })));
  it('CE-4 게이트–제출 사이 L2 수리(onFail recover)', () => expectRule('V-03f', (_p, _s, steps) => insertAfter(steps, 's20', { id: 's20a', type: 'wait', for: 'selector', value: 'hometax.invoice.form.issueButton', onFail: { retry: 0, then: 'recover' } })));
  it('CE-18 후속 비가역 앞에 fill', () =>
    expectRule('V-03c′', (p, s, steps) => {
      withFollowUp(p, s, steps);
      insertAfter(steps, 's32c', { id: 's32d', type: 'fill', target: 'hometax.invoice.form.counterpartEmail', value: '$inputs.email', ifAbsent: 'clear' }, { id: 's32e', type: 'readback', fields: ['counterpartEmail'] });
    }));
  it('V-03c′ 후속 비가역 직전 readback 없음', () =>
    expectRule('V-03c′', (p, s, steps) => {
      withFollowUp(p, s, steps);
      steps.splice(steps.findIndex((x) => x.id === 's32c'), 1);
      (s('s32b') as { cases: Record<string, string> }).cases = { true: 's36' };
    }));
  it('CE-5 handoff.resumeAt이 게이트 뒤에 착지', () =>
    expectRule('V-03d', (_p, s, steps) => {
      insertAfter(steps, 's93', { id: 's94', type: 'handoff', reason: 'captcha.prompt', resumeAt: 's21' });
      s('s93').on = { ...(s('s93').on as object), error: 's94' };
    }));
  it('CE-2 repeat 안 비가역', () =>
    expectRule('V-03e', (_p, _s, steps) => {
      const i = steps.findIndex((x) => x.id === 's21');
      const [x] = steps.splice(i, 1);
      steps.splice(i, 0, { id: 's21r', type: 'repeat', max: 2, until: { varSet: 'approvalNo' }, steps: [x!] });
    }));
  it('V-03f 후속 비가역 구간 W(Y)의 비가역 아닌 스텝도 본다(recover 재시도 거부)', () =>
    expectRule('V-03f', (p, s, steps) => {
      withFollowUp(p, s, steps);
      s('s32').onFail = { retry: 2, then: 'recover' };
    }));
  it('구간 안 wait의 onFail 핸드오프(자기 재개)는 V-03c·V-03f를 함께 통과한다', () => {
    const p = h01();
    insertAfter(p.playbook.steps, 's20', { id: 's20a', type: 'wait', for: 'selector', value: 'hometax.invoice.form.issueButton', timeoutMs: 7000, onFail: { retry: 0, then: 'handoff' } } as Step);
    assert.deepEqual(run(p), []);
  });
  it('V-03f 구간 안 스텝 onFail 누락', () => expectRule('V-03f', (_p, _s, steps) => insertAfter(steps, 's20', { id: 's20a', type: 'wait', for: 'selector', value: 'hometax.invoice.form.issueButton' })));
  it('CE-4 verify unknown·not_committed → 바로 재제출', () => expectRule('V-03f', (_p, s) => ((s('s30').on as Record<string, string>).not_committed = 's21')));
  it('V-03g 게이트 없이 commits:true 클릭', () => expectRule('V-03g', (_p, _s, steps) => insertAfter(steps, 's18', { id: 's18a', type: 'click', target: 'hometax.invoice.form.issueButton' })));
  it('V-03g submit 타깃이 commits:false', () => expectRule('V-03g', (_p, s) => (s('s21').target = 'hometax.invoice.form.lookupCounterpart')));
  it('V-03h readback→gate 사이에 fill', () => expectRule('V-03h', (_p, _s, steps) => insertAfter(steps, 's19e', { id: 's19f', type: 'fill', target: 'hometax.invoice.form.remark', value: '$inputs.counterpart.name' })));
  it('V-03h 게이트 앞 readback 없음', () => expectRule('V-03h', (_p, _s, steps) => steps.splice(steps.findIndex((x) => x.id === 's19b'), 1)));
  it('CE-10 게이트 하나가 독립 submit 둘을 허가', () =>
    expectRule('V-03i', (_p, s, steps) => {
      (s('s20') as { authorizes: string[] }).authorizes = ['s21', 's22'];
      insertAfter(steps, 's21', { id: 's22', type: 'submit', target: 'hometax.invoice.form.issueButton', intent: '$intent.id', verify: 's30', onFail: { retry: 0, then: 'handoff' } });
    }));
  it('CE-11 커밋 랜드마크 fieldKey 누락 readback', () => expectRule('V-03j', (_p, s) => (s('s19b').fields = (s('s19b').fields as string[]).filter((f) => f !== 'remark'))));
  it('V-03j′ 작성일자 대조 assert 없음', () => expectRule('V-03j′', (_p, _s, steps) => steps.splice(steps.findIndex((x) => x.id === 's19e'), 1)));
  it('V-03j″ 앵커 없는 실패 신호 문구', () => expectRule('V-03j″', (_p, s) => ((s('s30').failSignals as Array<{ text: string }>)[0]!.text = '발급 실패')));
  it('CE-9 타깃 없는 press Enter는 스키마에서 거부', () => expectRule('V-01', (_p, _s, steps) => insertAfter(steps, 's18', { id: 's18a', type: 'press', key: 'Enter' } as Step)));
  it('V-03k 커밋 랜드마크 칸에서 press Enter는 비가역(게이트 없음 → 거부)', () => {
    const p = mutate((_p, _s, steps) => insertAfter(steps, 's18', { id: 's18a', type: 'press', key: 'Enter', target: 'hometax.invoice.form.counterpartEmail' }));
    const r = run(p);
    assert.ok(r.some((x) => x.rule === 'V-03g' && x.step === 's18a'));
    assert.ok(r.some((x) => x.rule === 'V-04' && x.step === 's18a'));
  });
  it('V-03l 게이트를 지배하는 체크포인트가 reuse', () => expectRule('V-03l', (_p, s) => (s('s11').reentry = 'reuse')));
});

describe('V-04~V-24', () => {
  it('V-04 verify.match가 $inputs', () => expectRule('V-04', (_p, s) => ((s('s30').lookup as { match: Record<string, string> }).match.supplyAmount = '$inputs.amounts.supply')));
  it('V-04 주 비가역 verify baseline none', () => expectRule('V-04', (_p, s) => ((s('s30').lookup as { baseline: string }).baseline = 'none')));
  it('V-04 submit.verify가 verify 스텝이 아님', () => expectRule('V-04', (_p, s) => (s('s21').verify = 's32')));
  it('V-04a 두 비가역 X가 같은 verify를 가리키면 거부(후속 send_email s36.verify = 주 verify s30)', () => {
    const r = run(mutate((p, s, steps) => {
      withFollowUp(p, s, steps);
      s('s36').verify = 's30';
    }));
    assert.ok(r.some((x) => x.rule === 'V-04a' && x.step === 's36' && x.target === 's30'), JSON.stringify(r.map((x) => x.rule)));
  });
  it('V-04a 후속 Y가 W(Y) 안에서 Xc의 verify를 다시 지나는 것은 허용(X.verify 필드 중복만 막는다)', () => {
    assert.ok(!rulesOf(mutate(withFollowUp)).has('V-04a'), '골든 + 후속 send_email(자기 verify s37)은 통과');
    assert.ok(!rulesOf(h01()).has('V-04a'));
  });
  it('V-05 repeat 경계를 넘는 점프', () =>
    expectRule('V-05', (_p, _s, steps) => insertAfter(steps, 's18', { id: 's18a', type: 'repeat', max: 2, until: { varSet: 'x' }, steps: [{ id: 's18b', type: 'branch', on: { inputPresent: 'email' }, cases: { true: 's19' }, default: 's18c' }, { id: 's18c', type: 'extract', name: 'x', from: { a11y: { target: 'hometax.invoice.form.remark' } } }] })));
  it('V-05 repeat 3중 중첩', () =>
    expectRule('V-05', (_p, _s, steps) => {
      const leaf: Step = { id: 's18d', type: 'wait', for: 'idle' };
      const r3: Step = { id: 's18c', type: 'repeat', max: 2, until: { varSet: 'x' }, steps: [leaf] };
      const r2: Step = { id: 's18b', type: 'repeat', max: 2, until: { varSet: 'x' }, steps: [r3] };
      insertAfter(steps, 's18', { id: 's18a', type: 'repeat', max: 2, until: { varSet: 'x' }, steps: [r2] });
    }));
  it('V-06 허용 밖 호스트', () => expectRule('V-06', (_p, s) => (s('s10').url = 'https://evil.example/invoice')));
  it('V-06 urlProblem: http·userinfo·포트·와일드카드', () => {
    const d = ['hometax.go.kr', '*.hometax.go.kr'];
    assert.match(urlProblem('http://hometax.go.kr/', d)!, /https/);
    assert.match(urlProblem('https://a:b@hometax.go.kr/', d)!, /userinfo/);
    assert.match(urlProblem('https://hometax.go.kr:8443/', d)!, /포트/);
    assert.equal(urlProblem('https://www.hometax.go.kr/x', d), null);
    assert.equal(hostAllowed('xhometax.go.kr', d), false);
    assert.equal(hostAllowed('hometax.go.kr', ['*.hometax.go.kr']), false);
  });
  it('V-07 decide.on 결과 누락', () => expectRule('V-07', (_p, s) => delete (s('s2').on as Record<string, string>).captcha));
  it('V-07 예약 결과를 on에 둠', () => expectRule('V-07', (_p, s) => ((s('s2').on as Record<string, string>).blocked = 'abort')));
  it('V-07 카탈로그에 없는 번들', () => expectRule('V-07', (_p, s) => (s('s19').bundle = 'form_ready_v9')));
  it('V-07b unknown이 대기 루프가 아닌 스텝', () => expectRule('V-07b', (_p, s) => ((s('s2').on as Record<string, string>).unknown = 's3')));
  it('V-08 signFlow 보안카드에 rowLabel 없음', () => expectRule('V-08', (_p, s) => (((s('s21').signFlow as { steps: Record<string, string[]> }).steps).security_card = ['secret_fill:security_card'])));
  it('V-09 pace는 normal·slow만(스키마)', () => expectRule('V-01', (_p, s) => (s('s1').pace = 'fast')));
  it('V-16 send_email.to 상수는 스키마에서 거부', () =>
    expectRule('V-01', (p, s, steps) => {
      withFollowUp(p, s, steps);
      s('s36').to = 'someone@example.com';
    }));
  it('V-12 personal 프로필인데 $profile.bizNo 사용', () =>
    expectRule('V-12', (p) => {
      p.playbook.profileKinds = ['personal', 'business'];
      p.manifest.profileKinds = ['personal', 'business'];
    }));
  it('V-10 캡차 다음이 $human fill이 아님', () => expectRule('V-10', (_p, s) => (s('s91').value = '$inputs.email')));
  it('V-11 도달 불가 스텝', () => expectRule('V-11', (_p, _s, steps) => insertAfter(steps, 's35', { id: 's36', type: 'end', status: 'success' })));
  it('V-11 end 없이 최상위 끝', () => expectRule('V-11', (_p, _s, steps) => steps.push({ id: 's99', type: 'wait', for: 'idle' }) && void ((steps.find((x) => x.id === 's93') as { on: Record<string, string> }).on.error = 's99')));
  it('V-12 profileKinds 불일치', () => expectRule('V-12', (p) => (p.manifest.profileKinds = ['personal', 'business'])));
  it('V-13 상수에 사업자번호 모양(유사 문자)', () => {
    assert.ok(looksLikeUserData('123-45-6789O'));
    assert.ok(looksLikeUserData('ａ@ｂ.com'));
    assert.equal(looksLikeUserData('영수'), false);
    expectRule('V-13', (p) => p.selectors.entries['hometax.invoice.form.receiptType']!.allowedConstants!.push('1234567890'));
  });
  it('V-14 manifest.effects에 issue_document 없음', () => expectRule('V-14', (p) => (p.manifest.effects = ['send'])));
  it('V-15 선언 안 된 입력', () => expectRule('V-15', (_p, s) => (s('s16').value = '$inputs.nope')));
  it('V-15 선택 입력 fill에 ifAbsent 없음', () => expectRule('V-15', (_p, s) => delete s('s15').ifAbsent));
  it('V-15 지배하지 않는 $vars', () => expectRule('V-15', (_p, s) => (s('s16').value = '$vars.approvalNo')));
  it('V-15 readback 앞에서 $readback 사용', () => expectRule('V-15', (_p, s) => (s('s19a').cond = { readbackEquals: { fieldKey: 'supplierBizNo', ref: '$profile.bizNo' } })));
  it('V-17 체크포인트 이름 중복', () => expectRule('V-17', (_p, s) => (s('s11').name = 'session')));
  it('V-17 없는 checkpoint: 참조', () => expectRule('V-17', (_p, s) => (s('s12').onFail = { retry: 1, then: 'checkpoint:nowhere' })));
  it('V-18 loopGuard 없는 순환', () => expectRule('V-18', (_p, s) => delete s('s6').loopGuard));
  it('V-19 스텝 id 중복', () => expectRule('V-19', (_p, s) => (s('s92').id = 's91')));
  it('CE-7 비밀 칸 extract', () =>
    expectRule('V-20', (p, _s, steps) => {
      p.selectors.entries['hometax.login.pw'] = { candidates: [{ kind: 'css', value: '#pw' }], role: 'textbox', namePattern: '^비밀번호$', frame: 'main', landmark: 'hometax.invoice.sign.root', commits: false, inputType: 'password', lastVerified: '2026-11-01' };
      insertAfter(steps, 's18', { id: 's18a', type: 'extract', name: 'pw', from: { selector: 'hometax.login.pw' } });
    }));
  it('CE-8 비밀 칸 랜드마크를 포함하는 decide.scope', () =>
    expectRule('V-20', (p) => {
      p.selectors.entries['hometax.invoice.form.pin'] = { candidates: [{ kind: 'css', value: '#pin' }], role: 'textbox', namePattern: '^PIN$', frame: 'main', landmark: 'hometax.invoice.form.root', commits: false, secretKind: 'security_card', secretPurpose: 'sign', lastVerified: '2026-11-01' };
    }));
  it('V-21 allowedConstants 밖 상수', () => expectRule('V-21', (_p, _s, steps) => insertAfter(steps, 's18', { id: 's18a', type: 'select', target: 'hometax.invoice.form.receiptType', option: '현금' })));
  it('V-22 lookupsUsed에 없는 조회 패키지', () => expectRule('V-22', (p) => (p.manifest.lookupsUsed = p.manifest.lookupsUsed.filter((l) => l.id !== 'hometax.invoice.lookup'))));
  it('V-22 조회 패키지가 설치되어 있지 않음', () => {
    const r = validatePackage(h01(), { bundles, lookups: new Map() });
    assert.ok(r.some((x) => x.rule === 'V-22'));
  });
  it('CE-14 조회 하위 플레이북의 decide·commits 타깃·navigationOnly 아닌 click', () => {
    const lp = lookups().get('hometax.invoice.lookup')!;
    lp.playbook.steps.splice(1, 0, { id: 's0a', type: 'decide', bundle: 'screen_state_v2', scope: 'root', on: { unknown: 'abort' } });
    (lp.playbook.steps.find((s) => s.id === 's4') as { target: string }).target = 'hometax.lookup.rows';
    const rules = lookupViolations(lp).map((x) => x.message);
    assert.ok(rules.some((m) => m.includes('decide')));
    assert.ok(rules.some((m) => m.includes('navigationOnly')));
    assert.ok(validatePackage(lp, { bundles }).some((x) => x.rule === 'V-22'));
  });
  it('CE-12 nameTemplate 허용 밖 토큰', () => {
    expectRule('V-01', (_p, s) => (s('s32').nameTemplate = '{counterpartName}.pdf'));
    assert.equal(nameTemplateProblem('{docType}_{yyyyMMdd}_{shortId}.pdf'), null);
    assert.ok(nameTemplateProblem('/abs/{docType}.pdf'));
    expectRule('V-23', (_p, s) => (s('s32').nameTemplate = 'a//{docType}.pdf'));
  });
  it('V-23a save_pdf strategy는 이 엔진이 하는 print·page_pdf만(original·wallet은 로드 때 거부)', () => {
    expectRule('V-23a', (_p, s) => (s('s32').strategy = 'original'));
    expectRule('V-23a', (_p, s) => (s('s32').strategy = 'wallet'));
    assert.deepEqual([...rulesOf(mutate((_p, s) => (s('s32').strategy = 'page_pdf')))], [], 'page_pdf는 통과');
  });
  it('CE-13 expectConfirm ".*"', () => {
    expectRule('V-24', (p) => (p.strings['confirm.issue'] = '.*'));
    expectRule('V-24', (p) => (p.strings['confirm.issue'] = '^.*$'));
    expectRule('V-24', (p) => (p.strings['confirm.issue'] = '^(발급)?.*$'));
  });
});

/** 골든을 fixture 포털(ADR-039)로: portal 셋 다 fixture, domains 127.0.0.1, URL은 http://127.0.0.1:PORT. */
const asFixture: Mut = (p) => {
  p.manifest.portal = 'fixture';
  p.playbook.portal = 'fixture';
  p.selectors.portal = 'fixture';
  p.manifest.domains = ['127.0.0.1'];
  for (const st of p.playbook.steps) if ((st.type === 'goto' || st.type === 'checkpoint') && st.url) st.url = st.url.replace('https://hometax.go.kr', 'http://127.0.0.1:4100');
};

describe('V-25 fixture 포털 URL 경계(ADR-039)', () => {
  it('fixture 패키지: http://127.0.0.1:PORT만이면 V-06·V-25 없음', () => {
    const got = rulesOf(mutate(asFixture));
    assert.ok(!got.has('V-25') && !got.has('V-06'), [...got].join(','));
  });
  it('fixture 패키지 [::1]도 받는다', () => {
    const got = rulesOf(mutate((p, s, steps) => {
      asFixture(p, s, steps);
      p.manifest.domains = ['[::1]'];
      for (const st of p.playbook.steps) if ((st.type === 'goto' || st.type === 'checkpoint') && st.url) st.url = st.url.replace('127.0.0.1', '[::1]');
    }));
    assert.ok(!got.has('V-25') && !got.has('V-06'), [...got].join(','));
  });
  it('섞임 거부: fixture 패키지에 https 실제 포털 URL', () => expectRule('V-25', (p, s, steps) => {
    asFixture(p, s, steps);
    s('s1').url = 'https://hometax.go.kr/';
  }));
  it('섞임 거부: fixture 패키지 domains에 실제 호스트', () => expectRule('V-25', (p, s, steps) => {
    asFixture(p, s, steps);
    p.manifest.domains = ['127.0.0.1', 'hometax.go.kr'];
  }));
  it('섞임 거부: 실제 포털 패키지에 http://127.0.0.1:PORT', () => expectRule('V-25', (_p, s) => (s('s1').url = 'http://127.0.0.1:4100/')));
  it('섞임 거부: 실제 포털 패키지 domains에 IP 주소', () => expectRule('V-25', (p) => p.manifest.domains.push('127.0.0.1')));
  it('fixture도 포트 없는 http·localhost 이름·다른 사설 주소는 스키마에서 거부(V-01)', () => {
    for (const u of ['http://127.0.0.1/', 'http://localhost:4100/', 'http://10.0.0.1:4100/']) {
      expectRule('V-01', (p, s, steps) => {
        asFixture(p, s, steps);
        s('s1').url = u;
      });
    }
  });
  it('fixtureUrlProblem: http·루프백·포트·domains 안', () => {
    assert.equal(fixtureUrlProblem('http://127.0.0.1:4100/x', ['127.0.0.1']), null);
    assert.ok(fixtureUrlProblem('https://127.0.0.1:4100/', ['127.0.0.1']));
    assert.ok(fixtureUrlProblem('http://127.0.0.1/', ['127.0.0.1']));
    assert.ok(fixtureUrlProblem('http://u:p@127.0.0.1:4100/', ['127.0.0.1']));
    assert.ok(fixtureUrlProblem('http://[::1]:4100/', ['127.0.0.1']), 'domains 밖');
    assert.ok(fixtureUrlProblem('http://localhost:4100/', ['127.0.0.1']));
  });
});

describe('V-03n 사후 확인 verify(팀장 결정 2026-11-06, 스키마 v1.3.4)', () => {
  type L = { lookup: Record<string, unknown> };
  it('골든 s33은 rowVerdict·maxMs 50초를 선언하고 통과한다', () => {
    const p = h01();
    const s33 = p.playbook.steps.find((s) => s.id === 's33') as unknown as L;
    assert.equal(s33.lookup.maxMs, 50_000);
    assert.ok(s33.lookup.rowVerdict);
    assert.ok(!rulesOf(p).has('V-03n'));
  });
  it('baseline:none 사후 확인 verify에 rowVerdict가 없으면 거부', () => expectRule('V-03n', (_p, s) => delete (s('s33') as unknown as L).lookup.rowVerdict));
  it('후속 비가역(send_email)의 verify도 baseline:none이면 rowVerdict 필수', () =>
    expectRule('V-03n', (p, s, steps) => {
      withFollowUp(p, s, steps);
      delete (s('s37') as unknown as L).lookup.rowVerdict;
    }));
  it('maxMs는 사후 확인에만: 주 비가역 verify(s30, pre_gate_snapshot)에 두면 거부(앱 하한 300초를 줄이지 못한다)', () => expectRule('V-03n', (_p, s) => ((s('s30') as unknown as L).lookup.maxMs = 50_000)));
  it('maxMs 범위는 스키마(10초~300초)', () => {
    expectRule('V-01', (_p, s) => ((s('s33') as unknown as L).lookup.maxMs = 5_000));
    expectRule('V-01', (_p, s) => ((s('s33') as unknown as L).lookup.maxMs = 600_000));
  });
});
