// 거래처 장부 쓰기(counterparty-book.ts, M4-3 거래처 OCR 입력, 08 O-05): 폼 → 엔진 counterparty.create/update, [등록증으로 채우기] 후보.
// 실제 엔진 data-service·암호화 DB에 붙여 돌린다(Electron 없이). 등록증 읽기 자체는 shell-bizcert.test.ts가 본다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { openDatabase, type Counterparty, type Db } from '@sax/db';
import { BizVerifier, DataService } from '@sax/engine';
import { Egress } from '@sax/net';
import { CounterpartyBook, CP_CERT_HOLD_MS, type CpCertRead } from '../apps/desktop/src/counterparty-book.ts';
import { MOCK_CP_CERT } from '../apps/desktop/src/onboarding-mock.ts';
import { USER_ACTION_METHODS, SHELL_METHODS } from '../apps/desktop/src/ipc.ts';

describe('거래처 장부: 엔진 명령으로 DB에', () => {
  let root: string;
  let db: Db;
  let svc: DataService;
  let calls: Array<[string, Record<string, unknown>]>;
  let clock: number;
  const rpc = async (m: string, p: Record<string, unknown> = {}) => {
    calls.push([m, p]);
    return structuredClone(await svc.handle(m, structuredClone(p)));
  };
  const book = (reads: CpCertRead[] = []) => new CounterpartyBook(rpc, async () => (reads.length ? reads.shift()! : null), () => clock);
  const list = async () => (await svc.handle('db.query.counterparties.list', {})) as Counterparty[];

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-cp-book-'));
  });
  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    db = openDatabase(path.join(root, `${randomBytes(4).toString('hex')}.sqlite`), new Uint8Array(randomBytes(32)));
    svc = new DataService(db, new BizVerifier(new Egress()), { vaultDir: path.join(root, 'vault') });
    calls = [];
    clock = 1_000_000;
  });
  afterEach(() => db.close());

  it('손으로 추가는 source manual, 번호의 하이픈은 지우고 칸 상한에서 자른다', async () => {
    const b = book();
    const saved = await b.save({ id: null, name: `  견본상사${'가'.repeat(80)}`, bizNo: '314-86-01237', rep: '이견본', email: '', item: '사무용품' });
    assert.equal(saved.bizNo, '3148601237');
    assert.equal(saved.name.length, 60);
    assert.equal(saved.source, 'manual');
    assert.equal(saved.address, null);
    assert.equal(saved.email, null, '빈 이메일은 null');
    assert.deepEqual(calls.map(([m]) => m), ['counterparty.create']);
    assert.ok(!('item' in calls[0]![1]), '저장 품목은 엔진에 보내지 않는다(DB 열이 없다)');
  });

  it('[등록증으로 채우기] → 같은 번호로 추가하면 source ocr·주소(렌더러는 주소를 보내지 않는다), 한 번만', async () => {
    const b = book([{ ...MOCK_CP_CERT }]);
    const r = await b.readCert();
    assert.deepEqual(r, { found: true, name: '견본상사', bizNo: '3148601237', rep: '이견본' });
    assert.ok(!JSON.stringify(r).includes('견본구'), '주소는 후보 응답에 없다');
    const saved = await b.save({ id: null, name: r.found ? r.name : '', bizNo: '314-86-01237', rep: '이견본', email: 'a@gyeonbon-test.example' });
    assert.equal(saved.source, 'ocr');
    assert.equal(saved.address, MOCK_CP_CERT.address);
    await svc.handle('counterparty.delete', { id: saved.id });
    const again = await b.save({ id: null, name: '견본상사', bizNo: '3148601237' });
    assert.equal(again.source, 'manual', '한 번 쓰면 버린다');
    assert.equal(again.address, null);
  });

  it('번호를 고쳐 저장하거나 30분이 지나면 등록증 값으로 보지 않는다', async () => {
    const other = { ...MOCK_CP_CERT, bizNo: '2158701238' };
    const b = book([{ ...MOCK_CP_CERT }, { ...MOCK_CP_CERT }]);
    await b.readCert();
    const edited = await b.save({ id: null, name: '다른상사', bizNo: other.bizNo });
    assert.equal(edited.source, 'manual');
    assert.equal(edited.address, null);
    await b.readCert();
    clock += CP_CERT_HOLD_MS + 1;
    const late = await b.save({ id: null, name: '견본상사', bizNo: MOCK_CP_CERT.bizNo });
    assert.equal(late.source, 'manual');
  });

  it('고르지 않음(cancelled)·못 읽음(unreadable)을 나누고, 못 읽으면 들고 있던 주소도 버린다', async () => {
    const b = book([{ ...MOCK_CP_CERT }, null, 'unreadable']);
    await b.readCert();
    assert.deepEqual(await b.readCert(), { found: false, reason: 'cancelled' });
    assert.deepEqual(await b.readCert(), { found: false, reason: 'unreadable' });
    const saved = await b.save({ id: null, name: '견본상사', bizNo: MOCK_CP_CERT.bizNo });
    assert.equal(saved.source, 'manual');
  });

  it('읽는 중에 또 누르면 busy(파일 대화상자를 겹쳐 열지 않는다)', async () => {
    let release!: (v: CpCertRead) => void;
    const b = new CounterpartyBook(rpc, () => new Promise<CpCertRead>((r) => (release = r)), () => clock);
    const first = b.readCert();
    await assert.rejects(b.readCert(), /busy/);
    release(null);
    assert.equal((await first).found, false);
    const b2 = new CounterpartyBook(rpc, async () => null, () => clock);
    assert.equal((await b2.readCert()).found, false, '끝나면 다시 받는다');
  });

  it('수정은 counterparty.update(번호는 바꾸지 않는다), 틀린 번호·중복은 엔진 오류 그대로', async () => {
    const b = book();
    const made = await b.save({ id: null, name: '견본상사', bizNo: MOCK_CP_CERT.bizNo });
    const upd = await b.save({ id: made.id, name: '견본상사(수정)', bizNo: '9999999999', rep: '', email: 'x@gyeonbon-test.example' });
    assert.equal(upd.name, '견본상사(수정)');
    assert.equal(upd.bizNo, MOCK_CP_CERT.bizNo);
    assert.equal(upd.repName, null);
    assert.deepEqual(calls.at(-1), ['counterparty.update', { id: made.id, patch: { name: '견본상사(수정)', repName: null, email: 'x@gyeonbon-test.example' } }]);
    await assert.rejects(b.save({ id: null, name: 'x', bizNo: '1234567890' }), /invalid_biz_no/);
    await assert.rejects(b.save({ id: null, name: 'x', bizNo: MOCK_CP_CERT.bizNo }), /duplicate_biz_no/);
    assert.equal((await list()).length, 1);
  });
});

