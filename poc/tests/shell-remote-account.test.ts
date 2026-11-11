// 데스크톱 계정 로그인·첫 PC 등록·기기 토큰(remote-account.ts, D08 §4.2, D09 §2): 실제 계정 서비스(개발 스택)에 붙여 돌린다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { dirGuard, isUserSid, readDacl, windowsTool } from '@sax/platform';
import { b64, fromB64, verifyAcctClaim, verifyCert } from '@sax/remote';
import { CERT_RENEW_MS, checkIdentity, DesktopAccount, PendingCodeFile, RemoteIdentityFile } from '../apps/desktop/src/remote-account.ts';
import { devStackPasswords, ORIGIN, softDesktopKeys, startDevStack, type DevStack } from './remote-dev-stack.ts';

const EMAIL = 'owner@gyeonbon-test.example';

/**
 * 신원 파일이 사용자만 읽는지. POSIX는 모드 0600. Windows는 모드 비트가 없어(0o666으로 보인다) 제품처럼
 * 앱 루트(userData의 부모) DACL 상속으로 막는다(D07 §1.1): 파일 ACE가 사용자·SYSTEM뿐이어야 한다.
 */
async function assertUserOnly(file: string): Promise<void> {
  if (process.platform !== 'win32') return assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const [name = '', me = ''] = execFileSync(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim().split('","').map((f) => f.replace(/"/g, ''));
  const local = name.split('\\')[0]?.toLowerCase() === process.env.COMPUTERNAME?.toLowerCase();
  const sids = (await readDacl(file)).aces.map((a) => a.sid);
  assert.ok(sids.length > 0 && sids.every((x) => isUserSid(x, me, local) || x === 'SY'), `신원 파일 ACE: ${sids.join(', ')}`);
}

describe('데스크톱 계정: 이메일 6자리 → 첫 PC 등록 → 기기 토큰', () => {
  let root: string;
  let dir: string;
  let s: DevStack;
  let logs: Array<[string, Record<string, string | number>]>;
  const account = (keys = softDesktopKeys(), client: DevStack['client'] | null = s.client) =>
    new DesktopAccount({ client, keys: async () => keys, identity: new RemoteIdentityFile(dir), platform: 'windows', deviceName: 'Windows PC', now: s.clock.now, log: (n, d) => logs.push([n, d]) });
  const signIn = async (a: DesktopAccount, email = EMAIL) => {
    await a.init();
    assert.equal((await a.sendCode(email)).step, 'code_sent');
    return a.verify(s.mail.lastCode(email.toLowerCase())!);
  };

  before(async () => {
    root = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'sax-remote-acct-'));
  });
  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(root, 'u-'));
    // 제품의 userData는 prepareLayout이 잠근 앱 루트 아래다. 시험 폴더도 같은 상태로 만든다(Windows DACL 판정의 전제).
    assert.equal((await dirGuard().ensurePrivate(dir)).ok, true);
    s = await startDevStack();
    logs = [];
  });
  afterEach(() => s.close());

  it('처음: 코드 보내기 → 코드 확인 → AIK 고정 → 신원 파일(비밀 없음) → 로그아웃', async () => {
    const keys = softDesktopKeys();
    const a = account(keys);
    assert.equal((await a.init()).step, 'signed_out');
    const sent = await a.sendCode(` ${EMAIL} `);
    assert.equal(sent.step, 'code_sent');
    assert.equal(sent.email, EMAIL);
    assert.ok(sent.codeExpiresAt! > s.clock.now());
    const v = await a.verify(s.mail.lastCode(EMAIL)!);
    assert.deepEqual(v, { step: 'signed_in', email: EMAIL, codeExpiresAt: null, error: null, phones: 0 });
    assert.deepEqual(s.client.calls, ['POST /v1/auth/code', 'POST /v1/auth/code/verify', 'GET /v1/device-list', 'POST /v1/aik', 'POST /v1/auth/logout']);
    const raw = fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8');
    const id = checkIdentity(JSON.parse(raw), s.clock.now())!;
    assert.ok(id, '파일은 AIK로 다시 검증된다');
    assert.equal(id.aikPub, b64(keys.aik.publicKey));
    const c = verifyCert(id.cert, keys.aik.publicKey, s.clock.now())!;
    assert.equal(c.device_id, id.deviceId);
    assert.equal(b64(c.Vx), b64(keys.vd.publicKey));
    await assertUserOnly(path.join(dir, 'remote-identity.json'));
    for (const bad of ['session', 'loginId', 'sxd1.', s.mail.lastCode(EMAIL)!]) assert.ok(!raw.includes(bad), bad);
    const dl = (await s.svc.deviceList((await s.svc.verifyEmailCode((await s.svc.startEmailCode(EMAIL)).loginId, s.mail.lastCode(EMAIL)!)).accountId)) as { aikPub: string };
    assert.equal(dl.aikPub, id.aikPub, '서버에 이 AIK가 고정됐다');
  });

  it('기기 토큰으로 계정 호출: 토큰은 캐시(15분), acct-claim은 폰과 같은 검사(계정 서비스 고정 키)를 통과한다', async () => {
    const keys = softDesktopKeys();
    const a = account(keys);
    await signIn(a);
    const dev = a.device()!;
    const h1 = await dev.auth('GET', `${ORIGIN}/v1/device-list`);
    assert.match(h1.Authorization!, /^DPoP sxd1\./);
    const r = await s.http({ method: 'GET', url: `${ORIGIN}/v1/device-list`, headers: h1 });
    assert.equal(r.status, 200);
    await dev.auth('GET', `${ORIGIN}/v1/device-list`);
    assert.equal(s.client.calls.filter((c) => c === 'POST /v1/device-tokens').length, 1, '토큰은 다시 받지 않는다');
    const field = await dev.acctClaimField();
    const ok = verifyAcctClaim(field, { accountKeys: [fromB64(s.claimSigner.publicKey)], aikPub: keys.aik.publicKey, now: s.clock.now() });
    assert.ok(ok.ok && ok.claim.email === EMAIL, JSON.stringify(ok));
    s.clock.advance(16 * 60_000);
    await dev.auth('GET', `${ORIGIN}/v1/device-list`);
    assert.equal(s.client.calls.filter((c) => c === 'POST /v1/device-tokens').length, 2, '만료되면 새로 받는다');
  });

  it('다시 켜면 신원 파일로 바로 로그인 상태(네트워크 없음), 다른 금고 키면 쓰지 않는다', async () => {
    const keys = softDesktopKeys();
    await signIn(account(keys));
    const n = s.client.calls.length;
    assert.equal((await account(keys).init()).step, 'signed_in');
    assert.equal(s.client.calls.length, n);
    assert.equal((await account(softDesktopKeys()).init()).step, 'signed_out');
    assert.deepEqual(logs.at(-1), ['main.account_identity', { result: 'key_mismatch' }]);
  });

  it('같은 금고로 다시 설치(신원 파일 없음): 서버 목록의 이 PC 항목으로 되살린다(같은 deviceId)', async () => {
    const seed = new Uint8Array(32).fill(7);
    await signIn(account(softDesktopKeys(seed)));
    const first = JSON.parse(fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8')).deviceId;
    await fsp.rm(path.join(dir, 'remote-identity.json'));
    s.clock.advance(70 * 60_000);
    const v = await signIn(account(softDesktopKeys(seed)));
    assert.equal(v.step, 'signed_in');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8')).deviceId, first);
    assert.ok(!s.client.calls.slice(-3).includes('POST /v1/aik'), '다시 고정하지 않는다');
  });

  it('다른 PC가 이미 고정한 계정이면 account.aik_already_pinned로 끝나고 신원 파일을 만들지 않는다(두 번째 PC는 A-03)', async () => {
    await signIn(account());
    await fsp.rm(path.join(dir, 'remote-identity.json'));
    s.clock.advance(70 * 60_000);
    const v = await signIn(account(softDesktopKeys()));
    assert.equal(v.step, 'signed_out');
    assert.equal(v.error, 'account.aik_already_pinned');
    assert.ok(!fs.existsSync(path.join(dir, 'remote-identity.json')));
    assert.equal(s.client.calls.at(-1), 'POST /v1/auth/logout', '실패해도 세션은 버린다');
  });

  it('틀린 코드·이메일 모양·만료·계정 없는 빌드', async () => {
    const a = account();
    await a.init();
    assert.equal((await a.sendCode('not-an-email')).error, 'account.email_shape');
    await a.sendCode(EMAIL);
    const code = s.mail.lastCode(EMAIL)!;
    const wrong = await a.verify(code === '000000' ? '111111' : '000000');
    assert.equal(wrong.step, 'code_sent');
    assert.equal(wrong.error, 'account.code_invalid');
    assert.equal((await a.verify('12ab56')).error, 'account.code_shape');
    s.clock.advance(11 * 60_000);
    const late = await a.verify(code);
    assert.equal(late.step, 'signed_out');
    assert.equal(late.error, 'account.code_expired');
    assert.equal(a.back().step, 'signed_out');
    const none = account(softDesktopKeys(), null);
    assert.equal((await none.init()).step, 'unavailable');
    await assert.rejects(none.sendCode(EMAIL), /account_unavailable/);
  });

  it('비밀번호 로그인(ADR-038): 틀림·없는 계정은 같은 코드, 맞으면 첫 PC 등록 후 로그아웃. 기록에 비밀번호·이메일이 없다', { skip: !devStackPasswords }, async () => {
    s.close();
    s = await startDevStack({ passwords: true });
    const PW = 'mangwon-kimchi-12';
    const v0 = await s.svc.verifyEmailCode((await s.svc.startEmailCode(EMAIL)).loginId, s.mail.lastCode(EMAIL)!);
    await s.svc.setPassword(await s.svc.session(`Bearer ${v0.session}`), PW);
    const a = account();
    await a.init();
    assert.equal((await a.passwordLogin('not-an-email', PW)).error, 'account.email_shape');
    assert.equal((await a.passwordLogin(EMAIL, '')).error, 'account.password_empty');
    const wrong = await a.passwordLogin(EMAIL, 'not-the-password-1');
    const none = await a.passwordLogin('nobody@gyeonbon-test.example', PW);
    assert.equal(wrong.step, 'signed_out');
    assert.equal(wrong.error, 'account.credentials_invalid');
    assert.equal(none.error, 'account.credentials_invalid', '없는 계정도 같은 코드(열거 방지)');
    s.client.calls.length = 0;
    const ok = await a.passwordLogin(` ${EMAIL} `, PW);
    assert.deepEqual(ok, { step: 'signed_in', email: EMAIL, codeExpiresAt: null, error: null, phones: 0 });
    assert.deepEqual(s.client.calls, ['POST /v1/auth/password', 'GET /v1/device-list', 'POST /v1/aik', 'POST /v1/auth/logout']);
    const t = JSON.stringify(logs) + fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8').replace(EMAIL, '');
    for (const bad of [PW, 'not-the-password-1', 'nobody', 'sxs1.']) assert.ok(!t.includes(bad), bad);
    assert.deepEqual(logs.map(([n, d]) => [n, d.result]), [['main.account_password', 'account.credentials_invalid'], ['main.account_password', 'account.credentials_invalid'], ['main.account_enroll', 'ok']]);
    await assert.rejects(a.passwordLogin(EMAIL, PW), /account_signed_in/);
  });

  it('계정 만들기 → 비밀번호 단계(ADR-038, 인계 명세 §3): 세션은 그 단계 동안만, 정책 거부는 단계에 남고, 만들면 로그아웃. 기록에 비밀번호 없음', { skip: !devStackPasswords }, async () => {
    s.close();
    s = await startDevStack({ passwords: true });
    const PW = 'mangwon-kimchi-12';
    const a = account();
    await a.init();
    await a.sendCode(EMAIL, true);
    s.client.calls.length = 0;
    const offer = await a.verify(s.mail.lastCode(EMAIL)!);
    assert.deepEqual(offer, { step: 'set_password', email: EMAIL, codeExpiresAt: null, error: null, phones: 0 });
    assert.deepEqual(s.client.calls, ['POST /v1/auth/code/verify', 'GET /v1/device-list', 'POST /v1/aik', 'GET /v1/me'], '아직 로그아웃하지 않는다');
    assert.ok(a.identity, '등록은 이미 끝났다');
    assert.equal((await a.setPassword('')).error, 'account.password_empty');
    assert.deepEqual([(await a.setPassword('xq7!')).step, (await a.setPassword('xq7!')).error], ['set_password', 'account.password_too_short']);
    assert.equal((await a.setPassword('owner-gyeonbon-pw')).error, 'account.password_contains_identity');
    assert.equal((await a.setPassword('1234567890')).error, 'account.password_breached');
    s.client.calls.length = 0;
    assert.deepEqual(await a.setPassword(PW), { step: 'signed_in', email: EMAIL, codeExpiresAt: null, error: null, phones: 0 });
    assert.deepEqual(s.client.calls, ['PUT /v1/password', 'POST /v1/auth/logout']);
    await assert.rejects(a.setPassword(PW), /account_no_offer/);
    assert.ok((await s.client.passwordLogin(EMAIL, PW)).session, '만든 비밀번호로 로그인된다');
    const t = JSON.stringify(logs);
    for (const bad of [PW, 'xq7!', 'owner-gyeonbon-pw', '1234567890', 'sxs1.']) assert.ok(!t.includes(bad), bad);
    assert.deepEqual(logs.filter(([n]) => n === 'main.account_password_set').map(([, d]) => d.result), ['account.password_too_short', 'account.password_too_short', 'account.password_contains_identity', 'account.password_breached', 'ok']);
  });

  it('비밀번호 단계: [나중에]는 로그아웃만, 10분이 지나 서버가 재인증을 요구하면 단계를 끝내고 password_later, 코드 로그인·비밀번호가 있는 계정은 묻지 않는다', { skip: !devStackPasswords }, async () => {
    s.close();
    s = await startDevStack({ passwords: true });
    const later = account();
    await later.init();
    await later.sendCode(EMAIL, true);
    assert.equal((await later.verify(s.mail.lastCode(EMAIL)!)).step, 'set_password');
    s.client.calls.length = 0;
    assert.equal((await later.skipPassword()).step, 'signed_in');
    assert.deepEqual(s.client.calls, ['POST /v1/auth/logout']);
    assert.equal(logs.at(-1)![1].result, 'later');

    const other = 'second@gyeonbon-test.example';
    dir = await fsp.mkdtemp(path.join(root, 'u-'));
    assert.equal((await dirGuard().ensurePrivate(dir)).ok, true);
    const late = account();
    await late.init();
    await late.sendCode(other, true);
    assert.equal((await late.verify(s.mail.lastCode(other)!)).step, 'set_password');
    s.clock.t = s.clock.now() + 11 * 60_000;
    s.client.calls.length = 0;
    assert.deepEqual(await late.setPassword('mangwon-kimchi-12'), { step: 'signed_in', email: other, codeExpiresAt: null, error: 'account.password_later', phones: 0 });
    assert.deepEqual(s.client.calls, ['PUT /v1/password', 'POST /v1/auth/logout']);

    // 코드 로그인(계정 만들기가 아님)은 /v1/me를 부르지 않는다
    const third = 'third@gyeonbon-test.example';
    dir = await fsp.mkdtemp(path.join(root, 'u-'));
    assert.equal((await dirGuard().ensurePrivate(dir)).ok, true);
    const code = account();
    await code.init();
    await code.sendCode(third);
    s.client.calls.length = 0;
    assert.equal((await code.verify(s.mail.lastCode(third)!)).step, 'signed_in');
    assert.ok(!s.client.calls.includes('GET /v1/me'));

    // 이미 비밀번호가 있는 계정이면 계정 만들기 화면에서 왔어도 건너뛴다
    const fourth = 'fourth@gyeonbon-test.example';
    const v0 = await s.svc.verifyEmailCode((await s.svc.startEmailCode(fourth)).loginId, s.mail.lastCode(fourth)!);
    await s.svc.setPassword(await s.svc.session(`Bearer ${v0.session}`), 'mangwon-kimchi-12');
    dir = await fsp.mkdtemp(path.join(root, 'u-'));
    assert.equal((await dirGuard().ensurePrivate(dir)).ok, true);
    const has = account();
    await has.init();
    await has.sendCode(fourth, true);
    s.client.calls.length = 0;
    assert.equal((await has.verify(s.mail.lastCode(fourth)!)).step, 'signed_in');
    assert.deepEqual(s.client.calls.slice(-2), ['GET /v1/me', 'POST /v1/auth/logout']);
  });

  it('비밀번호 찾기(인계 명세 §4): 없는 계정도 같은 코드 단계, 틀린 코드·정책 거부는 단계에 남고, 바꾸면 다른 세션 폐기 → 첫 PC 등록 → 로그아웃. 기록에 비밀번호·코드 없음', { skip: !devStackPasswords }, async () => {
    s.close();
    s = await startDevStack({ passwords: true });
    const OLD = 'mangwon-kimchi-12';
    const NEW = 'jangdok-gimbap-77';
    const v0 = await s.svc.verifyEmailCode((await s.svc.startEmailCode(EMAIL)).loginId, s.mail.lastCode(EMAIL)!);
    await s.svc.setPassword(await s.svc.session(`Bearer ${v0.session}`), OLD);
    const other = await s.client.passwordLogin(EMAIL, OLD);

    const nobody = account();
    await nobody.init();
    const n = await nobody.startReset('nobody@gyeonbon-test.example');
    assert.equal(n.step, 'reset_code', '계정이 없어도 같은 코드 단계(열거 방지)');
    assert.equal(nobody.back().step, 'signed_out');

    const a = account();
    await a.init();
    assert.equal((await a.startReset('not-an-email')).error, 'account.email_shape');
    s.client.calls.length = 0;
    const sent = await a.startReset(` ${EMAIL} `);
    assert.deepEqual([sent.step, sent.email, sent.error], ['reset_code', EMAIL, null]);
    assert.ok(sent.codeExpiresAt! > s.clock.now());
    for (let i = 0; i < 50 && !s.mail.lastResetCode(EMAIL); i++) await new Promise((r) => setTimeout(r, 10));
    const code = s.mail.lastResetCode(EMAIL)!;
    const wrong = code === '000000' ? '111111' : '000000';
    assert.equal((await a.finishReset('12', NEW)).error, 'account.code_shape');
    assert.equal((await a.finishReset(code, '')).error, 'account.password_empty');
    assert.deepEqual([(await a.finishReset(wrong, NEW)).step, (await a.finishReset(wrong, NEW)).error], ['reset_code', 'account.code_invalid']);
    const pol = await a.finishReset(code, '1234567890');
    assert.deepEqual([pol.step, pol.error], ['reset_code', 'account.password_breached'], '정책 거부는 코드를 남긴다');
    s.client.calls.length = 0;
    assert.deepEqual(await a.finishReset(code, NEW), { step: 'signed_in', email: EMAIL, codeExpiresAt: null, error: null, phones: 0 });
    assert.deepEqual(s.client.calls, ['POST /v1/auth/password/reset/verify', 'GET /v1/device-list', 'POST /v1/aik', 'POST /v1/auth/logout']);
    await assert.rejects(s.client.me(other.session), { code: 'account.unauthorized' }, '다른 곳의 로그인은 끝났다');
    assert.ok((await s.client.passwordLogin(EMAIL, NEW)).session, '새 비밀번호로 로그인');
    await assert.rejects(a.startReset(EMAIL), /account_signed_in/);
    const t = JSON.stringify(logs);
    for (const bad of [NEW, OLD, '1234567890', code, EMAIL, 'nobody', 'sxs1.']) assert.ok(!t.includes(bad), bad);
    assert.deepEqual(logs.filter(([k]) => k === 'main.account_reset').map(([, d]) => d.result), ['sent', 'sent', 'account.code_invalid', 'account.code_invalid', 'account.password_breached', 'ok']);
  });

  it('비밀번호 찾기: 코드가 5번 틀리면 막히고(code_locked) 다시 받으면 새 코드로 이어 간다, 만료면 code_expired', { skip: !devStackPasswords }, async () => {
    s.close();
    s = await startDevStack({ passwords: true });
    const v0 = await s.svc.verifyEmailCode((await s.svc.startEmailCode(EMAIL)).loginId, s.mail.lastCode(EMAIL)!);
    await s.svc.setPassword(await s.svc.session(`Bearer ${v0.session}`), 'mangwon-kimchi-12');
    const a = account();
    await a.init();
    await a.startReset(EMAIL);
    for (let i = 0; i < 50 && !s.mail.lastResetCode(EMAIL); i++) await new Promise((r) => setTimeout(r, 10));
    const first = s.mail.lastResetCode(EMAIL)!;
    const wrong = first === '000000' ? '111111' : '000000';
    let last = '';
    for (let i = 0; i < 5; i++) last = (await a.finishReset(wrong, 'jangdok-gimbap-77')).error!;
    assert.equal(last, 'account.code_locked');
    assert.equal((await a.finishReset(first, 'jangdok-gimbap-77')).error, 'account.code_invalid', '막힌 뒤에는 맞는 코드도 안 된다');
    await a.startReset(EMAIL);
    for (let i = 0; i < 50 && s.mail.lastResetCode(EMAIL) === first; i++) await new Promise((r) => setTimeout(r, 10));
    s.clock.t = s.clock.now() + 60 * 60_000;
    const exp = await a.finishReset(s.mail.lastResetCode(EMAIL)!, 'jangdok-gimbap-77');
    assert.deepEqual([exp.step, exp.error], ['signed_out', 'account.code_expired']);
  });

  it('[로그아웃](설정 > 계정): 신원 파일·기기 토큰을 지우고 로그인 전으로(이메일 칸은 채움), 다시 켜도 로그아웃, 같은 금고로 다시 로그인하면 같은 PC', async () => {
    const seed = new Uint8Array(32).fill(9);
    const a = account(softDesktopKeys(seed));
    await signIn(a);
    const first = JSON.parse(fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8')).deviceId;
    assert.ok(a.device());
    const v = await a.signOut();
    assert.deepEqual([v.step, v.email], ['signed_out', EMAIL]);
    assert.equal(a.device(), null, '기기 범위 호출이 끊긴다');
    assert.ok(!fs.existsSync(path.join(dir, 'remote-identity.json')));
    assert.deepEqual(logs.at(-1), ['main.account_signout', { result: 'ok' }]);
    assert.equal((await account(softDesktopKeys(seed)).init()).step, 'signed_out', '다시 켜도 로그아웃');
    s.clock.advance(70 * 60_000);
    assert.equal((await signIn(account(softDesktopKeys(seed)))).step, 'signed_in');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8')).deviceId, first);
  });

  it('[로그아웃] 배선: 실제 입력 3초, 발급 실행 중이면 거부, 폰 연결 창을 닫는다, 렌더러는 설정 > 계정의 [로그아웃] → 로그인 게이트', () => {
    const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const src = read('apps/desktop/src/shell-app.ts');
    assert.match(src, /'account\.signOut': async \(\) => \{\s*needGesture\(3_000\);\s*await accountInit\(\);\s*if \(runs\.anyActive\(\)\) throw new Error\('run_active'\);\s*pairWin\?\.close\(\);\s*pairWin = null;/);
    const acct = read('apps/desktop/static/shell/shell-account.js');
    assert.match(acct, /onSignOut \? h\('div', \{ class: 'sx-actions' \}, btn\('로그아웃', onSignOut, 'sx-btn-quiet', \{ 'data-act': 'account-signout' \}\)/);
    const shell = read('apps/desktop/static/shell/shell.js');
    assert.match(shell, /accountCard\(state\.account, openLogin, openPair, signOut\)/);
    assert.match(shell, /state\.account = await call\('account\.signOut', \{\}\);\s*state\.login = null;\s*render\(\);/);
  });

  it('인증서는 만료 14일 전에 AIK로 새로 서명해 파일에 둔다', async () => {
    const keys = softDesktopKeys();
    const a = account(keys);
    await signIn(a);
    const before = JSON.parse(fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8')).cert.cert.not_after as number;
    s.clock.t = before - CERT_RENEW_MS + 1;
    a.device()!.clearToken();
    await a.device()!.auth('GET', `${ORIGIN}/v1/device-list`);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8')).cert.cert.not_after as number;
    assert.ok(after > before);
  });

  it('받은 코드는 만료까지: 앱을 껐다 켜도(새 DesktopAccount) 코드 화면으로 돌아와 같은 코드로 로그인, 파일엔 코드 없음·사용자만, 성공·[뒤로]·만료에 지운다', async () => {
    const keys = softDesktopKeys();
    const mk = () => new DesktopAccount({ client: s.client, keys: async () => keys, identity: new RemoteIdentityFile(dir), pending: new PendingCodeFile(dir), platform: 'windows', deviceName: 'Windows PC', now: s.clock.now });
    const file = path.join(dir, 'remote-pending-code.json');
    const a = mk();
    await a.init();
    const sent = await a.sendCode(EMAIL);
    await new Promise((r) => setTimeout(r, 50));
    const raw = fs.readFileSync(file, 'utf8');
    const code = s.mail.lastCode(EMAIL)!;
    assert.ok(!raw.includes(code), '코드 자체는 저장하지 않는다');
    await assertUserOnly(file);
    // 재시작
    const b = mk();
    const v = await b.init();
    assert.deepEqual([v.step, v.email, v.codeExpiresAt], ['code_sent', EMAIL, sent.codeExpiresAt]);
    // 틀린 코드(서버 거절)는 대기 정보를 지우지 않는다: 다시 켜도 같은 코드로
    assert.equal((await b.verify(code === '000000' ? '111111' : '000000')).error, 'account.code_invalid');
    const c = mk();
    assert.equal((await c.init()).step, 'code_sent');
    assert.equal((await c.verify(code)).step, 'signed_in');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(file), false, '성공하면 지운다');
    // [뒤로]도 지운다
    const d = new DesktopAccount({ client: s.client, keys: async () => softDesktopKeys(), identity: new RemoteIdentityFile(await fsp.mkdtemp(path.join(root, 'u-'))), pending: new PendingCodeFile(dir), platform: 'windows', deviceName: 'Windows PC', now: s.clock.now });
    await d.init();
    await d.sendCode('other@gyeonbon-test.example');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(file), true);
    d.back();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(file), false, '[뒤로]면 지운다');
    // 만료·모양이 틀린 파일은 버린다
    const f = new PendingCodeFile(dir);
    await f.save({ email: EMAIL, loginId: 'L', expiresAt: s.clock.now() - 1, signup: false });
    assert.equal(await f.load(s.clock.now()), null);
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, '{"email":"x","loginId":"L","expiresAt":1,"signup":false}');
    assert.equal(await f.load(s.clock.now()), null);
  });

  it('로그에 이메일·코드·토큰이 없다', async () => {
    await signIn(account());
    const t = JSON.stringify(logs);
    for (const bad of [EMAIL, 'gyeonbon', s.mail.lastCode(EMAIL)!, 'sxd1.']) assert.ok(!t.includes(bad), bad);
    assert.deepEqual(logs, [['main.account_code', { result: 'sent' }], ['main.account_enroll', { result: 'ok' }]]);
  });
});

