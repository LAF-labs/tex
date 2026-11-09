// 받은 서명 정책의 나머지 적용(팀장 지시 2026-11-09, D03 §5.6·§7·§7.1, ADR-004·023):
// verify 타이밍은 내장 값보다 느슨해지지 않게, blockSignalsAdd는 더하기만, captchaRelay는 핸드오프만.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixturePortal, HOMETAX_PORTAL, matchSignal, runPortalConfig, runSignalDict, SIGNAL_DICT, stricterVerify, unionBlockSignals, type PortalConfig } from '@sax/engine';
import type { Policy } from '@sax/engine/core';
import { POLICY_EXAMPLE } from './core-fixtures.ts';

const SRC = fileURLToPath(new URL('../packages/engine/src/', import.meta.url));
const policy = (o: Partial<Policy['verify']> = {}, add?: Policy['cooldown']['blockSignalsAdd']): Policy => {
  const p = structuredClone(POLICY_EXAMPLE) as unknown as Policy;
  p.verify = { ...p.verify, ...o };
  if (add) p.cooldown.blockSignalsAdd = add;
  return p;
};
const BUILT = { minElapsedMs: 60_000, lookups: 2, intervalMs: 10_000, maxMs: 300_000 };

describe('verify 타이밍: 받은 정책과 내장 값 가운데 엄격한 쪽(D03 §5.6·§7.1 verify 행)', () => {
  it('필드마다 큰 쪽(더 오래·더 많이 조회). 간격은 정책에 없어 내장 값', () => {
    assert.deepEqual(stricterVerify(BUILT, { minElapsedMs: 90_000, lookups: 3, maxMs: 600_000 }), { minElapsedMs: 90_000, lookups: 3, intervalMs: 10_000, maxMs: 600_000 });
  });
  it('정책이 더 느슨하면 내장 값 그대로(느슨해지는 길이 없다)', () => {
    assert.deepEqual(stricterVerify(BUILT, { minElapsedMs: 30_000, lookups: 2, maxMs: 300_000 }), BUILT);
    assert.deepEqual(stricterVerify({ ...BUILT, maxMs: 400_000 }, { minElapsedMs: 30_000, lookups: 2 }), { ...BUILT, maxMs: 400_000 }, 'maxMs 없음 = 내장 값');
    assert.equal(stricterVerify(BUILT, null), BUILT);
  });
  it('maxMs는 minElapsedMs보다 짧게 두지 않는다(그러면 not_committed가 성립할 수 없다)', () => {
    const v = stricterVerify({ ...BUILT, maxMs: 300_000 }, { minElapsedMs: 600_000, lookups: 2, maxMs: 300_000 });
    assert.deepEqual([v.minElapsedMs, v.maxMs], [600_000, 600_000]);
  });
  it('실행 포털 설정: 홈택스만 합친 사본(원본은 그대로), fixture·정책 없음은 그대로', () => {
    const p = policy({ minElapsedMs: 120_000, lookups: 4, maxMs: 900_000 });
    const run = runPortalConfig(HOMETAX_PORTAL, p);
    assert.deepEqual(run.verify, { minElapsedMs: 120_000, lookups: 4, intervalMs: HOMETAX_PORTAL.verify.intervalMs, maxMs: 900_000 });
    assert.deepEqual(HOMETAX_PORTAL.verify, { minElapsedMs: 60_000, lookups: 2, intervalMs: 10_000, maxMs: 300_000 }, '내장 포털 값은 바뀌지 않는다');
    assert.equal(run.selectors, HOMETAX_PORTAL.selectors);
    const fx: PortalConfig = fixturePortal('http://127.0.0.1:1');
    assert.equal(runPortalConfig(fx, p), fx);
    assert.equal(runPortalConfig(HOMETAX_PORTAL, null), HOMETAX_PORTAL);
  });
  it('RunService가 시작 때 한 번 정한 포털 설정을 두 실행기(H01·IR)와 RunPolicy에 준다(실행 중 바꾸지 않음: verify는 커밋 구간 안)', () => {
    const src = fs.readFileSync(path.join(SRC, 'runs.ts'), 'utf8');
    assert.match(src, /const startPolicy = this\.d\.portal\.kind === 'hometax' \? \(this\.d\.receivedPolicy\?\.\(\) \?\? null\) : null;\n\s*const portal = runPortalConfig\(this\.d\.portal, startPolicy\);/);
    assert.match(src, /new H01Runner\(page, a\.portal,/);
    assert.match(src, /new RunPolicy\(page, this\.rate, a\.portal, \{\n\s*profileId: profile\.id,\n\s*signals: a\.signals,/);
    assert.match(src, /portal: a\.portal, signals: a\.signals, rate: this\.rate,/);
    assert.doesNotMatch(src, /new H01Runner\(page, this\.d\.portal|portal: this\.d\.portal, rate/);
  });
});

describe('blockSignalsAdd: 앱 내장 사전에 더하기만(D03 §7 (d), C-24)', () => {
  const BLOCK = '비정상적인 접근이 감지되어 이용이 제한되었습니다';
  it('합집합: 순서 유지, 같은 값은 하나', () => {
    assert.deepEqual(unionBlockSignals({ urlPatterns: ['/a$'], phrases: ['가나'] }, { urlPatterns: ['/b$', '/a$'], phrases: ['가나', '다라'] }), { urlPatterns: ['/a$', '/b$'], phrases: ['가나', '다라'] });
    assert.deepEqual(unionBlockSignals(undefined, undefined), { urlPatterns: [], phrases: [] });
  });
  it('내장 항목은 빠지지 않는다(정책에 빼는 수단이 없다)', () => {
    const d = runSignalDict({ builtIn: SIGNAL_DICT.hometax, atStart: { phrases: [BLOCK] }, current: () => undefined, inCommit: () => false })();
    for (const e of SIGNAL_DICT.hometax) assert.ok(d.includes(e), e.id);
    assert.equal(matchSignal(d, { text: `안내 ${BLOCK}.` })?.kind, 'block');
  });
  it('실행 중: 새로 더한 항목은 다음 검사부터 걸리고, 시작 때 항목은 정책이 빼도 그 실행 끝까지 남는다', () => {
    let current: Policy['cooldown']['blockSignalsAdd'] = { phrases: ['처음 문구'] };
    const dict = runSignalDict({ builtIn: SIGNAL_DICT.hometax, atStart: current, current: () => current, inCommit: () => false });
    assert.equal(matchSignal(dict, { text: BLOCK }), null);
    current = { phrases: [BLOCK] }; // 처음 문구를 빼고 BLOCK을 더했다
    assert.equal(matchSignal(dict, { text: BLOCK })?.kind, 'block', '더한 것은 바로');
    assert.equal(matchSignal(dict, { text: '처음 문구' })?.kind, 'block', '뺀 것은 다음 실행부터');
  });
  it('커밋 구간에는 새 값을 적용하지 않는다(시작 때 사전)', () => {
    const current: Policy['cooldown']['blockSignalsAdd'] = { phrases: [BLOCK] };
    let commit = true;
    const dict = runSignalDict({ builtIn: SIGNAL_DICT.hometax, atStart: undefined, current: () => current, inCommit: () => commit });
    assert.equal(matchSignal(dict, { text: BLOCK }), null, '커밋 구간');
    commit = false;
    assert.equal(matchSignal(dict, { text: BLOCK })?.kind, 'block', 'verify가 끝난 뒤');
  });
  it('RE2 부분집합이 아닌 URL 패턴·빈 문구는 버리고 위치만 알린다. 받은 추가가 같으면 다시 만들지 않는다', () => {
    const dropped: string[] = [];
    const add = { urlPatterns: ['/blocked$', '(a+)+$'], phrases: ['  '] };
    const dict = runSignalDict({ builtIn: [], atStart: add, current: () => add, inCommit: () => false, onDropped: (w) => dropped.push(w) });
    const a = dict();
    assert.equal(dict(), a);
    assert.deepEqual(a.map((e) => e.url ?? e.text), ['/blocked$']);
    assert.deepEqual(dropped, ['urlPatterns[1]', 'phrases[0]']);
  });
  it('RunService: 받은 정책은 홈택스만, 커밋 구간 = 이 실행의 원장 행이 armed·dispatched', () => {
    const src = fs.readFileSync(path.join(SRC, 'runs.ts'), 'utf8');
    assert.match(src, /if \(this\.d\.portal\.kind !== 'hometax' \|\| !received\) return builtIn;/);
    assert.match(src, /inCommit: \(\) => this\.ledger\.statesByRun\(runId\)\.some\(\(st\) => st === 'armed' \|\| st === 'dispatched'\)/);
    assert.match(fs.readFileSync(path.join(SRC, 'run/service-ir.ts'), 'utf8'), /dict: i\.signals \?\? SIGNAL_DICT\[i\.portal\.kind\]/);
    assert.match(fs.readFileSync(path.join(SRC, 'policy.ts'), 'utf8'), /dict: o\.signals \?\? SIGNAL_DICT\[portal\.kind\]/);
  });
});

describe('captchaRelay: 캡차는 사람에게 넘기기만(절대 규칙, ADR-004, D03 §7)', () => {
  it('엔진 실행 코드는 captchaRelay를 읽지 않는다(정책 수용·클램프·보수 판정만). allowed여도 중계·자동 입력 경로가 없다', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(SRC);
    const users = files.filter((f) => /captchaRelay|CAPTCHA_RELAY_CEILING/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f).split(path.sep).join('/')).sort();
    assert.deepEqual(users, ['core/constants.ts', 'core/policy.ts', 'core/types.ts']);
  });
  it('캡차 신호는 두 실행 경로 모두 핸드오프 코드(portal.captcha)다', () => {
    for (const f of ['policy.ts', 'enforcer.ts']) assert.match(fs.readFileSync(path.join(SRC, f), 'utf8'), /captcha: 'portal\.captcha'/, f);
    assert.match(fs.readFileSync(path.join(SRC, 'core/interp.ts'), 'utf8'), /\['portal\.captcha', 'handoff'\]/);
    assert.match(fs.readFileSync(path.join(SRC, 'run/controller.ts'), 'utf8'), /if \(h\.kind === 'captcha'\) return this\.handoffWith\('portal\.captcha'\);/);
  });
});
