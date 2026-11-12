// 이번 달 판(08 M-02, ADR-033, D14 M6-16): 기한 계산·정렬, 카드 → 갈 곳, 판에 승인 경로 없음. Electron 없이 돈다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { addMonths, BOARD_KINDS, buildBoard, dayOf, daysBetween, dueLabel, invoiceSortDue, type BoardInput } from '../apps/desktop/src/board.ts';
import { mockBundle } from '../apps/desktop/src/shell-mock.ts';

const base = (o: Partial<BoardInput> = {}): BoardInput => ({ today: '2026-11-05', reminderDay: 5, issued: [], runs: [], docs: [], bundle: null, cardFetchedOn: '2026-11-02', ...o });
const ids = (b: ReturnType<typeof buildBoard>) => b.cards.flatMap((c) => c.items.map((i) => i.id));

describe('날짜 도우미', () => {
  it('dayOf는 달의 마지막 날을 넘지 않고, addMonths는 해를 넘긴다', () => {
    assert.equal(dayOf('2026-02', 31), '2026-02-28');
    assert.equal(dayOf('2028-02', 30), '2028-02-29');
    assert.equal(dayOf('2026-11', 0), '2026-11-01');
    assert.equal(addMonths('2026-12', 1), '2027-01');
    assert.equal(addMonths('2026-01', -1), '2025-12');
    assert.equal(daysBetween('2026-11-05', '2026-12-10'), 35);
    assert.equal(dueLabel('2026-11-05', '2026-11-05'), '오늘');
    assert.equal(dueLabel('2026-11-05', '2026-11-08'), 'D-3');
    assert.equal(dueLabel('2026-11-05', '2026-11-01'), '4일 지남');
  });
});

describe('발급할 세금계산서', () => {
  it('지난달 발급한 거래처 중 이번 달 아직 없는 곳만, 누르면 입력창에 채우기(보내지 않음), 날짜는 보이지 않는다(02 §14)', () => {
    const b = buildBoard(
      base({
        issued: [
          { who: 'A상사', date: '2026-10-04', total: 3_630_000 },
          { who: 'A상사', date: '2026-10-28', total: 1_100_000 },
          { who: 'B상사', date: '2026-10-11', total: 605_000 },
          { who: 'B상사', date: '2026-11-02', total: 605_000 },
          { who: 'C테크', date: '2026-09-20', total: 440_000 },
        ],
      }),
    );
    const inv = b.cards.find((c) => c.kind === 'invoice')!;
    assert.deepEqual(
      inv.items.map((i) => i.label),
      ['A상사'],
    );
    const a = inv.items[0]!;
    assert.equal(a.showDue, false);
    assert.equal(a.due, '2026-12-10', '정렬은 다음 달 10일');
    assert.equal(a.detail, '지난달 10월 28일 · 1,100,000원 · 이번 달은 아직이에요');
    assert.equal(invoiceSortDue('2026-12'), '2027-01-10', '정렬 키 함수는 따로(팀장 결정 (가), 법률 의견 뒤 (나)로 바꿀 자리)');
    assert.deepEqual(a.target, { to: 'compose', text: 'A상사에 지난달처럼 세금계산서 끊어 줘' });
    assert.ok(!/가산세|기한|까지/.test(a.detail), '판 문구에 기한·가산세 없음');
  });

  it('진행 중인 실행은 그 실행으로 간다. 같은 거래처의 "아직" 항목은 겹쳐 두지 않는다. 끝난 실행은 판에 없다', () => {
    const b = buildBoard(
      base({
        issued: [{ who: 'A상사', date: '2026-10-04', total: 1 }],
        runs: [
          { id: 'r1', status: 'waiting', who: 'A상사' },
          { id: 'r2', status: 'attention', who: 'B상사' },
          { id: 'r3', status: 'done', who: 'C테크' },
          { id: 'r4', status: 'stopped', who: 'D' },
        ],
      }),
    );
    const inv = b.cards.find((c) => c.kind === 'invoice')!;
    assert.deepEqual(inv.items.map((i) => i.id).sort(), ['run:r1', 'run:r2']);
    assert.deepEqual(inv.items.find((i) => i.id === 'run:r2')!.tone, 'attention');
    assert.deepEqual(inv.items.find((i) => i.id === 'run:r1')!.target, { to: 'run', id: 'r1' });
    assert.deepEqual(b.counts, { attention: 1, progress: 1, expiringSoon: 0 });
  });
});

