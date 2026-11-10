// PR-D2(팀장 지시 2026-11-09 2·4): 제품 entry는 홈택스를 레지스트리에서 받은 서명 H-01 패키지로 IR 실행한다.
// fixture 개발 포털(시연·e2e)은 H01Runner 그대로. 실행이 멈추면 어느 스텝·셀렉터 키인지 결과·저널·로그에 남는다(화면 문구·입력 값 없음, ⑦).
// 실제 포털·모델 접속 없음.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BizVerifier, bundleInfoFrom, DataService, DecideRunner, fixturePortal, HOMETAX_PORTAL, RunEnd, RunService, stoppedAtOf, type PortalConfig } from '@sax/engine';
import type { PlaybookIR, Step } from '@sax/engine/core';
import { openDatabase } from '@sax/db';
import { BundleCatalog, type DecideResult, type RunToken } from '@sax/model';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import { Redactor } from '@sax/redaction';

const POC = path.resolve(import.meta.dirname, '..');
const src = (p: string) => fs.readFileSync(path.join(POC, p), 'utf8');

describe('제품 entry 배선(PR-D2)', () => {
  const entry = src('packages/engine/src/entry.ts');
  it('홈택스는 engine ir + 받은 서명 설치본(installedIrSource, H-01 id), fixture는 h01', () => {
    assert.match(entry, /const ir = portal\.kind === 'hometax';/);
    assert.match(entry, /engine: ir \? 'ir' : 'h01'/);
    assert.match(entry, /irSource: installedIrSource\(registry, \{ id: PRODUCT_PACKAGES\.h01, portal,/);
    assert.doesNotMatch(entry, /engine: 'h01'/, '제품 entry에 고정 h01 실행기가 남지 않는다');
  });
  it('decide 판정기는 게이트웨이로만(gatewayRunJudge), 실행마다 run 토큰(runTokenFor)', () => {
    assert.match(entry, /const runJudge = ir \? gatewayRunJudge\(egress\) : null;/);
    assert.match(entry, /judge: runJudge\.judge, runTokenFor: runJudge\.runTokenFor/);
    const intent = src('packages/engine/src/intent.ts');
    assert.match(intent, /export function gatewayRunJudge[\s\S]*?if \(!egress\.gatewayGuard\) return null;[\s\S]*?runTokenFor: \(runId\) => gatewayRunToken\(egress, \{ runId \}\)/);
  });
});

describe('DecideRunner 실행 토큰(함수형, PR-D2)', () => {
  const result = (): DecideResult & { injectionHit: boolean; shadow: [] } =>
    ({ outcome: 'logged_in', confidence: 1, raw: {}, usage: { input_tokens: 0, output_tokens: 0 } as DecideResult['usage'], refusals: [], rule: 3, provider: 'openai', model: 'm', l0Only: false, injectionHit: false, shadow: [] });
  const STEP = { id: 's2', type: 'decide', bundle: 'screen_state_v2', scope: 'root', on: { logged_in: 's3', unknown: 'abort' } } as Step;
  function runner(token: () => Promise<RunToken>) {
    const seen: RunToken[] = [];
    const journal: string[] = [];
    const r = new DecideRunner({
      screen: { capture: async () => ({ url: 'https://hometax.go.kr/', title: '홈택스', tree: { role: 'document', children: [{ role: 'heading', name: '홈' }] } }) },
      redactor: new Redactor({ runId: 'run-1' }),
      judge: { decide: async (_b, _o, _i, t) => (seen.push(t), result()) },
      runToken: token,
      bundle: bundleInfoFrom(BundleCatalog.load()),
      journal: (t) => journal.push(t),
    });
    return { r, seen, journal, run: () => r.handler(STEP as never, {} as never) };
  }
  it('첫 decide 때 한 번 받아 두고 다음 decide에 다시 쓴다', async () => {
    let calls = 0;
    const x = runner(async () => (calls++, 'tok-1' as RunToken));
    assert.deepEqual(await x.run(), { t: 'jump', to: 's3' });
    assert.deepEqual(await x.run(), { t: 'jump', to: 's3' });
    assert.equal(calls, 1);
    assert.deepEqual(x.seen, ['tok-1', 'tok-1']);
  });
  it('토큰을 못 받으면 모델을 부르지 않고 decide.unavailable, 다음 decide에서 다시 받는다', async () => {
    let calls = 0;
    const x = runner(async () => {
      if (++calls === 1) throw new Error('gateway 503');
      return 'tok-2' as RunToken;
    });
    assert.deepEqual(await x.run(), { t: 'fail', code: 'decide.unavailable' });
    assert.equal(x.seen.length, 0);
    assert.ok(x.journal.includes('decide.unavailable'));
    assert.deepEqual(await x.run(), { t: 'jump', to: 's3' });
    assert.deepEqual(x.seen, ['tok-2']);
  });
});

describe('RunService IR 시작: H01 포털 표(TODO 셀렉터)를 보지 않는다(PR-D2)', () => {
  function service(engine: 'ir' | 'h01', portal: PortalConfig) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-prd2-'));
    const db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
    const data = new DataService(db, new BizVerifier(new Egress()));
    data.profiles.upsert({ kind: 'business', displayName: '가나다컴퍼니', bizNo: '1234567891', corpNo: null, repName: '김가나', bizType: null, bizItem: null, address: null, email: null, signMethod: 'simple_auth' });
    const cp = data.counterparties.create({ bizNo: '2148651233', name: 'A상사', email: 'tax@asangsa.example' }).id;
    let pages = 0;
    const runs = new RunService({
      db, data, ledgerKey: new Uint8Array(randomBytes(32)), portal, log: new FileEventLog(null, 'engine'), engine,
      irSource: () => ({ ok: false, code: 'package.not_loaded' }),
      page: async () => (pages++, null as never),
      postGate: () => {},
    });
    const close = () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    };
    return { runs, cp, pages: () => pages, close };
  }
  const start = (s: ReturnType<typeof service>) => () => s.runs.start({ runId: 'prd2-1', counterpartyId: s.cp, supply: 1_000_000, tax: 100_000, itemName: '경영 컨설팅' });

  it('홈택스 + ir: 셀렉터 자리표시자로 막지 않고 패키지 공급으로 간다(설치본 없음 → package.not_loaded, 브라우저 안 염)', () => {
    const s = service('ir', HOMETAX_PORTAL);
    try {
      assert.throws(start(s), (e: unknown) => e instanceof RunEnd && e.code === 'package.not_loaded');
      assert.equal(s.pages(), 0);
    } finally {
      s.close();
    }
  });
  it('홈택스 + h01(제품에는 없음): 이전처럼 selector_placeholder', () => {
    const s = service('h01', HOMETAX_PORTAL);
    try {
      assert.throws(start(s), (e: unknown) => e instanceof RunEnd && e.code === 'selector_placeholder');
    } finally {
      s.close();
    }
  });
  it('ir이어도 verify 하한 아래 포털은 거부(selector_placeholder)', () => {
    const s = service('ir', { ...HOMETAX_PORTAL, verify: { ...HOMETAX_PORTAL.verify, minElapsedMs: 1 } });
    try {
      assert.throws(start(s), (e: unknown) => e instanceof RunEnd && e.code === 'selector_placeholder');
    } finally {
      s.close();
    }
  });
  it('fixture 포털은 ir 하한 검사에 걸리지 않는다(시연 경로)', () => {
    const s = service('ir', fixturePortal('http://127.0.0.1:1'));
    try {
      assert.throws(start(s), (e: unknown) => e instanceof RunEnd && e.code === 'package.not_loaded');
    } finally {
      s.close();
    }
  });
});

