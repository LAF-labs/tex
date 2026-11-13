// 조회 포트 IrLookupPort(팀장 결정 2026-11-09 (가)): 서명 조회 패키지 IR을 허용 origin 팝업에서 돌리고 결과 표를 읽는다.
// 조건(팀장): ① 조회 실패는 게이트 전에 핸드오프로 멈춘다(verify.baseline_missing, 발급 0, fail-closed). ② 커밋 뒤 verify도 조회는 읽기만 한다(V-22).
// 조회 패키지는 제품 원본(packages/engine/playbooks/hometax.invoice.*)을 그대로 쓰고, 이동 주소·도메인만 시험 페이지(127.0.0.1)로 바꾼다.
// 실제 금고 중계 + Chrome(headless). 실제 포털 접속 없음.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { openDatabase, type Db } from '@sax/db';
import { connectRunBrowser, IrLookupPort, LOOKUP_STEP_TYPES, lookupComplete, RateGuard, ratePolicyFrom, RunEnforcer, SIGNAL_DICT, type RunBrowser } from '@sax/engine';
import {
  clampPolicy, FIXTURE_PORTAL, fixtureOriginGrant, lookupViolations, newScope, takeBaseline, VerifyBook,
  type LoadedPackage, type LookupRequest, type PackageFiles, type Policy, type Step, type StepOf, type VerifyDeps,
} from '@sax/engine/core';
import { golden, h01, loadPkg, POLICY_EXAMPLE } from './core-fixtures.ts';
import { FakeClock } from './core-page-fakes.ts';
import { startHarness, type Harness } from './harness.ts';

const POLICY = clampPolicy(structuredClone(POLICY_EXAMPLE) as unknown as Policy).policy;
const LOOKUP = 'hometax.invoice.lookup';
const MAIL = 'hometax.invoice.email_status';

interface Row { [col: string]: string }
/** 시험 페이지 상태(시험이 바꾼다). */
const page = {
  heads: ['승인번호', '공급받는자 등록번호', '작성일자', '공급가액', '세액'],
  rows: [] as Row[],
  /** 건수 문구에 더할 값(0이 아니면 표와 어긋난다). */
  countSkew: 0,
  /** 검색어 칸을 지운다(셀렉터가 틀린 경우). */
  noSearch: false,
  requests: [] as string[],
};

const html = (kind: 'lookup' | 'mail') => {
  const cols = kind === 'lookup' ? ['approvalNo', 'counterpartBizNo', 'issueDate', 'supplyAmount', 'taxAmount'] : ['approvalNo', 'status'];
  const heads = kind === 'lookup' ? page.heads : ['승인번호', '전송상태'];
  const data = JSON.stringify(page.rows.map((r) => cols.map((c) => r[c] ?? '')));
  return `<!doctype html><meta charset="utf-8"><title>조회</title>
<main aria-label="홈택스"><form aria-label="조회" onsubmit="return false">
${page.noSearch ? '' : '<input type="search" aria-label="검색어" id="q">'}
<select aria-label="조회기간"><option>1일</option><option>1주일</option></select>
<button type="button" id="go">조회하기</button>
<button type="button" id="issue" onclick="fetch('/issue',{method:'POST'})">발급하기</button>
<div role="status" aria-label="조회 건수" id="cnt">총 0건</div>
<table aria-label="조회 결과"><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody id="tb"></tbody></table>
</form></main>
<script>
const DATA = ${data};
document.getElementById('go').onclick = () => {
  const q = (document.getElementById('q') || {}).value || '';
  const rows = DATA.filter((r) => r.includes(q));
  document.getElementById('tb').innerHTML = rows.map((r) => '<tr>' + r.map((v) => '<td>' + v + '</td>').join('') + '</tr>').join('');
  document.getElementById('cnt').textContent = '총 ' + (rows.length + ${page.countSkew}) + '건';
};
</script>`;
};

/** 게시본 2.1.1 조회 패키지(머리글·건수 문구 관례) → 시험 페이지(fixture 포털 규칙, 127.0.0.1). 스텝·셀렉터·문구는 그대로. 실화면 판(data-col_id·idle)은 h01-real-dryrun이 본다. */
function testLookup(id: string, origin: string, mutate: (f: PackageFiles) => void = () => {}): LoadedPackage {
  const f = golden(id);
  f.manifest = { ...f.manifest, portal: FIXTURE_PORTAL, domains: ['127.0.0.1'] };
  f.playbook = { ...f.playbook, portal: FIXTURE_PORTAL };
  f.selectors = { ...f.selectors, portal: FIXTURE_PORTAL };
  const s0 = f.playbook.steps[0] as Step & { url: string };
  s0.url = `${origin}${id === LOOKUP ? '/lookup' : '/mail'}`;
  mutate(f);
  return { files: f } as LoadedPackage;
}

