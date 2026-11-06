// 급여·꾸러미·S-06 엔진 명령(팀장 결정 2026-11-06): protocol 이름 = BundleService 처리 = entry.ts 배선, 모두 main 전용.
// data-service 형식(인자 검사 → code만 가진 오류, 모르는 이름 unknown_method, 프로필 범위)과 ColumnCipher 배선(DB 키를 지우기 전 파생, 로그 없음)을 확인한다.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BundleService, type InsuranceKind as BKind, type InsuranceNoticeMatch as BMatch, type InsuranceNoticeMatchInput as BInput } from '@sax/bundle';
import { ColumnCipher, deriveColumnKey, DocumentRepo, EmployeeRepo, openDatabase, ProfileRepo, syntheticBizNo, type Db } from '@sax/db';
import type { InsuranceKind as DKind, InsuranceNoticeMatch as DMatch, InsuranceNoticeMatchInput as DInput } from '@sax/docparse';
import { COMMANDS, GATE_ONLY_METHODS, MAIN_ONLY, PAYROLL_COMMANDS, PAYROLL_MAIN_ONLY, PAYROLL_READ_QUERIES, READ_QUERIES, RUN_COMMANDS } from '@sax/engine/protocol';

// bundle이 docparse 타입을 같은 모양으로 다시 적었다(엔진 → bundle → docparse → 엔진 순환을 피하려고). 두 쪽이 서로 들어가야 한다.
const same = <A, B>(_a: A extends B ? (B extends A ? true : false) : false): void => undefined;
same<BKind, DKind>(true);
same<BInput, DInput>(true);
same<BMatch, DMatch>(true);

const root = path.resolve(import.meta.dirname, '..');
const entry = fs.readFileSync(path.join(root, 'packages/engine/src/entry.ts'), 'utf8');
const ALL = [...PAYROLL_READ_QUERIES, ...PAYROLL_COMMANDS] as const;

let dir: string;
let db: Db;
let svc: BundleService;
let profileId: string;
let otherProfile: string;
let kim: string;
let lee: string;
let noticeDoc: string;
const call = <T = unknown>(m: string, p: Record<string, unknown> = {}) => svc.handle(m, p) as Promise<T>;
const code = async (m: string, p: Record<string, unknown>, c: string) => assert.rejects(call(m, p), (e: Error & { code?: string }) => e.code === c, `${m} → ${c}`);
const NOW = new Date('2026-11-06T01:00:00.000Z');