describe('멈춘 스텝·셀렉터 키(stoppedAtOf, 팀장 지시 2026-11-09 4)', () => {
  const ir = JSON.parse(src('packages/engine/playbooks/hometax.invoice.issue/playbook.json')) as PlaybookIR;
  const all: Step[] = [];
  const walk = (steps: readonly Step[]) => {
    for (const s of steps) {
      all.push(s);
      for (const v of Object.values(s as unknown as Record<string, unknown>)) if (Array.isArray(v) && v.every((x) => x && typeof x === 'object' && 'id' in x && 'type' in x)) walk(v as Step[]);
    }
  };
  walk(ir.steps);

  it('대상이 있는 스텝: id·종류·셀렉터 키(실제 H-01)', () => {
    const s = all.find((x) => typeof (x as { target?: unknown }).target === 'string')!;
    assert.ok(s, 'H-01에 target 스텝이 있다');
    assert.deepEqual(stoppedAtOf(ir, s.id), { stepId: s.id, type: s.type, target: (s as unknown as { target: string }).target });
  });
  it('셀렉터를 기다리는 wait는 그 셀렉터 키가 대상', () => {
    const w = all.find((x) => x.type === 'wait' && (x as { for?: string }).for === 'selector') as (Step & { value: string }) | undefined;
    if (!w) return;
    assert.deepEqual(stoppedAtOf(ir, w.id), { stepId: w.id, type: 'wait', target: w.value });
  });
  it('대상 없는 스텝은 target 없음, 모르는 id는 unknown, 스텝 없음은 undefined', () => {
    const g = all.find((x) => !('target' in x) && x.type !== 'wait')!;
    assert.deepEqual(stoppedAtOf(ir, g.id), { stepId: g.id, type: g.type });
    assert.deepEqual(stoppedAtOf(ir, 'nope'), { stepId: 'nope', type: 'unknown' });
    assert.equal(stoppedAtOf(ir, null), undefined);
  });
  it('엔진 로그 run.stopped_at·저널 run.ended에는 스텝 id·종류·셀렉터 키·코드만(화면 문구·입력 값 칸 없음)', () => {
    const runs = src('packages/engine/src/runs.ts');
    const line = /this\.d\.log\.event\('run\.stopped_at', \{([^}]*)\}\)/.exec(runs)?.[1];
    assert.ok(line);
    const keys = [...line.matchAll(/(\w+):/g)].map((m) => m[1]);
    assert.deepEqual(keys, ['runId', 'status', 'code', 'stepId', 'stepType', 'target', 'playbook']);
  });
});