describe('받아야 할 증빙 · 세무사에게 줄 것', () => {
  it('지난달 꾸러미는 이번 달 알림 날(bundle.reminderDay)이 기한, 빠진 영수증은 받아야 할 증빙 카드로', () => {
    const b = buildBoard(base({ bundle: { month: '2026-10', slots: [{ name: '매출', state: 'done' }, { name: '종이 영수증', state: 'missing', receipt: true }, { name: '사업용 카드 내역', state: 'missing' }, { name: '현금매출', state: 'na' }], sentOn: null } }));
    const rc = b.cards.find((c) => c.kind === 'receipt')!;
    assert.deepEqual(rc.items.map((i) => [i.label, i.due, i.showDue]), [['종이 영수증', '2026-11-05', true]]);
    const acc = b.cards.find((c) => c.kind === 'accountant')!;
    const bundle = acc.items.find((i) => i.id === 'bundle:2026-10')!;
    assert.equal(bundle.detail, '빠진 것 2개 · 미리보고 보내기');
    assert.deepEqual(bundle.target, { to: 'view', view: 'bundle' });
    assert.equal(bundle.tone, null, '오늘이 기한이면 아직 지나지 않았다');
    const late = buildBoard(base({ today: '2026-11-09', bundle: { month: '2026-10', slots: [{ name: 'x', state: 'missing' }], sentOn: null } }));
    assert.equal(late.cards.find((c) => c.kind === 'accountant')!.items[0]!.tone, 'attention');
  });

  it('보낸 꾸러미는 판에서 빠진다. 알림 날이 달보다 길면 마지막 날로', () => {
    const b = buildBoard(base({ reminderDay: 31, today: '2026-02-03', bundle: { month: '2026-01', slots: [], sentOn: '2026-02-02' } }));
    assert.ok(!ids(b).some((i) => i.startsWith('bundle:')));
    const c = buildBoard(base({ reminderDay: 31, today: '2026-02-03', bundle: { month: '2026-01', slots: [], sentOn: null } }));
    assert.equal(c.cards.find((x) => x.kind === 'accountant')!.items.find((i) => i.id === 'bundle:2026-01')!.due, '2026-02-28');
  });

  it('사업용 카드 내역이 이번 달에 최신화되지 않았으면 D-04로 가는 줄(ADR-033 결정 5), 최신화했으면 없음', () => {
    const stale = buildBoard(base({ cardFetchedOn: '2026-09-28' }));
    const card = stale.cards.find((c) => c.kind === 'accountant')!.items.find((i) => i.id === 'card')!;
    assert.equal(card.detail, '마지막 최신화 38일 전');
    assert.deepEqual(card.target, { to: 'view', view: 'card' });
    assert.equal(buildBoard(base({ cardFetchedOn: null })).cards[0]!.items[0]!.detail, '아직 가져온 적 없어요');
    // 카드 기능이 없는 빌드(제품 첫 설치본)는 [최신화] 칸을 두지 않는다
    assert.ok(!buildBoard(base({ cardFetchedOn: null, cardEnabled: false })).cards.some((c) => c.items.some((i) => i.id === 'card')));
    assert.ok(!ids(buildBoard(base({ cardFetchedOn: '2026-11-01' }))).includes('card'));
  });
});

describe('만료가 다가오는 서류', () => {
  it('30일 안(지난 것 포함)만, 7일 안·확인 필요는 황토, 누르면 그 서류', () => {
    const b = buildBoard(
      base({
        docs: [
          { id: 'd1', name: '납세증명서', expiresOn: '2026-11-10', needsUser: false },
          { id: 'd2', name: '중소기업확인서', expiresOn: '2027-04-01', needsUser: false },
          { id: 'd3', name: '사업자등록증명', expiresOn: null, needsUser: false },
          { id: 'd4', name: '지난 서류', expiresOn: '2026-11-01', needsUser: false },
          { id: 'd5', name: '확인할 서류', expiresOn: '2026-11-30', needsUser: true },
        ],
      }),
    );
    const ex = b.cards.find((c) => c.kind === 'expiring')!;
    assert.deepEqual(ex.items.map((i) => i.id), ['doc:d4', 'doc:d1', 'doc:d5']);
    assert.deepEqual(ex.items.map((i) => i.tone), ['attention', 'attention', 'attention']);
    assert.equal(ex.items[0]!.detail, '만료됐어요 · 다시 발급');
    assert.deepEqual(ex.items[1]!.target, { to: 'doc', id: 'd1' });
    assert.equal(b.counts.expiringSoon, 2);
    assert.equal(b.counts.attention, 1);
  });
});

