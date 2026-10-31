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
import { appPaths, defaultAppRoot, dirGuard, findReparsePoint, prepareLayout, readDacl, windowsTool } from '@sax/platform';
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
      assert.match(stdout.slice(0, stdout.indexOf(root)), /I/, 'FILE_ATTRIBUTE_NOT_CONTENT_INDEXED');
    }
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