before(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-payroll-cmd-'));
  const key = new Uint8Array(randomBytes(32));
  db = openDatabase(path.join(dir, 'db.sqlite'), key);
  const cipher = new ColumnCipher(deriveColumnKey(key));
  svc = new BundleService(db, cipher, { exportDir: path.join(dir, 'exports'), now: () => NOW });
  const profiles = new ProfileRepo(db);
  const base = { corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null };
  profileId = profiles.upsert({ kind: 'business', displayName: '가게', bizNo: syntheticBizNo(11), ...base }).id;
  // 프로필은 종류마다 하나다. 다른 프로필은 개인 프로필로 만든다
  otherProfile = profiles.upsert({ kind: 'personal', displayName: '개인', bizNo: null, ...base }).id;
  const emps = new EmployeeRepo(db, cipher);
  kim = emps.create({ profileId, name: '김직원', birthDate: '1990-01-01', hiredOn: '2025-01-02', basePay: 2_500_000, dependents: 1, rrn: '900101-1234567', nontax: { meal: 200_000 } }).id;
  lee = emps.create({ profileId, name: '이직원', birthDate: '1995-05-05', hiredOn: '2026-01-05', basePay: 2_200_000, dependents: 1 }).id;
  emps.create({ profileId: otherProfile, name: '남의직원', birthDate: '1980-02-02', hiredOn: '2025-01-02', basePay: 3_000_000, dependents: 1 });
  const content = Buffer.from('notice');
  noticeDoc = randomUUID();
  const p = path.join(dir, 'notice.xlsx');
  fs.writeFileSync(p, content);
  new DocumentRepo(db).insert({ id: noticeDoc, profileId, docType: 'insurance_notice', displayName: null, issuedAt: '2026-10-20', expiresAt: null, issuer: null, path: p, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), meta: null, runId: null });
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('급여·꾸러미·S-06 명령 목록과 엔진 배선', () => {
  it('이름은 제안표 그대로, 기존 목록·실행·게이트 이름과 겹치지 않고, 모두 main 전용', () => {
    assert.deepEqual([...PAYROLL_READ_QUERIES], ['db.query.payroll.month', 'db.query.payroll.employees', 'db.query.bundle.status', 'db.query.bundle.missing', 'db.query.rateTables.installed']);
    assert.equal(PAYROLL_COMMANDS.length, 15);
    for (const q of PAYROLL_READ_QUERIES) assert.ok(q.startsWith('db.query.'), q);
    const existing = new Set<string>([...READ_QUERIES, ...COMMANDS, ...RUN_COMMANDS, ...GATE_ONLY_METHODS, ...MAIN_ONLY]);
    for (const m of ALL) {
      assert.ok(!existing.has(m), m);
      assert.ok((PAYROLL_MAIN_ONLY as readonly string[]).includes(m), m);
    }
    assert.equal(new Set(ALL).size, ALL.length);
  });

  it('BundleService가 모든 이름을 처리하고(unknown_method 아님), 모르는 이름은 unknown_method', async () => {
    for (const m of ALL) {
      // 인자 없이 부르면 검사 오류(code)가 나야 한다. 인자가 필요 없는 표 판 조회만 성공한다
      const err = await call(m, {}).then(() => null, (e: Error & { code?: string }) => e);
      if (m === 'db.query.rateTables.installed') assert.equal(err, null);
      else assert.ok(err && typeof err.code === 'string' && err.code !== 'unknown_method', `${m}: ${err?.code}`);
    }
    await code('payroll.delete', { profileId }, 'unknown_method');
    await code('db.query.profiles.list', {}, 'unknown_method');
  });

  it('entry.ts: DB 키를 지우기 전에 컬럼 키 파생 → ColumnCipher, 파생 바이트도 지움, 키·cipher는 로그·메시지로 나가지 않는다', () => {
    const derive = entry.indexOf('deriveColumnKey(key)');
    const cipher = entry.indexOf('new ColumnCipher(columnKey)');
    const wipe = entry.indexOf('key.fill(0);\n', cipher);
    assert.ok(derive > entry.indexOf("vault.rpc<Uint8Array>('getDbKeyOnce')") && cipher > derive && wipe > cipher, '파생 → 생성 → DB 키 지움 순서');
    assert.ok(entry.indexOf('columnKey.fill(0)') > cipher && entry.indexOf('columnKey.fill(0)') < wipe);
    assert.ok(entry.includes("new BundleService(db, cipher, { exportDir: path.join(paths.root, 'exports') })"));
    for (const line of entry.split('\n').filter((l) => /log\.event|postMessage/.test(l))) assert.ok(!/cipher|columnKey/i.test(line), line);
    // 중계 허용 목록에 더하고, data-service보다 먼저 BundleService로 보낸다
    assert.ok(entry.includes('for (const m of PAYROLL) ALLOWED.add(m);'));
    assert.ok(entry.indexOf('if (PAYROLL.has(method))') < entry.indexOf('return data.handle(method, params);'));
  });
});