describe('머리 건수', () => {
  it('카드에 놓인 줄에서 센다: 지난 꾸러미는 확인 필요, 만료일 없는 확인 필요 서류는 세지 않는다, 만료 임박은 따로', () => {
    const b = buildBoard(
      base({
        today: '2026-11-09',
        bundle: { month: '2026-10', slots: [{ name: 'x', state: 'missing' }], sentOn: null },
        docs: [
          { id: 'd1', name: '만료일 없음', expiresOn: null, needsUser: true },
          { id: 'd2', name: '먼 만료', expiresOn: '2027-06-01', needsUser: true },
          { id: 'd3', name: '곧 만료', expiresOn: '2026-11-12', needsUser: true },
          { id: 'd4', name: '확인할 서류', expiresOn: '2026-11-30', needsUser: true },
        ],
      }),
    );
    const rows = b.cards.flatMap((c) => c.items);
    assert.ok(!rows.some((r) => r.id === 'doc:d1' || r.id === 'doc:d2'));
    assert.deepEqual(b.counts, { attention: 2, progress: 0, expiringSoon: 1 }, '꾸러미(지남) + d4 / d3');
    assert.equal(b.counts.attention + b.counts.expiringSoon, rows.filter((r) => r.tone === 'attention').length, '확인 필요·만료 임박 합 = 황토 줄 수');
  });
});

describe('정렬과 경계', () => {
  it('카드는 가장 이른 기한 순, 같으면 BOARD_KINDS 순. 빈 카드는 없다', () => {
    const b = buildBoard(
      base({
        issued: [{ who: 'A상사', date: '2026-10-04', total: 1 }],
        docs: [{ id: 'd1', name: '납세증명서', expiresOn: '2026-11-20', needsUser: false }],
        bundle: { month: '2026-10', slots: [{ name: '종이 영수증', state: 'missing', receipt: true }], sentOn: null },
        cardFetchedOn: '2026-10-01',
      }),
    );
    assert.deepEqual(b.cards.map((c) => c.kind), ['receipt', 'accountant', 'expiring', 'invoice']);
    assert.equal(buildBoard(base()).cards.length, 0);
    assert.deepEqual(BOARD_KINDS.map((k) => k.title), ['발급할 세금계산서', '받아야 할 증빙', '세무사에게 줄 것', '만료가 다가오는 서류']);
    assert.deepEqual(buildBoard(base({ issued: [{ who: 'A', date: '2026-10-01', total: 1 }] })), buildBoard(base({ issued: [{ who: 'A', date: '2026-10-01', total: 1 }] })), '같은 입력 같은 판');
  });

  it('판의 갈 곳에는 승인·실행 시작이 없다(ADR-021·033 결정 3), 문구에 세무 판단 표현이 없다(02 §12)', () => {
    const b = buildBoard(
      base({
        issued: [{ who: 'A상사', date: '2026-10-04', total: 1 }],
        runs: [{ id: 'r1', status: 'waiting', who: 'B' }],
        docs: [{ id: 'd1', name: 'x', expiresOn: '2026-11-06', needsUser: true }],
        bundle: mockBundle('2026-11-05'),
        cardFetchedOn: null,
      }),
    );
    const all = b.cards.flatMap((c) => c.items);
    for (const i of all) assert.ok(['run', 'doc', 'compose', 'view'].includes(i.target.to), i.id);
    // 상태 이름("승인 대기")은 보여도 된다. 승인 동작 문구는 없다.
    const text = JSON.stringify(b);
    for (const bad of ['승인하고', '승인하기', '발급하기', '발급기한', '까지', '세액 산정', '절세', '신고 대리', '가산세', '납부할 세액']) assert.ok(!text.includes(bad), bad);
  });

  it('"n건 더 보기"는 그 자리에서 펼친다(줄마다 갈 곳이 달라 다른 화면으로 보내지 않는다)', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../apps/desktop/static/shell/shell.js'), 'utf8');
    const i = src.indexOf('function boardCard(c)');
    const body = src.slice(i, src.indexOf('function boardRow', i));
    assert.ok(body.includes('boardExpanded') && !body.includes('go('), body.slice(0, 200));
  });

  it('main: 판 계산은 세대 표로 늦게 끝난 옛 계산을 버리고, KST 날짜가 바뀌면 다시 계산한다', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../apps/desktop/src/shell-app.ts'), 'utf8');
    assert.match(src, /gen === boardGen && send\(\{ type: 'board', board \}\)/);
    assert.match(src, /kstToday\(Date\.now\(\)\) !== boardDay\) pushBoard\(\)/);
    assert.match(src, /clearInterval\(boardDayTimer\)/);
  });

  it('main: 문서함을 읽지 못하면 판을 보내지 않고(지난 판 유지) 날짜 타이머가 다시 계산한다', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../apps/desktop/src/shell-app.ts'), 'utf8');
    const i = src.indexOf('const boardNow = async');
    const body = src.slice(i, src.indexOf('return buildBoard(', i));
    assert.ok(!body.includes('store.docs'), '실패를 목업 서류로 덮지 않는다');
    assert.match(body, /catch\(\(e: unknown\) => \{\s*boardDay = '';\s*throw e;/);
    assert.ok(body.indexOf("boardDay = today") > body.indexOf('await listDocs()'), '성공한 뒤에만 날짜를 적는다');
  });

  it('렌더러 판 코드에는 승인·실행 시작 호출이 없다', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../apps/desktop/static/shell/shell.js'), 'utf8');
    const i = src.indexOf('function renderToday()');
    const body = src.slice(i, src.indexOf('// ---- 작업 패널 ----', i));
    for (const bad of ["call('run.prepare'", 'sx-btn-approve', '승인하고 발급', "call('request.send'"]) assert.ok(!body.includes(bad), bad);
  });
});

