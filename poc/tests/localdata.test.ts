// PoC-5 로컬 데이터: 경로·접근 통제(D07 §1.1), 암호화 SQLite(D07 §1.3), 프로필·거래처 CRUD, 진위확인(H-05).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { isEncryptedFile, isValidBizNo, openDatabase, syntheticBizNo, type Db } from '@sax/db';
import { BizVerifier, DataService, READ_QUERIES } from '@sax/engine';
import { Egress, EgressError } from '@sax/net';
import { appPaths, defaultAppRoot, dirGuard, findReparsePoint, isTrustedOwner, parseDacl, prepareLayout, preparePrivateDir, readDacl, readOwner, windowsTool, type AclCheck, type DirGuard } from '@sax/platform';
import { scanDir } from '@sax/vault';

const run = promisify(execFile);
const win = process.platform === 'win32';

async function tmpRoot(): Promise<string> {
  const base = await fs.realpath(os.tmpdir());
  return fs.mkdtemp(path.join(base, 'sax-data-'));
}

describe('경로와 접근 통제', () => {
  it('기본 루트: Windows %LOCALAPPDATA%\\SovereignAX, macOS ~/Library/Application Support/SovereignAX', () => {
    const prev = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = 'C:\\Users\\u\\AppData\\Local';
    assert.equal(defaultAppRoot('win32'), 'C:\\Users\\u\\AppData\\Local\\SovereignAX');
    process.env.LOCALAPPDATA = prev;
    assert.equal(defaultAppRoot('darwin'), path.join(os.homedir(), 'Library', 'Application Support', 'SovereignAX'));
    const p = appPaths('/r');
    assert.deepEqual([p.db, p.vault, p.chromeProfile, p.staging, p.logs].map((x) => path.basename(x)), ['db', 'vault', 'chrome-profile', 'staging', 'logs']);
  });

  it('prepareLayout: 루트 소유자 전용(0700·DACL), 하위 폴더, staging 잔존 정리, 색인 제외', async () => {
    const root = path.join(await tmpRoot(), 'SovereignAX');
    const first = await prepareLayout(root);
    assert.equal(first.root.ok, true);
    if (!win) assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    await fs.writeFile(path.join(first.paths.staging, 'left.pdf'), 'x');
    // 다른 사용자 읽기 허용으로 망가뜨린 뒤. Windows는 명시 ACE(Users 읽기)를 더한다.
    if (win) await run(windowsTool('icacls.exe'), [root, '/grant', '*S-1-5-32-545:(OI)(CI)R']);
    else await fs.chmod(root, 0o755);
    assert.equal((await dirGuard().checkPrivate(root)).ok, false, '망가진 ACL을 잡는다');
    const second = await prepareLayout(root);
    assert.equal(second.root.ok, true, '기동 시 복구');
    if (!win) assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    assert.equal(second.stagingCleared, 1);
    if (process.platform === 'darwin') await fs.access(path.join(root, '.metadata_never_index'));
    if (win) {
      const { stdout } = await run(windowsTool('attrib.exe'), [root]);
      assert.ok(stdout.includes(root), stdout);
      assert.match(stdout.slice(0, stdout.indexOf(root)), /I/, 'FILE_ATTRIBUTE_NOT_CONTENT_INDEXED');
    }
  });

  it('SDDL DACL 파서: 레이블(S:)은 무시, 조건부·거부·읽지 못한 ACE와 null DACL은 남긴다', () => {
    const me = 'S-1-5-21-1-2-3-1001';
    const clean = parseDacl(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${me})S:AI(ML;OICI;NW;;;LW)`);
    assert.deepEqual(clean, { protected: true, aces: [{ type: 'A', flags: ['OI', 'CI'], sid: 'SY' }, { type: 'A', flags: ['OI', 'CI'], sid: me }] });
    const cond = parseDacl(`D:PAI(XA;OICI;FR;;;WD;(Exists Foo))(A;OICI;FA;;;${me})`);
    assert.deepEqual(cond.aces.map((a) => [a.type, a.sid]), [['XA', 'WD'], ['A', me]]);
    assert.deepEqual(parseDacl('D:PAI(D;;FR;;;BU)').aces.map((a) => [a.type, a.sid]), [['D', 'BU']]);
    const inherited = parseDacl('D:AI(A;OICIID;FA;;;BA)');
    assert.equal(inherited.protected, false);
    assert.deepEqual(inherited.aces[0]?.flags, ['OI', 'CI', 'ID']);
    assert.deepEqual(parseDacl('D:NO_ACCESS_CONTROL').aces.map((a) => a.sid), ['WD']);
    assert.deepEqual(parseDacl('D:PAI(A;OICI;FA;;').aces.map((a) => a.sid), ['?']);
    assert.deepEqual(parseDacl('').aces.map((a) => a.sid), ['?']);
  });

  it('Windows 소유자 판정: 사용자·SYSTEM·Administrators만 받아들인다', () => {
    const me = 'S-1-5-21-1-2-3-1001';
    assert.equal(isTrustedOwner(me, me), true);
    assert.equal(isTrustedOwner('S-1-5-18', me), true);
    assert.equal(isTrustedOwner('S-1-5-32-544', me), true);
    assert.equal(isTrustedOwner('S-1-5-21-1-2-3-1002', me), false, '다른 로컬 계정');
    assert.equal(isTrustedOwner('', me), false, '소유자 없음');
  });

  it('Windows: 다른 계정 소유 폴더는 not_owner', { skip: !win }, async () => {
    // 비승격 테스트에서는 다른 계정 소유 폴더를 만들 수 없다. TrustedInstaller 소유 시스템 폴더를 읽기만 한다.
    const sysDir = process.env.SystemRoot ?? 'C:\\Windows';
    assert.match(await readOwner(sysDir), /^S-1-5-80-/);
    assert.ok((await dirGuard().checkPrivate(sysDir)).problems.includes('not_owner'));
  });

  it('Windows: 거부 ACE·조건부 ACE도 잡고 기동 시 지운다', { skip: !win }, async () => {
    const root = path.join(await tmpRoot(), 'SovereignAX');
    assert.equal((await prepareLayout(root)).root.ok, true);
    assert.match(await readOwner(root), /^S-1-5-21-/, '사용자가 만든 폴더의 소유자는 사용자');
    await run(windowsTool('icacls.exe'), [root, '/deny', '*S-1-5-32-546:(W)']); // Guests 쓰기 거부
    assert.deepEqual((await dirGuard().checkPrivate(root)).problems, ['extra_principal']);
    assert.equal((await prepareLayout(root)).root.ok, true, '거부 ACE 복구');
    const ps = windowsTool('WindowsPowerShell\\v1.0\\powershell.exe');
    const sddl = (await readDacl(root)).aces.map((a) => `(${a.type};${a.flags.join('')};FA;;;${a.sid})`).join('');
    // Get-Acl 객체는 SACL까지 다시 쓰려 해 SeSecurityPrivilege가 필요하다. DACL만 담은 새 객체로 쓴다.
    const script = `$a = New-Object System.Security.AccessControl.DirectorySecurity; $a.SetSecurityDescriptorSddlForm('D:PAI(XA;OICI;FR;;;WD;(Exists Foo))${sddl}', 'Access'); [System.IO.Directory]::SetAccessControl('${root}', $a)`;
    await run(ps, ['-NoProfile', '-NonInteractive', '-Command', script]);
    assert.ok((await readDacl(root)).aces.some((a) => a.type === 'XA' && a.sid === 'WD'), 'Everyone 조건부 허용이 보인다');
    assert.deepEqual((await dirGuard().checkPrivate(root)).problems, ['extra_principal']);
    assert.equal((await prepareLayout(root)).root.ok, true, '조건부 ACE 복구');
    await run(windowsTool('icacls.exe'), [root, '/setintegritylevel', '(OI)(CI)L']); // SACL 레이블은 DACL 판정에 섞이지 않는다
    assert.equal((await dirGuard().checkPrivate(root)).ok, true, '무결성 레이블 오탐 없음');
  });

  it('재분석 지점(심볼릭 링크·정션)이 경로에 있으면 거부', async () => {
    const base = await tmpRoot();
    await fs.mkdir(path.join(base, 'real'));
    // Windows 심볼릭 링크는 권한(개발자 모드)이 필요하다. 권한 없이 만들 수 있는 정션으로 확인한다.
    await fs.symlink(path.join(base, 'real'), path.join(base, 'link'), win ? 'junction' : undefined);
    assert.equal(await findReparsePoint(path.join(base, 'link', 'SovereignAX')), path.join(base, 'link'));
    const r = await dirGuard().ensurePrivate(path.join(base, 'link', 'SovereignAX'));
    assert.deepEqual(r, { ok: false, problems: ['reparse_point'] });
  });

  it('prepareLayout: 하위 폴더 자리의 파일·링크는 치우고 새로 만든다, staging 링크 대상은 지우지 않는다', async () => {
    const base = await tmpRoot();
    const root = path.join(base, 'SovereignAX');
    const { paths } = await prepareLayout(root);
    const outside = path.join(base, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
    await fs.rm(paths.staging, { recursive: true });
    await fs.symlink(outside, paths.staging, win ? 'junction' : 'dir');
    await fs.rm(paths.db, { recursive: true });
    await fs.writeFile(paths.db, 'x');
    const r = await prepareLayout(root);
    assert.equal(r.root.ok, true);
    assert.equal(r.setAside.length, 2);
    assert.equal(r.stagingCleared, 0);
    for (const p of [paths.staging, paths.db]) assert.equal((await fs.lstat(p)).isDirectory(), true);
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep', '링크 대상은 그대로');
    await fs.rm(base, { recursive: true, force: true });
  });

  it('preparePrivateDir: 맞으면 손대지 않고, 권한만 틀리면 제자리에서 고친다', async () => {
    const base = await tmpRoot();
    const { paths } = await prepareLayout(path.join(base, 'SovereignAX'));
    const real = dirGuard();
    let ensures = 0;
    const spy: DirGuard = {
      checkPrivate: (d) => real.checkPrivate(d),
      ensurePrivate: (d) => (ensures++, real.ensurePrivate(d)),
      excludeFromIndex: (d) => real.excludeFromIndex(d),
    };
    await preparePrivateDir(paths.chromeProfile, spy); // Windows는 여기서 루트에서 받은 상속 ACE를 끊는다
    ensures = 0;
    const again = await preparePrivateDir(paths.chromeProfile, spy);
    assert.deepEqual([again.check.ok, again.before, again.setAside, ensures], [true, [], undefined, 0], '맞으면 DACL을 다시 쓰지 않는다');
    if (win) await run(windowsTool('icacls.exe'), [paths.chromeProfile, '/grant', '*S-1-5-32-545:(OI)(CI)R']);
    else await fs.chmod(paths.chromeProfile, 0o755);
    const fixed = await preparePrivateDir(paths.chromeProfile, spy);
    assert.equal(fixed.check.ok, true);
    assert.ok(fixed.before.length > 0, fixed.before.join());
    assert.deepEqual([fixed.setAside, ensures], [undefined, 1], '제자리 복구');
    await fs.rm(base, { recursive: true, force: true });
  });

  it('preparePrivateDir: 폴더 자리의 파일·링크(정션)는 따라가지 않고 치운 뒤 새로 만든다', async () => {
    const base = await tmpRoot();
    const { paths } = await prepareLayout(path.join(base, 'SovereignAX'));
    const outside = path.join(base, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
    for (const kind of ['file', 'link', 'dangling'] as const) {
      await fs.rm(paths.chromeProfile, { recursive: true, force: true });
      if (kind === 'file') await fs.writeFile(paths.chromeProfile, 'x');
      else await fs.symlink(kind === 'link' ? outside : path.join(base, 'gone'), paths.chromeProfile, win ? 'junction' : 'dir');
      const r = await preparePrivateDir(paths.chromeProfile);
      assert.equal(r.check.ok, true, kind);
      assert.deepEqual(r.before, [kind === 'file' ? 'not_dir' : 'reparse_point'], kind);
      const moved = await fs.lstat(path.join(paths.root, r.setAside!));
      assert.equal(kind === 'file' ? moved.isFile() : moved.isSymbolicLink(), true, `${kind}: 원래 항목을 그대로 옮긴다`);
      assert.equal((await fs.lstat(paths.chromeProfile)).isDirectory(), true);
    }
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep', '링크 대상은 그대로');
    await fs.rm(base, { recursive: true, force: true });
  });

  // 비승격·비루트로는 다른 계정 소유 폴더를 만들 수 없다. 표식 파일이 든 폴더를 다른 계정 소유로 보는 대역으로 흐름을 확인한다.
  const NOT_OWNER: AclCheck = { ok: false, problems: ['not_owner'] };
  const planted = (d: string) => fs.access(path.join(d, 'planted')).then(() => true, () => false);

  it('preparePrivateDir: 다른 계정 소유 폴더는 고치려 하지 않고 치운 뒤 새로 만든다', async () => {
    const base = await tmpRoot();
    const { paths } = await prepareLayout(path.join(base, 'SovereignAX'));
    await fs.writeFile(path.join(paths.chromeProfile, 'planted'), 'x');
    const real = dirGuard();
    const ensured: string[] = [];
    const guard: DirGuard = {
      checkPrivate: async (d) => ((await planted(d)) ? NOT_OWNER : real.checkPrivate(d)),
      ensurePrivate: async (d) => (ensured.push(d), (await planted(d)) ? NOT_OWNER : real.ensurePrivate(d)),
      excludeFromIndex: (d) => real.excludeFromIndex(d),
    };
    const r = await preparePrivateDir(paths.chromeProfile, guard);
    assert.deepEqual([r.check.ok, r.before], [true, ['not_owner']]);
    assert.equal(ensured.length, 1, '다른 계정 소유 폴더에는 제자리 복구를 하지 않고 새 폴더에만 한다');
    assert.ok(await planted(path.join(paths.root, r.setAside!)), '치운 폴더 내용은 그대로');
    assert.equal(await planted(paths.chromeProfile), false);
    await fs.rm(base, { recursive: true, force: true });
  });

  it('preparePrivateDir: 이 폴더에서만 도구가 실패하면(접근 거부) 우리 것이 아닌 것으로 보고 치운다', async () => {
    const base = await tmpRoot();
    const { paths } = await prepareLayout(path.join(base, 'SovereignAX'));
    const real = dirGuard();
    const denied = () => Promise.reject(new Error('icacls: Access is denied'));
    // Windows에서 원래 소유자 전용 DACL(복원·계정 재생성)이면 확인이 예외로 끝난다. 우리 소유라도 OW ACE가 막으면 복구가 예외로 끝난다.
    for (const where of ['check', 'ensure'] as const) {
      await fs.writeFile(path.join(paths.chromeProfile, 'planted'), 'x');
      const guard: DirGuard = {
        checkPrivate: async (d) => ((await planted(d)) ? (where === 'check' ? denied() : { ok: false, problems: ['extra_principal'] }) : real.checkPrivate(d)),
        ensurePrivate: async (d) => ((await planted(d)) ? denied() : real.ensurePrivate(d)),
        excludeFromIndex: (d) => real.excludeFromIndex(d),
      };
      const r = await preparePrivateDir(paths.chromeProfile, guard);
      assert.deepEqual([r.check.ok, r.before, r.reason], [true, [where === 'check' ? 'unreadable' : 'extra_principal'], ['unreadable']], where);
      assert.ok(await planted(path.join(paths.root, r.setAside!)), `${where}: 치운 폴더 내용은 그대로`);
    }
    // 한 번만 실패한 도구(PowerShell 기동 실패 등)로는 치우지 않는다.
    await fs.writeFile(path.join(paths.chromeProfile, 'keep'), 'x');
    let fails = 1;
    const flaky: DirGuard = {
      checkPrivate: async (d) => (d === paths.chromeProfile && fails-- > 0 ? denied() : real.checkPrivate(d)),
      ensurePrivate: (d) => real.ensurePrivate(d),
      excludeFromIndex: (d) => real.excludeFromIndex(d),
    };
    const r = await preparePrivateDir(paths.chromeProfile, flaky);
    assert.deepEqual([r.check.ok, r.before, r.setAside], [true, ['unreadable'], undefined]);
    await fs.access(path.join(paths.chromeProfile, 'keep'));
    await fs.rm(base, { recursive: true, force: true });
  });

  it('preparePrivateDir: 부모가 사용자 전용이 아니거나 새 폴더도 맞지 않으면 되돌리고 실패, 도구 고장은 예외 그대로', async () => {
    const base = await tmpRoot();
    const { paths } = await prepareLayout(path.join(base, 'SovereignAX'));
    const child = paths.chromeProfile;
    await fs.writeFile(path.join(child, 'planted'), 'x');
    const OK: AclCheck = { ok: true, problems: [] };
    const guard = (check: (d: string) => AclCheck | Promise<AclCheck>, ensure: () => AclCheck | Promise<AclCheck>): DirGuard => ({
      checkPrivate: async (d) => check(d),
      ensurePrivate: async () => ensure(),
      excludeFromIndex: async () => {},
    });
    const untrusted = async () => (await fs.readdir(paths.root)).filter((n) => n.startsWith('chrome-profile.untrusted-'));
    const parentOpen = await preparePrivateDir(child, guard(() => NOT_OWNER, () => NOT_OWNER));
    assert.deepEqual([parentOpen.check.ok, parentOpen.setAside], [false, undefined], '부모가 사용자 전용이 아니면 치우지 않는다');
    const stillForeign = await preparePrivateDir(child, guard((d) => (d === child ? NOT_OWNER : OK), () => NOT_OWNER));
    assert.deepEqual([stillForeign.check.ok, stillForeign.reason, stillForeign.setAside], [false, ['not_owner'], undefined], '새 폴더도 맞지 않으면 되돌린다');
    // 쓰기 도구만 막힌 환경(EDR 등): 확인은 되는데 복구가 예외. 새 폴더도 같은 예외면 원래 프로필을 되돌려 놓고 예외를 낸다.
    const aclOff: AclCheck = { ok: false, problems: ['extra_principal'] };
    const writeBlocked = () => Promise.reject(new Error('icacls blocked'));
    await assert.rejects(preparePrivateDir(child, guard((d) => (d === child ? aclOff : OK), writeBlocked)), /icacls blocked/);
    assert.ok(await planted(child), '원래 프로필이 제자리에 있다');
    assert.deepEqual(await untrusted(), [], '되돌렸으므로 쌓이지 않는다');
    // 제자리 복구가 예외 없이 실패를 돌려주면 새 폴더도 같은 방법으로 고치게 되므로 치우지 않는다.
    const stuck = await preparePrivateDir(child, guard((d) => (d === child ? aclOff : OK), () => aclOff));
    assert.deepEqual([stuck.check.ok, stuck.setAside], [false, undefined]);
    // 도구가 부모에서도 실패하면(PowerShell 차단 등) 폴더 탓이 아니다. 치우지 않고 예외를 그대로 낸다.
    const broken = () => Promise.reject(new Error('powershell blocked'));
    await assert.rejects(preparePrivateDir(child, guard(broken, () => OK)), /powershell blocked/);
    await assert.rejects(preparePrivateDir(child, guard((d) => (d === child ? broken() : NOT_OWNER), () => OK)), /powershell blocked/, '부모가 사용자 전용이 아니면 원래 예외');
    assert.ok(await planted(child));
    assert.deepEqual(await untrusted(), []);
    await fs.rm(base, { recursive: true, force: true });
  });

  it('macOS: 프로필의 ACL 항목(누구나 거부)은 제자리에서 지운다', { skip: process.platform !== 'darwin' }, async () => {
    const base = await tmpRoot();
    const { paths } = await prepareLayout(path.join(base, 'SovereignAX'));
    await run('/bin/chmod', ['+a', 'everyone deny delete', paths.chromeProfile]);
    assert.deepEqual((await dirGuard().checkPrivate(paths.chromeProfile)).problems, ['extra_principal']);
    const r = await preparePrivateDir(paths.chromeProfile);
    assert.deepEqual([r.check.ok, r.before, r.setAside], [true, ['extra_principal'], undefined]);
    await fs.rm(base, { recursive: true, force: true });
  });

  it('Windows: 우리를 막는 DACL(OWNER RIGHTS로 소유자 권한 제거)인 폴더는 치우고 새로 만든다', { skip: !win }, async () => {
    const base = await tmpRoot();
    const { paths } = await prepareLayout(path.join(base, 'SovereignAX'));
    // SYSTEM만 전체, 소유자에게는 SYNCHRONIZE·FILE_WRITE_ATTRIBUTES만. 우리 소유여도 READ_CONTROL·WRITE_DAC가 없어 icacls·Get-Acl이 실패한다.
    // FILE_WRITE_ATTRIBUTES는 정리용이다(libuv 1.48+ rmdir이 이 권한으로 연다). 우리에게 아무것도 주지 않는 실제 다른 계정 폴더는 PoC-1 §5.1 확인 항목.
    const script = "$s = New-Object System.Security.AccessControl.DirectorySecurity; $s.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;SY)(A;;0x100100;;;OW)', 'Access'); [System.IO.Directory]::SetAccessControl($env:SAX_ACL_TARGET, $s)";
    await run(windowsTool('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, SAX_ACL_TARGET: paths.chromeProfile } });
    await assert.rejects(dirGuard().checkPrivate(paths.chromeProfile), '확인 도구가 이 폴더에서 실패한다');
    const r = await preparePrivateDir(paths.chromeProfile);
    assert.deepEqual([r.check.ok, r.before, r.reason], [true, ['unreadable'], ['unreadable']]);
    assert.ok(r.setAside);
    await fs.rm(base, { recursive: true, force: true }); // 치운 빈 폴더: DELETE는 부모의 FILE_DELETE_CHILD, 나머지는 OW ACE로
  });
});

describe('암호화 DB와 CRUD', () => {
  let root: string;
  let file: string;
  let key: Uint8Array;
  let db: Db;
  let svc: DataService;

  before(async () => {
    root = await tmpRoot();
    const { paths } = await prepareLayout(root);
    file = path.join(paths.db, 'db.sqlite');
    key = new Uint8Array(randomBytes(32));
    db = openDatabase(file, key);
    svc = new DataService(db, new BizVerifier(new Egress()));
  });

  after(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('sqlcipher·temp_store=MEMORY·파일 권한 0600(Windows는 루트 DACL 상속), 평문 SQLite 서명 없음', async () => {
    assert.equal(db.pragma('cipher', { simple: true }), 'sqlcipher');
    assert.equal(db.pragma('temp_store', { simple: true }), 2);
    assert.equal(isEncryptedFile(file), true);
    if (!win) return assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const { stdout } = await run(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    const me = stdout.trim().split(',').pop()?.replace(/"/g, '');
    const sids = (await readDacl(file)).aces.map((a) => a.sid);
    assert.ok(sids.length > 0 && sids.every((s) => s === me || s === 'SY'), `DB 파일 ACE: ${sids.join(', ')}`);
  });

  it('프로필: 개인 1 + 사업자 1, 같은 종류는 갱신, 사업자번호 검증', async () => {
    const biz = syntheticBizNo(42);
    assert.ok(isValidBizNo(biz));
    const b = (await svc.handle('profile.upsert', { kind: 'business', displayName: '관계사(PoC)', bizNo: biz, repName: '김대표', email: 'tax@example.com', signMethod: 'cert' })) as { id: string; bizNo: string };
    assert.equal(b.bizNo, biz);
    const pers = (await svc.handle('profile.upsert', { kind: 'personal', displayName: '본인', bizNo: biz })) as { bizNo: string | null };
    assert.equal(pers.bizNo, null, '개인 프로필에는 사업자번호를 두지 않는다');
    const b2 = (await svc.handle('profile.upsert', { kind: 'business', displayName: '관계사(이름변경)', bizNo: biz })) as { id: string; displayName: string };
    assert.equal(b2.id, b.id);
    assert.equal(((await svc.handle('db.query.profiles.list', {})) as unknown[]).length, 2);
    await assert.rejects(svc.handle('profile.upsert', { kind: 'business', displayName: 'x', bizNo: '123-45-67890' }), /invalid_biz_no/);
    await assert.rejects(svc.handle('profile.upsert', { kind: 'business', displayName: 'x', bizNo: biz, email: 'bad' }), /invalid_email/);
    assert.equal(db.prepare('SELECT keep_session FROM profiles WHERE id=?').pluck().get(b.id), 0, 'keep_session 기본 꺼짐');
  });

  it('거래처: 생성·검색·수정·중복 거부·삭제', async () => {
    const a = (await svc.handle('counterparty.create', { bizNo: syntheticBizNo(7), name: '가나상사', repName: '이가나', email: 'a@example.com' })) as { id: string };
    await svc.handle('counterparty.create', { bizNo: syntheticBizNo(8), name: '다라테크', source: 'ocr' });
    await assert.rejects(svc.handle('counterparty.create', { bizNo: syntheticBizNo(7), name: 'dup' }), /duplicate_biz_no/);
    await assert.rejects(svc.handle('counterparty.create', { bizNo: '1234567890', name: 'bad' }), /invalid_biz_no/);
    const found = (await svc.handle('db.query.counterparties.list', { q: '가나' })) as Array<{ name: string }>;
    assert.deepEqual(found.map((c) => c.name), ['가나상사']);
    const byNo = (await svc.handle('db.query.counterparties.list', { q: syntheticBizNo(8).slice(0, 5) })) as Array<{ source: string }>;
    assert.equal(byNo[0]?.source, 'ocr');
    svc.counterparties.setVerification(a.id, 'valid:01');
    const u = (await svc.handle('counterparty.update', { id: a.id, patch: { repName: '이가나2' } })) as { repName: string; verifiedStatus: string | null };
    assert.equal(u.repName, '이가나2');
    assert.equal(u.verifiedStatus, null, '대표자가 바뀌면 진위확인을 다시 해야 한다');
    assert.equal(await svc.handle('counterparty.delete', { id: a.id }), true);
    assert.equal(await svc.handle('db.query.counterparties.get', { id: a.id }), null);
  });

  it('다른 키로는 열리지 않고, 같은 키로 다시 열면 데이터가 남아 있다. 디스크에 평문 없음', async () => {
    const marker = '평문표지-' + randomBytes(4).toString('hex');
    await svc.handle('counterparty.create', { bizNo: syntheticBizNo(99), name: marker });
    db.close();
    assert.throws(() => openDatabase(file, new Uint8Array(randomBytes(32))), /not a database|file is not a database|SQLITE_NOTADB/i);
    const scan = await scanDir(path.dirname(file), [marker]);
    assert.ok(scan.files >= 1);
    assert.deepEqual(scan.findings, [], 'DB·WAL 파일에 평문 없음');
    db = openDatabase(file, key);
    svc = new DataService(db, new BizVerifier(new Egress()));
    const again = (await svc.handle('db.query.counterparties.list', { q: marker })) as unknown[];
    assert.equal(again.length, 1);
  });

  it('main 읽기 IPC 목록은 읽기 전용 질의만이다', () => {
    for (const q of READ_QUERIES) assert.match(q, /^db\.query\./);
  });
});

describe('사업자 진위확인(H-05, 자기 키, 모의 서버)', () => {
  let server: http.Server;
  let origin: string;
  const seen: Array<{ url: string; auth: string | undefined; body: unknown }> = [];
  const KEY = 'TEST-ODCLOUD-' + randomBytes(6).toString('hex');

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c));
      req.on('end', () => {
        const json = JSON.parse(body || '{}') as Record<string, unknown>;
        seen.push({ url: req.url ?? '', auth: req.headers.authorization, body: json });
        if (req.headers.authorization !== `Infuser ${KEY}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end('{"code":-4,"msg":"등록되지 않은 인증키 입니다."}');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/api/nts-businessman/v1/status') {
          return res.end(JSON.stringify({ status_code: 'OK', match_cnt: 1, request_cnt: 1, data: (json.b_no as string[]).map((b) => ({ b_no: b, b_stt: '계속사업자', b_stt_cd: '01', tax_type: '부가가치세 일반과세자', end_dt: '' })) }));
        }
        const biz = (json.businesses as Array<Record<string, string>>)[0]!;
        const ok = biz.p_nm === '이가나' && biz.start_dt === '20200101';
        return res.end(JSON.stringify({ status_code: 'OK', request_cnt: 1, valid_cnt: ok ? 1 : 0, data: [{ b_no: biz.b_no, valid: ok ? '01' : '02', valid_msg: ok ? '' : '확인할 수 없습니다.', request_param: biz, status: ok ? { b_no: biz.b_no, b_stt: '계속사업자', b_stt_cd: '01', tax_type: '부가가치세 일반과세자', end_dt: '' } : undefined }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('키 없으면 no_key, 키는 Authorization 헤더로만 가고 URL에 없다', async () => {
    const v = new BizVerifier(new Egress({ testOrigins: { odcloud: origin } }));
    await assert.rejects(v.status([syntheticBizNo(1)]), /no_key/);
    v.setServiceKey(KEY);
    const [s] = await v.status([syntheticBizNo(1)]);
    assert.equal(s!.statusCode, '01');
    assert.ok(seen.every((x) => !x.url.includes(KEY)));
    assert.equal(seen.at(-1)!.auth, `Infuser ${KEY}`);
  });

  it('진위확인 일치·불일치, 잘못된 키는 unauthorized', async () => {
    const root = await tmpRoot();
    const db = openDatabase(path.join(root, 'v.sqlite'), new Uint8Array(randomBytes(32)));
    const svc = new DataService(db, new BizVerifier(new Egress({ testOrigins: { odcloud: origin } })));
    await svc.handle('bizverify.setKey', { key: KEY });
    const cp = (await svc.handle('counterparty.create', { bizNo: syntheticBizNo(5), name: '가나상사', repName: '이가나' })) as { id: string };
    const ok = (await svc.handle('counterparty.verify', { id: cp.id, startDate: '2020-01-01' })) as { counterparty: { verifiedStatus: string; verifiedAt: string }; result: { valid: boolean } };
    assert.equal(ok.result.valid, true);
    assert.equal(ok.counterparty.verifiedStatus, 'valid:01');
    assert.ok(ok.counterparty.verifiedAt);
    const bad = (await svc.handle('counterparty.verify', { id: cp.id, startDate: '2021-01-01' })) as { result: { valid: boolean; message: string } };
    assert.equal(bad.result.valid, false);
    await svc.handle('bizverify.setKey', { key: 'wrong' });
    await assert.rejects(svc.handle('counterparty.status', { id: cp.id }), /unauthorized/);
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('egress는 내장 목적지·경로만 보낸다', async () => {
    const e = new Egress();
    await assert.rejects(e.postJson('odcloud', '/api/other', {}), (err: unknown) => err instanceof EgressError && err.code === 'path_not_allowed');
    await assert.rejects(e.postJson('evil' as never, '/', {}), (err: unknown) => err instanceof EgressError && err.code === 'destination_not_allowed');
  });
});