describe('급여대장 명령', () => {
  it('직원 조회: 그달 재직, 이 프로필만, 주민번호는 가린 값만', async () => {
    const list = await call<Array<{ id: string; name: string; maskedRrn: string | null }>>('db.query.payroll.employees', { profileId, month: '2026-10' });
    assert.deepEqual(list.map((e) => e.name).sort(), ['김직원', '이직원']);
    const k = list.find((e) => e.id === kim)!;
    assert.ok(k.maskedRrn && !k.maskedRrn.includes('1234567') && k.maskedRrn.startsWith('900101'), String(k.maskedRrn));
    assert.ok(!JSON.stringify(list).includes('1234567'));
    assert.equal(list.find((e) => e.id === lee)!.maskedRrn, null);
  });

  it('계산(저장 안 함) → 초안 저장 → 조회 → 확인 → 개정', async () => {
    type C = { rateTableIds: string[]; lines: Array<{ employeeId: string; result: { gross: number; netPay: number; notes: string[] }; statementMissing: string[] }>; summary: { headcount?: number } };
    const c = await call<C>('payroll.compute', { profileId, month: '2026-10', paidOn: '2026-11-10', inputs: { [lee]: { extras: [{ name: '연장 수당', amount: 100_000, calc: '사장님 입력' }] } } });
    assert.equal(c.lines.length, 2);
    assert.ok(c.rateTableIds.length === 4);
    assert.equal(c.lines.find((l) => l.employeeId === lee)!.result.gross, 2_300_000);
    assert.ok(c.lines.every((l) => Array.isArray(l.statementMissing) && Array.isArray(l.result.notes)));
    const none = await call<{ current: null; lines: [] }>('db.query.payroll.month', { profileId, month: '2026-10' });
    assert.equal(none.current, null, 'compute는 저장하지 않는다');

    const s = await call<{ draft: { revision: number; status: string; paidOn: string; noticeDocIds: string[] } }>('payroll.saveDraft', { profileId, month: '2026-10', paidOn: '2026-11-10', noticeDocIds: [noticeDoc, noticeDoc] });
    assert.deepEqual([s.draft.revision, s.draft.status, s.draft.paidOn, s.draft.noticeDocIds], [1, 'draft', '2026-11-10', [noticeDoc]]);
    const m1 = await call<{ current: { revision: number }; lines: Array<{ employeeId: string; gross: number }>; summary: unknown }>('db.query.payroll.month', { profileId, month: '2026-10' });
    assert.equal(m1.lines.length, 2);
    assert.equal(m1.lines.find((l) => l.employeeId === lee)!.gross, 2_200_000, '다시 저장하면 이번 입력(수당 없음)으로 계산한 값');
    assert.ok(m1.summary);

    const conf = await call<{ status: string; confirmedAt: string }>('payroll.confirm', { profileId, month: '2026-10', revision: 1 });
    assert.deepEqual([conf.status, conf.confirmedAt], ['confirmed', NOW.toISOString()]);
    await code('payroll.saveDraft', { profileId, month: '2026-10', paidOn: '2026-11-10' }, 'month_confirmed_use_revise');
    const rev = await call<{ revision: number; status: string }>('payroll.revise', { profileId, month: '2026-10' });
    assert.deepEqual([rev.revision, rev.status], [2, 'draft']);
    const m2 = await call<{ current: { revision: number }; revisions: unknown[] }>('db.query.payroll.month', { profileId, month: '2026-10' });
    assert.deepEqual([m2.current.revision, m2.revisions.length], [2, 2]);
    const m1again = await call<{ current: { revision: number; status: string } }>('db.query.payroll.month', { profileId, month: '2026-10', revision: 1 });
    assert.equal(m1again.current.status, 'confirmed');
  });

  it('세전 → 실수령(takeHome)', async () => {
    const settings = { nontax: { meal: 200_000 }, dependents: 1, children8to20: 0, withholdingPct: 100, pensionApplies: true, healthApplies: true, employmentApplies: true };
    const r = await call<{ gross: number; net: number }>('payroll.takeHome', { profileId, month: '2026-10', gross: 2_500_000, settings, paidOn: '2026-11-10' });
    assert.equal(r.gross, 2_500_000);
    assert.ok(r.net > 0 && r.net < 2_500_000);
    await code('payroll.takeHome', { profileId, month: '2026-10', gross: -1, settings, paidOn: '2026-11-10' }, 'invalid_gross');
    await code('payroll.takeHome', { profileId, month: '2026-10', gross: 1, settings: { ...settings, pensionApplies: 'yes' } }, 'bad_settings');
  });

  it('인자 검사·프로필 범위(data-service와 같은 꼴: code만)', async () => {
    await code('payroll.compute', { month: '2026-10', paidOn: '2026-11-10' }, 'profile_not_found');
    await code('payroll.compute', { profileId: 'nope', month: '2026-10', paidOn: '2026-11-10' }, 'profile_not_found');
    await code('payroll.compute', { profileId, month: '2026-13', paidOn: '2026-11-10' }, 'bad_month');
    await code('payroll.compute', { profileId, month: '2026-10' }, 'bad_paid_on');
    await code('payroll.compute', { profileId, month: '2026-10', paidOn: '2026-02-10' }, 'rate_table_missing:simple_tax_table');
    await code('payroll.compute', { profileId, month: '2026-10', paidOn: '2026-11-10', inputs: { 'not-mine': {} } }, 'employee_not_found');
    await code('payroll.compute', { profileId, month: '2026-10', paidOn: '2026-11-10', inputs: { [kim]: { extras: [{ name: '', amount: 1, calc: '' }] } } }, 'bad_extras');
    await code('payroll.compute', { profileId, month: '2026-10', paidOn: '2026-11-10', inputs: { [kim]: { notices: { industrial: 1 } } } }, 'bad_notices');
    await code('payroll.compute', { profileId, month: '2026-10', paidOn: '2026-11-10', employerSize: 'huge' }, 'bad_employer_size');
    await code('payroll.confirm', { profileId, month: '2026-10', revision: 0 }, 'bad_revision');
    await code('payroll.revise', { profileId, month: '2026-09' }, 'not_found');
    await code('payroll.saveDraft', { profileId: otherProfile, month: '2026-10', paidOn: '2026-11-10', noticeDocIds: [noticeDoc] }, 'document_not_found');
    // 남의 프로필 조회에는 이 프로필 직원이 섞이지 않는다
    const others = await call<Array<{ name: string }>>('db.query.payroll.employees', { profileId: otherProfile, month: '2026-10' });
    assert.deepEqual(others.map((e) => e.name), ['남의직원']);
  });
});