describe('M4-2 3부: InDoubt·핸드오프 화면(08 §11, D03 HandedOff)', () => {
  const views = () => fs.readFileSync(path.resolve(import.meta.dirname, '../apps/desktop/static/shell/shell-views.js'), 'utf8');
  const branch = (src: string, start: string, end: string) => {
    const i = src.indexOf(start);
    assert.ok(i >= 0, start);
    return src.slice(i, src.indexOf(end, i + start.length));
  };

  it('판: 발급됐는지 모르는 실행은 "발급 여부 확인 필요" 줄(확인 필요 건수에 들어간다)', () => {
    const b = buildBoard(base({ runs: [{ id: 'r1', status: 'attention', who: 'B상사', inDoubt: true }, { id: 'r2', status: 'attention', who: 'C테크' }] }));
    const rows = b.cards.flatMap((c) => c.items);
    assert.equal(rows.find((x) => x.id.endsWith('r1'))?.detail, '발급 여부 확인 필요');
    assert.equal(rows.find((x) => x.id.endsWith('r2'))?.detail, '확인 필요');
    assert.equal(b.counts.attention, 2);
  });

  it('InDoubt 카드·확인 중 카드에는 다시 발급하는 길이 없다(준비·지난번과 같게·다시 발급·승인 없음)', () => {
    const src = views();
    for (const body of [branch(src, "} else if (st === 'attention' && run.inDoubt) {", '} else if'), branch(src, '} else if (verifying(run)) {', '} else if'), branch(src, 'function checkListGuide(run, act) {', '\n}\n')]) {
      for (const bad of ['act.prepare', 'act.again', 'act.reissue', 'sx-btn-approve', '승인하고 발급', "'request.send'"]) assert.ok(!body.includes(bad), bad);
    }
  });

  it('핸드오프 카드의 버튼은 재개·직접 발급함·중지뿐이고(로그인 [이어서], 서명 [다 했어요]·[중지], [직접 발급함]은 그 밖만), 렌더러 띠에는 승인 버튼이 없다', () => {
    const src = views();
    const body = branch(src, "} else if (st === 'turn' && run.handoff) {", "} else if (st === 'turn') {");
    const acts = [...new Set([...body.matchAll(/act\.([a-zA-Z]+)\(/g)].map((m) => m[1]))].sort();
    assert.deepEqual(acts, ['manualDone', 'resume', 'stop']);
    assert.match(body, /kind === 'login' \? btn\('이어서'/);
    assert.match(body, /kind === 'other' \? btn\('직접 발급함'/);
    assert.match(body, /btn\('중지', \(\) => act\.stop\(run\.id\)/);
    assert.ok(!/act\.(prepare|again|reissue)|sx-btn-approve/.test(body), '사람 차례 카드는 다시 발급하지 않는다');
    // 사람 차례 동안 패널에도 [중지]가 있다(서명 차례 포함: 엔진이 발급목록 확인 뒤 끝낸다)
    assert.match(src, /st === 'turn' && \(!!run\.handoff \|\|/);
    const shell = fs.readFileSync(path.resolve(import.meta.dirname, '../apps/desktop/static/shell/shell.js'), 'utf8');
    const band = branch(shell, 'function renderHandoff() {', '\n}\n');
    assert.ok(!/call\(|승인|approv/.test(band), '띠는 카드·패널로 가는 것만');
  });
});