describe('IrLookupPort(서명 조회 패키지 IR, 금고 중계 + Chrome)', () => {
  let h: Harness;
  let run: RunBrowser;
  let server: http.Server;
  let origin: string;
  let root: string;
  let db: Db;
  before(async () => {
    server = http.createServer((req, res) => {
      page.requests.push(`${req.method} ${req.url}`);
      if (req.url === '/lookup') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html('lookup'));
      if (req.url === '/mail') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html('mail'));
      if (req.url === '/run') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>발급</title><main>발급 화면</main>');
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    h = await startHarness();
    run = await connectRunBrowser(h.client);
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-lookup-ir-'));
    db = openDatabase(path.join(root, 'a.sqlite'), new Uint8Array(randomBytes(32)));
    await run.page.goto(`${origin}/run`);
  });
  after(async () => {
    await run?.browser.close().catch(() => {});
    await h?.close();
    await new Promise((r) => server?.close(r));
    db?.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    Object.assign(page, { heads: ['승인번호', '공급받는자 등록번호', '작성일자', '공급가액', '세액'], rows: [], countSkew: 0, noSearch: false, requests: [] });
  });

  const INV: Row = { approvalNo: '20261106-41000012-00000123', counterpartBizNo: '2148651233', issueDate: '2026-11-06', supplyAmount: '1000000', taxAmount: '100000', status: '전송완료' };
  const REQ = (o: Partial<LookupRequest> = {}): LookupRequest => ({
    stepId: 's30', playbook: LOOKUP, match: { counterpartBizNo: '2148651233', issueDate: '2026-11-06', supplyAmount: '1000000', taxAmount: '100000' }, window: 'issueDate', purpose: 'verify', ...o,
  });

  function setup(o: { mutate?: (f: PackageFiles) => void } = {}) {
    const clock = new FakeClock();
    const journal: Array<[string, Record<string, string>]> = [];
    const rg = new RateGuard(db, 'hometax', ratePolicyFrom(POLICY, 'hometax', 'interactive')!, { wall: () => Date.now(), mono: () => clock.t });
    const enforcer = new RunEnforcer({ guard: rg, clock, mono: () => clock.t, dict: SIGNAL_DICT.fixture, profileId: `p${randomBytes(3).toString('hex')}`, journal: () => {}, random: () => 0 });
    const packages = new Map([[LOOKUP, testLookup(LOOKUP, origin, o.mutate)], [MAIL, testLookup(MAIL, origin, o.mutate)]]);
    const port = new IrLookupPort({
      page: run.page, packages, policy: enforcer, clock, fixtureGrant: fixtureOriginGrant(packages.get(LOOKUP)!),
      events: { security: () => {}, journal: (t, p) => journal.push([t, p]) },
    });
    return { port, journal };
  }
  const tabs = () => run.page.context().pages().length;

  it('발급 목록: 패키지 IR(검색어·기간·조회 클릭)로 연 표를 머리글 문구(strings lookup.column.*)로 열 이름에 맞춰 읽는다. 팝업은 닫고 원래 탭은 그대로', async () => {
    page.rows = [INV, { ...INV, approvalNo: '20261106-41000012-00000124', supplyAmount: '5000' }, { ...INV, approvalNo: 'x', counterpartBizNo: '9999999999' }];
    const before = tabs();
    const url = run.page.url();
    const r = await setup().port.run(REQ());
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.rows.map((x) => x.approvalNo), ['20261106-41000012-00000123', '20261106-41000012-00000124'], '검색어(상대방 사업자번호)로 걸렀다');
    assert.deepEqual(r.rows[0], { counterpartBizNo: '2148651233', issueDate: '2026-11-06', supplyAmount: '1000000', taxAmount: '100000', approvalNo: '20261106-41000012-00000123' });
    assert.equal(tabs(), before, '팝업을 닫았다');
    assert.equal(run.page.url(), url, '원래 탭은 이동하지 않았다');
  });

  it('메일 발송 상태(email_status): 승인번호 검색, status 열', async () => {
    page.rows = [INV];
    const r = await setup().port.run(REQ({ stepId: 's33', playbook: MAIL, match: { approvalNo: INV.approvalNo! }, window: 'today' }));
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.rows, [{ approvalNo: INV.approvalNo, status: '전송완료' }]);
  });

  it('0건도 건수 문구가 0이면 성공(부재 증거가 될 수 있는 유일한 빈 결과)', async () => {
    assert.deepEqual(await setup().port.run(REQ()), { ok: true, rows: [] });
  });

  it('건수 문구와 행 수가 다르면 lookup.incomplete(덜 그린 표·쪽 넘김은 부재가 아니다)', async () => {
    page.rows = [INV];
    page.countSkew = 1;
    assert.deepEqual(await setup().port.run(REQ()), { ok: false, code: 'lookup.incomplete' });
  });

  it('match·승인번호 열 머리글을 못 찾으면 lookup.columns_missing(빈칸으로 읽어 "없음"이 되지 않게)', async () => {
    page.rows = [INV];
    page.heads = ['승인 번호(변경)', '공급받는자 등록번호', '작성일자', '공급가액', '세액'];
    assert.deepEqual(await setup().port.run(REQ()), { ok: false, code: 'lookup.columns_missing' });
  });

  it('조회 패키지 셀렉터가 틀리면 lookup.failed, 저널 lookup.step_failed에 스텝 id·종류·셀렉터 키(값 없음)', async () => {
    page.noSearch = true;
    page.rows = [INV];
    const s = setup();
    assert.deepEqual(await s.port.run(REQ({ purpose: 'baseline' })), { ok: false, code: 'lookup.failed' });
    const j = s.journal.find(([t]) => t === 'lookup.step_failed');
    assert.ok(j);
    assert.deepEqual({ ...j[1], code: '' }, { playbook: LOOKUP, purpose: 'baseline', stepId: 's2', stepType: 'fill', target: 'hometax.lookup.searchKey', code: '' });
    assert.ok(!JSON.stringify(s.journal).includes('2148651233'), '입력 값은 저널에 없다');
  });

  describe('① 조회 실패 = 게이트 전 핸드오프(발급 0, fail-closed)', () => {
    const ir = h01().playbook;
    const gate = [...ir.steps].find((x) => x.type === 'gate') as StepOf<'gate'>;
    const deps = (port: IrLookupPort): VerifyDeps => {
      const scope = newScope();
      for (const [k, v] of Object.entries(REQ().match)) scope.readback.set(k, v);
      return { lookup: port, book: new VerifyBook(), scope, dict: h01().selectors, strings: h01().strings } as unknown as VerifyDeps;
    };
    it('기준선 조회가 실패하면(셀렉터·건수·열) takeBaseline은 verify.baseline_missing: 조율기는 게이트를 열지 않고 핸드오프한다', async () => {
      assert.ok(gate);
      for (const prep of [() => (page.noSearch = true), () => (page.countSkew = 2), () => (page.heads = ['?', '?', '?', '?', '?'])]) {
        Object.assign(page, { heads: ['승인번호', '공급받는자 등록번호', '작성일자', '공급가액', '세액'], countSkew: 0, noSearch: false, rows: [INV] });
        prep();
        const d = deps(setup().port);
        assert.deepEqual(await takeBaseline(d, ir, gate), { ok: false, code: 'verify.baseline_missing' });
        assert.equal(d.book.baseline('s30'), undefined, '기준선을 적지 않았다(빈 기준선으로 새 건을 세지 않는다)');
      }
    });
    it('기준선이 되면 승인번호 집합을 적는다', async () => {
      page.rows = [INV];
      const d = deps(setup().port);
      assert.deepEqual(await takeBaseline(d, ir, gate), { ok: true });
      assert.deepEqual([...(d.book.baseline('s30') ?? [])], [INV.approvalNo]);
    });
  });

  describe('② 조회는 읽기만(V-22, 커밋 뒤 verify도 같다)', () => {
    it('verify(커밋 뒤) 조회도 발급 버튼·원래 탭을 건드리지 않는다: 시험 페이지의 /issue POST 0건', async () => {
      page.rows = [INV];
      const s = setup();
      for (const purpose of ['baseline', 'verify'] as const) assert.ok((await s.port.run(REQ({ purpose }))).ok);
      assert.deepEqual(page.requests.filter((q) => q.startsWith('POST')), []);
    });
    const bad: Array<[string, (f: PackageFiles) => void]> = [
      ['commits:true 항목을 누름', (f) => {
        f.selectors.entries['hometax.lookup.searchButton']!.commits = true;
      }],
      ['navigationOnly 아닌 click', (f) => {
        delete (f.selectors.entries['hometax.lookup.searchButton'] as { navigationOnly?: boolean }).navigationOnly;
      }],
      ['searchbox·combobox 밖 fill', (f) => {
        f.selectors.entries['hometax.lookup.searchKey']!.role = 'textbox';
      }],
      ['submit 스텝', (f) => {
        f.playbook.steps.splice(2, 0, { id: 'sx', type: 'submit', target: 'hometax.lookup.searchButton' } as unknown as Step);
      }],
      ['effects 있음', (f) => {
        f.manifest.effects = ['send'];
      }],
    ];
    for (const [name, mutate] of bad) {
      it(`로더를 거치지 않은 패키지라도 ${name}이면 팝업을 열지 않고 lookup.package_invalid`, async () => {
        page.rows = [INV];
        const before = page.requests.length;
        assert.deepEqual(await setup({ mutate }).port.run(REQ()), { ok: false, code: 'lookup.package_invalid' });
        assert.equal(page.requests.length, before, '요청 0건');
      });
    }
    it('실행 핸들러 종류 = V-22 허용 목록(그 밖의 종류는 정적 검증이 막고 실행 핸들러도 없다)', async () => {
      const src = await fsp.readFile(new URL('../packages/engine/src/core/validate.ts', import.meta.url), 'utf8');
      const v22 = /export function lookupViolations[\s\S]*?const allowed = new Set\(\[([^\]]*)\]\)/.exec(src)?.[1];
      assert.ok(v22);
      assert.deepEqual([...v22.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort(), [...LOOKUP_STEP_TYPES].sort());
    });
  });
});