describe('셸 배선(소스 검사)', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/src/shell-app.ts'), 'utf8');
  const js = fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/static/shell/shell-account.js'), 'utf8');
  it('코드 보내기·확인은 실제 입력 뒤 3초 안에만, 인자는 이메일·코드 하나씩', async () => {
    const { SHELL_METHODS, USER_ACTION_METHODS } = await import('../apps/desktop/src/ipc.ts');
    assert.equal(USER_ACTION_METHODS['account.sendCode'], 3_000);
    assert.equal(USER_ACTION_METHODS['account.verify'], 3_000);
    assert.deepEqual(Object.keys(SHELL_METHODS['account.sendCode']), ['email', 'signup']);
    assert.deepEqual(Object.keys(SHELL_METHODS['account.verify']), ['code']);
    assert.match(src, /'account\.sendCode': async \(p\) => \{\s*needGesture\(3_000\);/);
    // 6자리 확인은 클릭·Enter·Space 또는 메인 창 키 입력(숫자·붙여 넣기) 3초 안(0.1.5 실사용: 칸을 누르고 메일을 보는 사이 3초가 지난다). 다른 명령은 그대로 needGesture.
    assert.match(src, /'account\.verify': async \(p\) => \{[^}]*?needTyping\(3_000\);/);
    assert.match(src, /'account\.finishReset': async \(p\) => \{[^}]*?needTyping\(3_000\);/);
    assert.equal((src.match(/needTyping\(/g) ?? []).length, 2, 'account.verify·account.finishReset 둘뿐');
    assert.match(src, /if \(isTypingKey\(i\)\) typing\.note\(performance\.now\(\)\);/);
    assert.match(src, /if \(isGestureKey\(i\)\) gesture\.note\(performance\.now\(\)\);/);
  });
  it('코드 화면: 칸 바로 아래 [확인](6자리면 켜짐), 서버가 코드를 거절한 때만 칸을 비우고, 입력을 못 봐 거절되면 "[확인]을 눌러 주세요"', () => {
    const shell = fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/static/shell/shell.js'), 'utf8');
    assert.match(js, /const ok = primary\('확인', \(\) => !busy && verify\(draft\.code \?\? ''\), 'account-verify', busy \|\| !\/\^\\d\{6\}\$\/\.test\(draft\.code \?\? ''\)\);/);
    assert.match(js, /codeField\(ctx, busy, verify, \(c\) => \(ok\.disabled = busy \|\| !\/\^\\d\{6\}\$\/\.test\(c\)\)\),\s*ok,\s*errNote\(err === 'gesture_required' \? 'account\.confirm_click' : err\)/);
    assert.match(js, /'account\.confirm_click': '\[확인\]을 눌러 주세요'/);
    assert.match(shell, /const SERVER_CODE_ERR = new Set\(\['account\.code_invalid', 'account\.code_locked', 'account\.code_expired'\]\);/);
    assert.match(shell, /if \(method === 'account\.verify' && \(SERVER_CODE_ERR\.has\(state\.account\?\.error\) \|\| state\.account\?\.step === 'set_password'\)\) l\.draft\.code = '';/);
  });
  it('비밀번호는 실제 입력 뒤 3초 안에만, 인자는 이메일·비밀번호 둘, 문자열로 다시 만들지 않고 계정 객체로만 넘긴다', async () => {
    const { SHELL_METHODS, USER_ACTION_METHODS } = await import('../apps/desktop/src/ipc.ts');
    assert.equal(USER_ACTION_METHODS['account.password'], 3_000);
    assert.deepEqual(Object.keys(SHELL_METHODS['account.password']), ['email', 'password']);
    assert.match(src, /'account\.password': async \(p\) => \{\s*needGesture\(3_000\);\s*await accountInit\(\);\s*return account\.passwordLogin\(String\(p\.email\), p\.password\);\s*\}/);
  });
  it('로그인 화면: 비밀번호는 보낸 뒤 비우고, 틀림·없는 계정·잠금은 한 안내(안에 [이메일 코드로 로그인])', () => {
    const shell = fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/static/shell/shell.js'), 'utf8');
    assert.match(shell, /if \(method === 'account\.password' \|\| method === 'account\.setPassword' \|\| method === 'account\.finishReset'\) l\.draft\.password = '';/);
    assert.match(js, /const wrong = err === 'account\.credentials_invalid';/);
    assert.match(js, /'이메일 또는 비밀번호가 맞지 않아요'[\s\S]{0,200}'이메일 코드로는 바로 로그인할 수 있어요'[\s\S]{0,200}'account-code-from-wrong'/);
    assert.doesNotMatch(js, /'[^'\n]*(잠겼|잠금|잠시 잠)[^'\n]*'/, '잠금은 화면 문구로 따로 알리지 않는다(ADR-038 (d))');
  });
  it('비밀번호 만들기: 실제 입력 뒤 3초 안에만, 인자는 비밀번호 하나, 계정 객체로만 넘긴다. 렌더러는 보낸 뒤 비운다', async () => {
    const { SHELL_METHODS, USER_ACTION_METHODS } = await import('../apps/desktop/src/ipc.ts');
    assert.equal(USER_ACTION_METHODS['account.setPassword'], 3_000);
    assert.deepEqual(Object.keys(SHELL_METHODS['account.setPassword']), ['password']);
    assert.deepEqual(Object.keys(SHELL_METHODS['account.skipPassword']), []);
    assert.match(src, /'account\.setPassword': async \(p\) => \{\s*needGesture\(3_000\);\s*await accountInit\(\);\s*return account\.setPassword\(p\.password\);\s*\}/);
    const shell = fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/static/shell/shell.js'), 'utf8');
    assert.match(shell, /if \(method === 'account\.password' \|\| method === 'account\.setPassword' \|\| method === 'account\.finishReset'\) l\.draft\.password = '';/);
    assert.match(js, /autocomplete: 'new-password'/);
    assert.doesNotMatch(js, /한 번 더/, '확인 칸은 없다(제안 2)');
  });
  it('비밀번호 찾기: 코드 받기·바꾸기는 실제 입력 뒤 3초 안에만, 인자는 이메일 / 코드·비밀번호, 렌더러는 보낸 뒤 비밀번호를 비운다', async () => {
    const { SHELL_METHODS, USER_ACTION_METHODS } = await import('../apps/desktop/src/ipc.ts');
    assert.equal(USER_ACTION_METHODS['account.startReset'], 3_000);
    assert.equal(USER_ACTION_METHODS['account.finishReset'], 3_000);
    assert.deepEqual(Object.keys(SHELL_METHODS['account.startReset']), ['email']);
    assert.deepEqual(Object.keys(SHELL_METHODS['account.finishReset']), ['code', 'password']);
    assert.match(src, /'account\.finishReset': async \(p\) => \{\s*(\/\/[^\n]*\n\s*)?needTyping\(3_000\);\s*await accountInit\(\);\s*return account\.finishReset\(String\(p\.code\), p\.password\);\s*\}/);
    const shell = fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/static/shell/shell.js'), 'utf8');
    assert.match(shell, /method === 'account\.finishReset'\) l\.draft\.password = '';/);
  });
  it('금고 키 연결이 없으면 계정 클라이언트도 쓰지 않는다(unavailable), 키는 금고 control로만', () => {
    assert.match(src, /client: opts\.remote\?\.keys \? \(opts\.remote\.cloud\?\.account \?\? null\) : null/);
    assert.match(src, /f\(\(m, p\) => host\.control\(m, p\)\)/);
  });
  it('로그인 화면은 HTML로 그리지 않고, 오류 코드를 그대로 보이지 않는다', () => {
    assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML/);
    assert.match(js, /ERR\[code\] \?\?/);
  });
});