describe('셸 배선(소스 검사)', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/src/shell-app.ts'), 'utf8');
  const js = fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/static/shell/shell.js'), 'utf8');
  it('counterparty.readCert는 실제 입력 뒤 3초 안에만, 인자 없음', () => {
    assert.equal(USER_ACTION_METHODS['counterparty.readCert'], 3_000);
    assert.deepEqual(SHELL_METHODS['counterparty.readCert'], {});
    assert.match(src, /'counterparty\.readCert': \(\) => \{\s*needGesture\(3_000\);\s*return cpBook\.readCert\(\);/);
  });
  it('제품 거래처 추가는 fixture에 묶이지 않고, 등록증 읽기는 온보딩과 같은 포트(골랐는지만 덧붙인다), fixture는 시연 등록증', () => {
    assert.match(src, /'counterparty\.save': async \(p\) => \{\s*const saved = await cpBook\.save\(p\);/);
    assert.doesNotMatch(src, /saveCounterparty/);
    assert.match(src, /readBizCert\(\{ \.\.\.bizCertPorts, pick \}\)\) \?\? \(picked \? 'unreadable' : null\)/);
    assert.match(src, /\? async \(\) => \(\{ \.\.\.MOCK_CP_CERT \}\)/);
    assert.match(src, /if \(fixture && item\) fixture\.itemHints\[saved\.bizNo\] = item;/);
  });
  it('렌더러는 후보를 입력 칸 value로만 넣는다(innerHTML 없음), 제품 장부에서는 저장 품목 칸이 없다', () => {
    const panel = js.slice(js.indexOf('function cpEditPanel('), js.indexOf('function bizView('));
    assert.match(panel, /call\('counterparty\.readCert', \{\}\)/);
    assert.match(panel, /form\.elements\.name\.value = r\.name/);
    assert.doesNotMatch(panel, /innerHTML|insertAdjacentHTML/);
    assert.match(panel, /demoBook \? field\('저장 품목'/);
  });
});
