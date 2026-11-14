// 내 사업장(D-03) 사업자 프로필 고치기(profile-edit.ts, 사용자 요구 2026-11-10 "내 사업장 정보를 수정할 수도 있어야 한다"):
// 칸 검사(온보딩 O-02와 같다)·번호 상태조회와 [맞습니다]·실행 중 거부·실제 DB upsert에서 인증·포털 아이디 유지·고친 기록(칸 이름만)·
// 온보딩 상태 맞추기(syncBiz)·발급 인증 바꾸기(reopen auth)·배선.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { openDatabase, ProfileRepo, type Db, type Profile as DbProfile } from '@sax/db';
import { MockOnboardingPorts } from '../apps/desktop/src/onboarding-mock.ts';
import { BIZ_FIELD_MAX, OnboardingFlow, parseOnbState, type BizCheck, type BizFields, type OnbAnswer, type OnbProfile } from '../apps/desktop/src/onboarding.ts';
import { BIZ_FIELD_LABEL, BIZ_NO_CHANGE_NOTE, bizFieldsOf, changedKeys, cleanBizEdit, nameMissing, PROFILE_EDIT_LOG_MAX, ProfileEditLog, ProfileEditor, type BizFieldKey } from '../apps/desktop/src/profile-edit.ts';
import { checkParams, SHELL_METHODS, USER_ACTION_METHODS } from '../apps/desktop/src/ipc.ts';