describe('제품 조회 패키지 원본(게시할 판): IrLookupPort 관례', () => {
  for (const id of [LOOKUP, MAIL]) {
    it(`${id}: 첫 스텝 goto, [조회] 뒤 wait idle → rows extract(건수 문구 없는 'idle' 완결), data-col_id 열, 승인번호 열`, () => {
      const f = loadPkg(id);
      assert.equal(f.manifest.version, '1.2.0');
      assert.equal(f.playbook.steps[0]?.type, 'goto');
      const ex = f.playbook.steps.filter((s) => s.type === 'extract').map((s) => (s as StepOf<'extract'>).name);
      assert.deepEqual(ex, ['rows']);
      assert.equal(f.strings['lookup.table.colAttr'], 'data-col_id');
      assert.equal(f.strings['lookup.table.complete'], 'idle');
      assert.ok(f.strings['lookup.column.approvalNo']);
      assert.ok(lookupComplete(f.playbook.steps, f.strings, undefined, 0), '빈 결과도 다 온 것으로 본다(wait idle 뒤)');
      assert.ok(!lookupComplete(f.playbook.steps, f.strings, undefined, Number(f.strings['lookup.table.pageSize'])), '한 쪽이 꽉 차면 다 왔다고 보지 않는다');
      assert.deepEqual(lookupViolations(f), []);
    });
  }
  it('H-01 2.3.4의 lookupsUsed는 조회 1.2.0 두 개, verify match 열은 모두 조회 패키지 열이 있다', () => {
    const g = loadPkg('hometax.invoice.issue');
    assert.equal(g.manifest.version, '2.3.4');
    assert.deepEqual(g.manifest.lookupsUsed.map((l) => `${l.id}@${l.version}`), [`${LOOKUP}@1.2.0`, `${MAIL}@1.2.0`]);
    const flat: Step[] = [];
    const walk = (ss: readonly Step[]) => {
      for (const s of ss) {
        flat.push(s);
        for (const v of Object.values(s as unknown as Record<string, unknown>)) if (Array.isArray(v) && v.every((x) => x && typeof x === 'object' && 'type' in x)) walk(v as Step[]);
      }
    };
    walk(g.playbook.steps);
    for (const v of flat.filter((s) => s.type === 'verify') as StepOf<'verify'>[]) {
      const strings = loadPkg(v.lookup.playbook).strings;
      for (const col of Object.keys(v.lookup.match)) assert.ok(strings[`lookup.column.${col}`], `${v.id} ${col}`);
      if (v.lookup.rowVerdict) assert.ok(strings[`lookup.column.${v.lookup.rowVerdict.column}`]);
    }
  });
});