describe('S-06 고지내역 확인 카드 명령', () => {
  const rows = [
    { rowId: 'S!2:pension', name: '김 직원', birthDate: '1990-01-01', insurance: 'pension', base: 2_300_000, total: 218_500, employee: 109_250, employer: 109_250 },
    { rowId: 'S!2:health', name: '김 직원', birthDate: '1990-01-01', insurance: 'health', base: 2_300_000, total: 163_070, employee: 81_535, employer: 81_535 },
    { rowId: 'S!3:pension', name: '이직원', birthDate: null, insurance: 'pension', base: 2_200_000, total: 209_000, employee: 104_500, employer: 104_500 },
  ];
  const input = { profileId, month: '2026-10', noticeDocId: '', rows };

  it('카드 → 고르기 → 고지액 지도(엔진이 같은 입력으로 카드를 다시 만든다) → saveDraft inputs로', async () => {
    const card = await call<{ people: Array<{ key: string; employeeId: string | null; needsChoice: boolean; basis: string }>; needsChoice: boolean }>('notice.card', { ...input, noticeDocId: noticeDoc });
    assert.equal(card.people.length, 2);
    const k = card.people.find((x) => x.employeeId === kim)!;
    assert.deepEqual([k.basis, k.needsChoice], ['name_birth', false]);
    const l = card.people.find((x) => x.basis === 'name_only')!;
    assert.ok(l.needsChoice);
    await code('notice.confirm', { ...input, noticeDocId: noticeDoc, choices: {} }, 'notice_choice_needed');
    const r = await call<{ noticeDocId: string; notices: Record<string, { pension?: number; health?: number }> }>('notice.confirm', { ...input, noticeDocId: noticeDoc, choices: { [l.key]: lee } });
    assert.equal(r.noticeDocId, noticeDoc);
    assert.deepEqual(r.notices[kim], { pension: 109_250, health: 81_535 });
    assert.equal(r.notices[lee]!.pension, 104_500);

    const s = await call<{ lines: Array<{ employeeId: string; result: { pensionNotice: number | null } }> }>('payroll.saveDraft', {
      profileId, month: '2026-10', paidOn: '2026-11-10', noticeDocIds: [r.noticeDocId], inputs: Object.fromEntries(Object.entries(r.notices).map(([id, n]) => [id, { notices: n }])),
    });
    assert.equal(s.lines.find((x) => x.employeeId === kim)!.result.pensionNotice, 109_250);
  });

  it('문서는 이 프로필 것만, 행 모양 검사', async () => {
    await code('notice.card', { ...input, noticeDocId: 'missing' }, 'document_not_found');
    await code('notice.card', { ...input, profileId: otherProfile, noticeDocId: noticeDoc }, 'document_not_found');
    await code('notice.card', { ...input, noticeDocId: noticeDoc, rows: [{ ...rows[0], insurance: 'tax' }] }, 'bad_notice_rows');
    await code('notice.card', { ...input, noticeDocId: noticeDoc, rows: [{ ...rows[0], birthDate: '19900101' }] }, 'bad_notice_rows');
    await code('notice.confirm', { ...input, noticeDocId: noticeDoc, choices: { x: 1 } }, 'bad_choices');
  });
});