const dirs: string[] = [];
const dbs: Db[] = [];
after(() => {
  for (const d of dbs) d.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-profile-edit-'));
  dirs.push(d);
  return d;
};

// 가상 값(체크섬이 맞는 번호)
const NO_A = '1234567891';
const NO_B = '2208162517';
const ACTIVE: BizCheck = { status: 'active', label: '계속사업자', taxType: '일반과세자', source: '국세청 조회' };
const UNKNOWN: BizCheck = { status: 'unknown', label: '조회하지 못했어요', taxType: null, source: '국세청 조회' };
const CLOSED: BizCheck = { status: 'closed', label: '폐업자', taxType: null, source: '국세청 조회' };

/** 실제 DB(@sax/db ProfileRepo) 위의 편집기. */
function setup(o: { check?: BizCheck | (() => Promise<BizCheck>); active?: () => boolean; seed?: boolean } = {}) {
  const db = openDatabase(path.join(tmp(), 'db.sqlite'), new Uint8Array(randomBytes(32)));
  dbs.push(db);
  const repo = new ProfileRepo(db);
  if (o.seed !== false) {
    const p = repo.upsert({ kind: 'business', displayName: '가나다상사', bizNo: NO_A, corpNo: null, repName: '김가나', bizType: '서비스', bizItem: '소프트웨어', address: '서울시 가상구 1', email: 'a@ganada.example', signMethod: 'cert', keepSession: true });
    repo.setPortalLoginId(p.id, 'ganada01');
  }
  const checks: string[] = [];
  const saved: Array<{ biz: BizFields; changed: BizFieldKey[] }> = [];
  let upserts = 0;
  const editor = new ProfileEditor({
    list: async () => repo.list(),
    upsert: async (row) => (upserts++, repo.upsert(row as never)),
    checkBizNo: async (n) => {
      checks.push(n);
      const c = o.check ?? ACTIVE;
      return typeof c === 'function' ? c() : c;
    },
    runActive: o.active ?? (() => false),
    saved: async (biz, changed) => void saved.push({ biz, changed }),
  });
  const cur = () => repo.list().find((p) => p.kind === 'business') as DbProfile;
  return { editor, repo, checks, saved, cur, upserts: () => upserts };
}

describe('칸 검사(온보딩 O-02와 같다)', () => {
  const base = bizFieldsOf(null);
  it('자르기·번호 숫자만·상호 필수·체크섬·이메일 모양', () => {
    const f = cleanBizEdit({ name: '  가나다  ', bizNo: '123-45-67891', email: '' }, base);
    assert.equal(f.name, '가나다');
    assert.equal(f.bizNo, NO_A);
    assert.equal(cleanBizEdit({ name: 'ㄱ'.repeat(300), bizNo: NO_A }, base).name.length, BIZ_FIELD_MAX.name);
    assert.throws(() => cleanBizEdit({ name: '', bizNo: NO_A }, base), /name_required/);
    assert.throws(() => cleanBizEdit({ name: 'A', bizNo: '1234567890' }, base), /bad_biz_no/);
    assert.throws(() => cleanBizEdit({ name: 'A', bizNo: NO_A, email: 'not-mail' }, base), /bad_email/);
    // 보내지 않은 칸은 그대로, 문자열이 아닌 값은 버린다
    const b2 = { ...base, name: 'B', bizNo: NO_A, address: '주소' };
    assert.equal(cleanBizEdit({ rep: 3 as unknown as string }, b2).address, '주소');
    assert.deepEqual(changedKeys(b2, { ...b2, rep: '김', email: 'x@y.example' }), ['rep', 'email']);
    assert.deepEqual(Object.keys(BIZ_FIELD_LABEL), Object.keys(BIZ_FIELD_MAX));
  });
});

describe('상호가 비었거나 번호로 저장된 프로필(0.1.6 실사용: 제목줄에 번호 10자리가 이름처럼 보였다)', () => {
  it('번호·빈 이름은 이름이 없는 것으로 본다, 숫자가 섞인 상호는 그대로', () => {
    assert.equal(nameMissing({ displayName: NO_A, bizNo: NO_A }), true);
    assert.equal(nameMissing({ displayName: '123-45-67891', bizNo: NO_A }), true);
    assert.equal(nameMissing({ displayName: '  ', bizNo: NO_A }), true);
    assert.equal(nameMissing({ displayName: '가나다상사', bizNo: NO_A }), false);
    assert.equal(nameMissing({ displayName: '1234567891상사', bizNo: NO_A }), false);
    assert.equal(nameMissing({ displayName: '2208162517', bizNo: NO_A }), false, '다른 숫자는 사용자가 넣은 이름일 수 있다');
  });
  it('고치기 폼의 상호 칸은 비우고, 채우지 않으면 저장하지 않는다 → 채우면 저장', async () => {
    const t = setup();
    t.repo.upsert({ ...t.cur(), displayName: NO_A });
    assert.equal((await t.editor.current()).name, '');
    await assert.rejects(t.editor.save({ rep: '박' }), /name_required/);
    assert.deepEqual(await t.editor.save({ name: '가나다상사' }), { ok: true, changed: ['name'] });
    assert.equal(t.cur().displayName, '가나다상사');
  });
  it('화면: main은 중립 표기("내 사업장")+nameMissing, 렌더러는 상호 칸을 비우고 안내, 저장 뒤 제목줄도 다시 그린다', () => {
    const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const src = read('apps/desktop/src/shell-app.ts');
    assert.match(src, /const unnamed = p\.kind === 'business' && nameMissing\(p\);\s*return \{ kind: p\.kind, name: unnamed \? NO_BUSINESS\.name : p\.displayName, \.\.\.\(unnamed \? \{ nameMissing: true \} : \{\}\),/);
    const biz = read('apps/desktop/static/shell/shell-biz.js');
    assert.match(biz, /name: b\.bizNo && !b\.nameMissing \? b\.name : ''/);
    assert.match(biz, /has && b\.nameMissing \? note\(BIZ_NAME_MISSING_NOTE, true\) : null/);
    const shell = read('apps/desktop/static/shell/shell.js');
    assert.match(shell, /state\.bizEdit = null;\s*\/\/ [^\n]*\n\s*render\(\);\s*renderTitlebar\(\);\s*renderToday\(\);/);
    const onb = read('apps/desktop/static/shell/shell-onboarding.js');
    assert.match(onb, /active && named \? btn\('맞아요'/);
    assert.match(onb, /unknown && named \? btn\('맞습니다'/);
  });
});

describe('ProfileEditor: 실제 DB upsert', () => {
  it('대표자·업태·종목·주소·이메일을 고치면 저장하고, 발급 인증·세션 유지·포털 아이디는 그대로', async () => {
    const t = setup();
    const r = await t.editor.save({ name: '가나다상사', bizNo: '123-45-67891', rep: '박다라', bizType: '도소매', bizItem: '전자상거래', address: '부산시 가상구 2', email: 'b@ganada.example' });
    assert.deepEqual(r, { ok: true, changed: ['rep', 'bizType', 'bizItem', 'address', 'email'] });
    const p = t.cur();
    assert.equal(p.repName, '박다라');
    assert.equal(p.address, '부산시 가상구 2');
    assert.equal(p.signMethod, 'cert');
    assert.equal(p.keepSession, true);
    assert.equal(p.portalLoginId, 'ganada01');
    assert.deepEqual(t.checks, [], '번호가 같으면 상태조회를 하지 않는다');
    assert.deepEqual(t.saved.at(-1)?.changed, ['rep', 'bizType', 'bizItem', 'address', 'email']);
  });
  it('바뀐 것이 없으면 저장하지 않는다', async () => {
    const t = setup();
    assert.deepEqual(await t.editor.save({ rep: '김가나' }), { ok: true, changed: [] });
    assert.equal(t.upserts(), 0);
    assert.equal(t.saved.length, 0);
  });
  it('칸을 비우면 null로 저장한다(상호·번호는 비울 수 없다)', async () => {
    const t = setup();
    await t.editor.save({ address: '', email: '' });
    assert.equal(t.cur().address, null);
    assert.equal(t.cur().email, null);
    await assert.rejects(t.editor.save({ name: ' ' }), /name_required/);
  });
  it('번호를 바꾸면 상태조회: 계속사업자면 저장', async () => {
    const t = setup({ check: ACTIVE });
    assert.deepEqual(await t.editor.save({ bizNo: NO_B }), { ok: true, changed: ['bizNo'] });
    assert.deepEqual(t.checks, [NO_B]);
    assert.equal(t.cur().bizNo, NO_B);
    assert.equal(t.cur().portalLoginId, 'ganada01');
  });
  it('조회하지 못하면 confirm → 같은 번호로 [맞습니다]면 저장, 다른 번호면 다시 조회', async () => {
    const t = setup({ check: UNKNOWN });
    const r = await t.editor.save({ bizNo: NO_B });
    assert.deepEqual(r, { ok: false, confirm: UNKNOWN });
    assert.equal(t.cur().bizNo, NO_A, '아직 저장하지 않는다');
    // 조회하지 않은 번호에 [맞습니다]를 붙여도 다시 조회한다
    const other = '1010111113';
    assert.deepEqual(await t.editor.save({ bizNo: other }, true), { ok: false, confirm: UNKNOWN });
    assert.deepEqual(t.checks, [NO_B, other]);
    assert.deepEqual(await t.editor.save({ bizNo: other }, true), { ok: true, changed: ['bizNo'] });
    assert.equal(t.cur().bizNo, other);
    // 한 번 쓴 확인은 다시 쓰지 않는다
    assert.deepEqual(await t.editor.save({ bizNo: NO_B }, true), { ok: false, confirm: UNKNOWN });
  });
  it('조회가 던지면 조회 못 함과 같다, 휴·폐업은 막는다', async () => {
    const t = setup({ check: () => Promise.reject(new Error('net')) });
    assert.equal((await t.editor.save({ bizNo: NO_B })).ok, false);
    const t2 = setup({ check: CLOSED });
    await assert.rejects(t2.editor.save({ bizNo: NO_B }), /biz_inactive/);
    assert.equal(t2.cur().bizNo, NO_A);
  });
  it('실행 중이면 저장하지 않는다(조회 사이에 시작돼도)', async () => {
    let active = true;
    const t = setup({ active: () => active });
    await assert.rejects(t.editor.save({ rep: '박' }), /run_active/);
    active = false;
    let n = 0;
    const t2 = setup({ active: () => n++ > 0, check: ACTIVE });
    await assert.rejects(t2.editor.save({ bizNo: NO_B }), /run_active/);
    assert.equal(t2.cur().bizNo, NO_A);
  });
  it('프로필이 없으면(온보딩 기록 없는 옛 설치·건너뜀) 새로 만들고 번호를 조회한다', async () => {
    const t = setup({ seed: false, check: ACTIVE });
    assert.deepEqual(await t.editor.current(), bizFieldsOf(null));
    const r = await t.editor.save({ name: '새상사', bizNo: NO_B, rep: '이', email: '' });
    assert.equal(r.ok, true);
    assert.deepEqual(t.checks, [NO_B]);
    assert.equal(t.cur().displayName, '새상사');
    assert.equal(t.cur().signMethod, null);
  });
});

describe('고친 기록(값 없음)', () => {
  it('칸 이름만 남고, 모양이 틀린 줄은 버리고, 최근 50개, 0600', () => {
    const dir = tmp();
    const log = new ProfileEditLog(dir);
    assert.deepEqual(log.list(), []);
    log.add({ at: '2026-11-10T09:00:00.000Z', kind: 'business', fields: ['rep', 'address'] });
    const file = path.join(dir, 'profile-edits.json');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!/김|박|서울|@/.test(raw));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, JSON.stringify([{ at: 'x', kind: 'business', fields: ['rep'] }, { at: '2026-11-10T09:00:00.000Z', kind: 'business', fields: ['secret'] }, { at: '2026-11-10T09:00:00.000Z', kind: 'business', fields: ['rep'], value: '김가나' }]));
    assert.deepEqual(log.list(), [{ at: '2026-11-10T09:00:00.000Z', kind: 'business', fields: ['rep'] }]);
    for (let i = 0; i < 60; i++) log.add({ at: new Date(Date.UTC(2026, 10, 10, 0, i)).toISOString(), kind: 'business', fields: ['email'] });
    assert.equal(log.list().length, PROFILE_EDIT_LOG_MAX);
    fs.writeFileSync(file, '{');
    assert.deepEqual(log.list(), []);
  });
});

const NOW = () => new Date('2026-11-10T01:00:00.000Z');
const walk = async (f: OnboardingFlow, as: OnbAnswer[]) => {
  for (const a of as) await f.answer(a);
};
async function onboarded(skipBiz: boolean) {
  const profiles: OnbProfile[] = [];
  const ports = Object.assign(new MockOnboardingPorts({ saveProfile: async (p) => void profiles.push(p) }), { profiles });
  const flow = new OnboardingFlow(ports, null, NOW);
  await walk(flow, [
    { step: 'terms', choice: 'agree' },
    ...(skipBiz ? [{ step: 'welcome', choice: 'later' } as OnbAnswer] : [{ step: 'welcome', choice: 'upload' } as OnbAnswer, { step: 'biz-confirm', choice: 'confirm' } as OnbAnswer]),
    { step: 'auth', choice: 'simple' },
    { step: 'first', choice: 'later' },
  ]);
  return { ports, flow };
}
const edited: BizFields = { name: '고친상사', bizNo: NO_B, rep: '박다라', bizType: '도소매', bizItem: '전자', address: '부산', email: '' };

describe('온보딩 상태 맞추기(syncBiz)와 발급 인증 바꾸기(reopen auth)', () => {
  it('건너뛴 사업자를 내 사업장에서 채우면 할 일이 지워진다. 진행 중 온보딩은 거부', async () => {
    const { flow } = await onboarded(true);
    assert.deepEqual(flow.missing(), ['biz']);
    await flow.syncBiz(edited);
    assert.deepEqual(flow.missing(), []);
    assert.deepEqual(flow.state.biz, edited);
    const fresh = new OnboardingFlow(new MockOnboardingPorts({ saveProfile: async () => {} }), null, NOW);
    await assert.rejects(fresh.syncBiz(edited), /onboarding_open/);
    await assert.rejects(flow.syncBiz({ ...edited, bizNo: '1234567890' }), /bad_biz_no/);
  });
  it('이미 고른 인증도 바꾸려고 다시 열 수 있다: 다른 인증 → 고친 칸으로 저장(예전 칸으로 덮어쓰지 않는다)', async () => {
    const { ports, flow } = await onboarded(false);
    await flow.syncBiz(edited);
    const consents = ports.consents.length;
    await flow.reopen('auth');
    assert.equal(flow.state.step, 'auth');
    assert.deepEqual(flow.state.redoPrev, { auth: 'simple', certId: null });
    await flow.answer({ step: 'auth', choice: 'cert', certId: 'npki-1' });
    assert.equal(flow.state.step, 'done', '요약 확인 없이 저장하고 끝(B4)');
    const p = ports.profiles.at(-1)!;
    assert.deepEqual([p.signMethod, p.certId], ['cert', 'npki-1']);
    assert.equal(p.bizNo, NO_B);
    assert.equal(p.displayName, '고친상사');
    assert.equal(p.repName, '박다라');
    assert.equal(ports.consents.length, consents);
    assert.equal(flow.state.redoPrev, null);
  });
  it('바꾸려고 열었다가 [나중에]면 그 전 인증 그대로(건너뜀이 되지 않는다)', async () => {
    const { ports, flow } = await onboarded(false);
    const saves = ports.profiles.length;
    await flow.reopen('auth');
    await flow.answer({ step: 'auth', choice: 'later' });
    assert.equal(flow.state.step, 'done');
    assert.equal(flow.state.auth, 'simple');
    assert.deepEqual(flow.missing(), []);
    assert.equal(ports.profiles.length, saves, '프로필을 다시 저장하지 않는다');
    // 사업자는 빠진 것이 아니면 여전히 nothing_to_reopen(내 사업장 [수정]으로 고친다)
    await assert.rejects(flow.reopen('biz'), /nothing_to_reopen/);
  });
  it('redoPrev 모양이 틀린 저장 상태는 받지 않는다', async () => {
    const { flow } = await onboarded(false);
    const s = JSON.parse(JSON.stringify(flow.state));
    assert.ok(parseOnbState({ ...s, redoPrev: { auth: 'cert', certId: 'x' } }));
    assert.equal(parseOnbState({ ...s, redoPrev: { auth: 'pin', certId: null } }), null);
    assert.equal(parseOnbState({ ...s, redoPrev: 'simple' }), null);
    assert.equal(parseOnbState({ ...s, redoPrev: { auth: 'cert', certId: 3 } }), null);
  });
});

describe('배선(main·IPC·렌더러)', () => {
  const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const src = read('apps/desktop/src/shell-app.ts');
  it('profile.edit·readCert: 실제 입력 3초·로그인·진행 중 온보딩 거부, 기록은 칸 이름만', () => {
    assert.match(src, /'profile\.edit': async \(p\) => \{\s*needGesture\(3_000\);\s*await needLogin\(\);\s*if \(onb && !onb\.done\) throw new Error\('onboarding_open'\);/);
    assert.match(src, /'profile\.readCert': async \(\) => \{\s*needGesture\(3_000\);\s*await needLogin\(\);/);
    assert.match(src, /log\.event\('main\.profile_edit', \{ fields: changed\.join\('\.'\) \|\| 'none' \}\);/);
    assert.match(src, /runActive: \(\) => runs\.anyActive\(\),/);
    assert.match(src, /checkBizNo: \(n\) => onbExternal\.checkBizNo\(n\),/);
    assert.match(src, /if \(onb\?\.done\) await onb\.syncBiz\(biz\);/);
    // 엔진 계약은 그대로(profile.upsert), 새 엔진 명령 없음
    assert.match(src, /upsert: async \(row\) => \(await host\.rpc\('profile\.upsert', row\)\) as DbProfile,/);
    assert.equal(USER_ACTION_METHODS['profile.edit'], 3_000);
    assert.equal(USER_ACTION_METHODS['profile.readCert'], 3_000);
  });
  it('IPC 표: 칸 상한은 온보딩과 같다, 모르는 칸·넘친 길이는 거부', () => {
    const spec = SHELL_METHODS['profile.edit'];
    assert.ok(checkParams(spec, { fields: { name: 'A', bizNo: NO_A, address: 'x' }, confirmUnverified: true }));
    assert.ok(!checkParams(spec, { fields: { name: 'A', signMethod: 'cert' } }));
    assert.ok(!checkParams(spec, { fields: { address: 'x'.repeat(BIZ_FIELD_MAX.address + 1) } }));
    assert.ok(!checkParams(spec, {}));
    assert.ok(checkParams(SHELL_METHODS['profile.readCert'], {}));
  });
  it('렌더러: 상한·번호 안내가 main과 같다, 값은 입력 칸 value로만, [발급 인증 바꾸기]는 onboarding.reopen auth', async () => {
    const biz = read('apps/desktop/static/shell/shell-biz.js');
    const max = JSON.parse(biz.match(/export const BIZ_EDIT_MAX = (\{[^}]+\});/)![1]!.replace(/(\w+):/g, '"$1":'));
    assert.deepEqual(max, BIZ_FIELD_MAX);
    assert.ok(biz.includes(`export const BIZ_NO_CHANGE_NOTE = '${BIZ_NO_CHANGE_NOTE}';`));
    assert.doesNotMatch(biz, /innerHTML/);
    assert.match(biz, /ctx\.call\('profile\.edit', \{ fields: \{ \.\.\.e\.values \}, \.\.\.\(confirmUnverified \? \{ confirmUnverified: true \} : \{\}\) \}\)/);
    assert.match(biz, /btn\('맞습니다', \(\) => save\(true\)/);
    const shell = read('apps/desktop/static/shell/shell.js');
    assert.match(shell, /reopenAuth: \(\) => reopenSetup\('auth'\),/);
    assert.match(shell, /authReopen: !!state\.boot\.authReopen,/);
    assert.doesNotMatch(shell, /바꿀 때는 대화로 말해 주세요/);
    assert.match(src, /authReopen: !!onb,/);
  });
});
