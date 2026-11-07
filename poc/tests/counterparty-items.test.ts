// 거래처 저장 품목(08 §144 "자주 쓰는 품목을 저장한다", 데스크톱 #141): v7 saved_items_json, CounterpartyRepo.getItems·setItems,
// data-service counterparty.setItems·getItems. 품목은 이름·단가·단위, 거래처당 상한 20개. 개인정보·비밀이 아니라 평문 열이다(D07 §2).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { COUNTERPARTY_ITEMS_MAX, CounterpartyRepo, MIGRATIONS, openDatabase, syntheticBizNo, type Db } from '@sax/db';
import { BizVerifier, DataService } from '@sax/engine';
import { COMMANDS, MAIN_ONLY } from '@sax/engine/protocol';
import { Egress } from '@sax/net';

let dir: string;
let db: Db;
let svc: DataService;
const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: Error & { code?: string }) => e.code === c, c);
const tmpFile = (name: string) => path.join(dir, name);

before(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-cpitems-'));
  db = openDatabase(tmpFile('db.sqlite'), new Uint8Array(randomBytes(32)));
  svc = new DataService(db, new BizVerifier(new Egress()));
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('거래처 저장 품목', () => {
  it('v7: counterparties.saved_items_json 열, 기존 v6 DB의 거래처는 그대로 남고 품목은 빈 목록', () => {
    assert.equal(MIGRATIONS.at(-1)!.name, 'counterparty_items');
    const file = tmpFile('v6.sqlite');
    const k = new Uint8Array(randomBytes(32));
    const v6 = openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 6) });
    const old = new CounterpartyRepo(v6).create({ bizNo: syntheticBizNo(41), name: '옛거래처' });
    v6.close();
    const d = openDatabase(file, k);
    try {
      const cols = (d.prepare('PRAGMA table_info(counterparties)').all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes('saved_items_json'));
      const repo = new CounterpartyRepo(d);
      assert.equal(repo.get(old.id)?.name, '옛거래처');
      assert.deepEqual(repo.getItems(old.id), []);
    } finally {
      d.close();
    }
  });

  it('setItems → getItems: 저장 순서 그대로, 앞뒤 공백 정리, 빈 단위는 null, 모르는 칸은 버린다', async () => {
    const cp = (await svc.handle('counterparty.create', { bizNo: syntheticBizNo(42), name: '가나상사' })) as { id: string };
    const saved = await svc.handle('counterparty.setItems', {
      id: cp.id,
      items: [
        { name: ' 컨설팅 ', unitPrice: 1_500_000, unit: '식', memo: '버린다' },
        { name: '출장비', unitPrice: null, unit: '  ' },
        { name: '자재', unitPrice: 0 },
      ],
    });
    const want = [
      { name: '컨설팅', unitPrice: 1_500_000, unit: '식' },
      { name: '출장비', unitPrice: null, unit: null },
      { name: '자재', unitPrice: 0, unit: null },
    ];
    assert.deepEqual(saved, want);
    assert.deepEqual(await svc.handle('counterparty.getItems', { id: cp.id }), want);
    // 통째로 바꾼다
    assert.deepEqual(await svc.handle('counterparty.setItems', { id: cp.id, items: [{ name: '유지보수', unitPrice: 300_000, unit: '월' }] }), [{ name: '유지보수', unitPrice: 300_000, unit: '월' }]);
    assert.deepEqual(await svc.handle('counterparty.getItems', { id: cp.id }), [{ name: '유지보수', unitPrice: 300_000, unit: '월' }]);
    // 빈 배열은 지운다(열은 NULL)
    assert.deepEqual(await svc.handle('counterparty.setItems', { id: cp.id, items: [] }), []);
    assert.equal(db.prepare('SELECT saved_items_json FROM counterparties WHERE id = ?').pluck().get(cp.id), null);
    assert.deepEqual(await svc.handle('counterparty.getItems', { id: cp.id }), []);
  });

  it('상한: 20개까지 받고 21개는 too_many_items, 저장된 목록은 그대로', async () => {
    const cp = (await svc.handle('counterparty.create', { bizNo: syntheticBizNo(43), name: '다라테크' })) as { id: string };
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `품목${i + 1}`, unitPrice: 1000 * (i + 1), unit: '개' }));
    assert.equal(COUNTERPARTY_ITEMS_MAX, 20);
    assert.equal(((await svc.handle('counterparty.setItems', { id: cp.id, items: many(20) })) as unknown[]).length, 20);
    await code(svc.handle('counterparty.setItems', { id: cp.id, items: many(21) }), 'too_many_items');
    assert.equal(((await svc.handle('counterparty.getItems', { id: cp.id })) as unknown[]).length, 20);
  });

  it('검사: 이름 필수·100자·제어 문자 없음·겹침 없음, 단가 0 이상 정수, 단위 20자, 배열 아님', async () => {
    const cp = (await svc.handle('counterparty.create', { bizNo: syntheticBizNo(44), name: '마바물산' })) as { id: string };
    const set = (items: unknown) => svc.handle('counterparty.setItems', { id: cp.id, items });
    await code(set({ name: 'x' }), 'bad_items');
    await code(set(undefined), 'bad_items');
    await code(set(['컨설팅']), 'bad_items');
    await code(set([{ unitPrice: 1000 }]), 'bad_item_name');
    await code(set([{ name: '   ' }]), 'bad_item_name');
    await code(set([{ name: 'a'.repeat(101) }]), 'bad_item_name');
    await code(set([{ name: '줄\n바꿈' }]), 'bad_item_name');
    await code(set([{ name: 3 }]), 'bad_item_name');
    await code(set([{ name: '컨설팅' }, { name: ' 컨설팅' }]), 'item_name_twice');
    await code(set([{ name: '할인', unitPrice: -1000 }]), 'bad_item_price');
    await code(set([{ name: '반값', unitPrice: 1.5 }]), 'bad_item_price');
    await code(set([{ name: '문자', unitPrice: '1000' }]), 'bad_item_price');
    await code(set([{ name: '큰값', unitPrice: 1e15 }]), 'bad_item_price');
    await code(set([{ name: '단위', unit: 'u'.repeat(21) }]), 'bad_item_unit');
    await code(set([{ name: '단위', unit: 7 }]), 'bad_item_unit');
    // 100자 이름(한글 기준 글자 수)은 받는다
    assert.equal(((await set([{ name: '가'.repeat(100) }])) as Array<{ name: string }>)[0]!.name.length, 100);
  });

  it('없는 거래처는 not_found, 거래처를 지우면 품목도 같이 없어진다', async () => {
    await code(svc.handle('counterparty.getItems', { id: 'nope' }), 'not_found');
    await code(svc.handle('counterparty.setItems', { id: 'nope', items: [] }), 'not_found');
    await code(svc.handle('counterparty.getItems', {}), 'not_found');
    const cp = (await svc.handle('counterparty.create', { bizNo: syntheticBizNo(45), name: '사아상회' })) as { id: string };
    await svc.handle('counterparty.setItems', { id: cp.id, items: [{ name: '인쇄', unitPrice: 50_000, unit: '건' }] });
    assert.equal(await svc.handle('counterparty.delete', { id: cp.id }), true);
    await code(svc.handle('counterparty.getItems', { id: cp.id }), 'not_found');
  });

  it('수정(counterparty.update)·진위 표시는 품목을 건드리지 않는다, list·get 결과 모양은 그대로', async () => {
    const cp = (await svc.handle('counterparty.create', { bizNo: syntheticBizNo(46), name: '자차기획', email: 'a@example.com' })) as Record<string, unknown>;
    await svc.handle('counterparty.setItems', { id: cp.id, items: [{ name: '디자인', unitPrice: 800_000, unit: '건' }] });
    await svc.handle('counterparty.update', { id: cp.id, patch: { repName: '김자차' } });
    svc.counterparties.setVerification(String(cp.id), 'valid:01');
    assert.deepEqual(await svc.handle('counterparty.getItems', { id: cp.id }), [{ name: '디자인', unitPrice: 800_000, unit: '건' }]);
    const got = (await svc.handle('db.query.counterparties.get', { id: cp.id })) as Record<string, unknown>;
    assert.deepEqual(Object.keys(got).sort(), Object.keys(cp).sort(), '거래처 객체에 품목 칸을 더하지 않는다(따로 읽는다)');
  });

  it('protocol: 두 명령은 COMMANDS 끝에 더했고 렌더러에 열린다(거래처 추가·수정과 같다)', () => {
    assert.deepEqual(COMMANDS.slice(-2), ['counterparty.setItems', 'counterparty.getItems']);
    for (const m of ['counterparty.setItems', 'counterparty.getItems']) assert.ok(!(MAIN_ONLY as readonly string[]).includes(m), m);
  });
});