describe('세무사 꾸러미 명령', () => {
  it('항목 → 이번 달 판 → 빠진 것 → 카드 전표로 충분 켜기·끄기 → 주민번호 설정', async () => {
    const items = await call<Array<{ tier: number }>>('bundle.ensureItems', { profileId, industries: ['restaurant'] });
    assert.ok(items.some((i) => i.tier === 2));
    await code('bundle.ensureItems', { profileId, industries: ['bakery'] }, 'bad_industries');
    await call('bundle.addItem', { profileId, name: '차량 운행일지', cadence: 'quarterly' });
    await code('bundle.addItem', { profileId, name: '차량 운행일지', cadence: 'monthly' }, 'duplicate_item');
    await code('bundle.addItem', { profileId, name: '임대차', cadence: 'yearly' }, 'bad_cadence');

    const status = await call<Array<{ item: { name: string }; status: string }>>('db.query.bundle.status', { profileId, month: '2026-10' });
    assert.ok(status.every((s) => ['missing', 'partial', 'ready', 'not_applicable'].includes(s.status)));
    assert.ok(status.some((s) => s.item.name === '차량 운행일지'));
    const view = await call<{ month: string; openCount: number; cardSlipEnough: boolean; sections: Array<{ key: string }> }>('db.query.bundle.missing', { profileId, month: '2026-10' });
    assert.equal(view.month, '2026-10');
    assert.ok(view.sections.some((s) => s.key === 'payroll'), '급여 초안(개정 중)이 빠진 것에 뜬다(직원이 있으니 급여 기능 켜짐)');

    assert.deepEqual(await call('bundle.cardSlipEnough', { profileId, month: '2026-10', on: true }), { from: '2026-11' });
    assert.equal((await call<{ cardSlipEnough: boolean }>('db.query.bundle.missing', { profileId, month: '2026-11' })).cardSlipEnough, true);
    assert.deepEqual(await call('bundle.cardSlipEnough', { profileId, on: false }), { from: null });
    await code('bundle.cardSlipEnough', { profileId, month: '2026-10' }, 'bad_on');
    assert.deepEqual(await call('bundle.setIncludeRrn', { profileId, on: false }), { includeRrn: false });
    await code('db.query.bundle.status', { profileId: otherProfile + 'x', month: '2026-10' }, 'profile_not_found');
  });

  it('내보내기: 엔진이 정한 폴더, 암호는 결과로 한 번만, 보낸 표시는 이 프로필 기록만', async () => {
    const r = await call<{ record: { id: string }; file: string; password: string; rrnIncluded: boolean; guide: string[] }>('bundle.export', {
      profileId, month: '2026-10',
      taxInvoices: [{ direction: 'sales', issueDate: '2026-10-05', approvalNo: 'A-1', counterpartyBizNo: '1234567890', counterpartyName: '거래처', supplyAmount: 10_000, vatAmount: 1_000, total: 11_000 }],
    });
    assert.ok(r.file.startsWith(path.join(dir, 'exports', profileId) + path.sep), r.file);
    assert.ok(fs.existsSync(r.file));
    assert.equal(r.rrnIncluded, false);
    assert.ok(r.password.length >= 10);
    assert.ok(!fs.readFileSync(path.join(dir, 'db.sqlite')).includes(Buffer.from(r.password)), '암호는 DB에 없다');
    await code('bundle.export', { profileId, month: '2026-10', taxInvoices: [{ direction: 'sales' }] }, 'bad_tax_invoices');

    const opened = await call<{ sendVia: string; sentTo: string }>('bundle.markOpened', { profileId, exportId: r.record.id, via: 'mail_client', sentTo: 'tax@example.com' });
    assert.deepEqual([opened.sendVia, opened.sentTo], ['mail_client', 'tax@example.com']);
    const sent = await call<{ sentMarkedAt: string; sentNote: string }>('bundle.markSent', { profileId, exportId: r.record.id, note: '메일로 보냄' });
    assert.deepEqual([sent.sentMarkedAt, sent.sentNote], [NOW.toISOString(), '메일로 보냄']);
    await code('bundle.markSent', { profileId: otherProfile, exportId: r.record.id }, 'export_not_found');
    await code('bundle.markOpened', { profileId, exportId: r.record.id, via: 'sms' }, 'bad_via');
  });

  it('급여 기록 내보내기(확인한 달만, 주민번호 없음)와 표 판 조회', async () => {
    const r = await call<{ file: string; months: string[]; password: string }>('payroll.exportRecord', { profileId });
    assert.deepEqual(r.months, ['2026-10']);
    assert.ok(fs.existsSync(r.file) && r.password.length >= 10);
    await code('payroll.exportRecord', { profileId: otherProfile }, 'no_confirmed_payroll');
    await code('payroll.exportRecord', { profileId, fromMonth: '2026/10' }, 'bad_month');
    const t = await call<{ packageId: string; installed: null; tables: Array<{ kind: string; review: string }> }>('db.query.rateTables.installed');
    assert.equal(t.installed, null, '서명 배포를 받기 전');
    assert.ok(t.tables.some((x) => x.kind === 'simple_tax_table'));
  });
});
