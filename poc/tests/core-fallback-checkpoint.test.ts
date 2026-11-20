import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FallbackChain, type PlaybookIR, type SelectorDict, type Step } from '@sax/engine/core';
import { FakeClock, FakePage } from './core-page-fakes.ts';

const steps = [
  { id: 's0', type: 'checkpoint', name: 'session', expect: { exists: 'root' }, url: 'https://x/', reentry: 'reload' },
  { id: 's2', type: 'branch', on: { exists: 'root' }, cases: { true: 's10' }, default: 's3' },
  { id: 's3', type: 'click', target: 'root' },
  { id: 's7', type: 'checkpoint', name: 'simple_login', expect: { exists: 'root' }, url: 'https://x/', reentry: 'reload' },
  { id: 's7e', type: 'handoff', reason: 'login.simpleAuth', resumeAt: 's10', code: 'login.simple_auth' },
  { id: 's10', type: 'goto', url: 'https://x/form' },
  { id: 's10a', type: 'wait', for: 'text', value: 'form.bizNoInBody', timeoutMs: 30000 },
  { id: 's99', type: 'end', status: 'success' },
] as unknown as Step[];
const ir = { ir: 2, id: 't', version: '1', steps } as unknown as PlaybookIR;
const dict = { entries: {} } as unknown as SelectorDict;

function chain(journal: Array<[string, Record<string, unknown>?]>) {
  const page = new FakePage(new FakeClock(), [{ id: 'body', role: 'document', name: '', css: ['body'] }]);
  return new FallbackChain({ ir, dict, page, irreversible: new Set(), journal: (t, p) => journal.push([t, p]) });
}

describe('폴백 체크포인트 재진입', () => {
  it('지나지 않은 간편인증 체크포인트(s7)로 뛰지 않고, 지난 세션 체크포인트(s0)로 한 번 돌아간다', async () => {
    const j: Array<[string, Record<string, unknown>?]> = [];
    const c = chain(j);
    c.confirmed('s0');
    c.confirmed('s2');
    c.confirmed('s10');
    assert.deepEqual(await c.recover('s10a', 'step.timeout'), { from: 's0' });
    assert.deepEqual(j.find(([t]) => t === 'fallback.checkpoint')?.[1], { stepId: 's10a', checkpoint: 's0', code: 'step.timeout' });
    assert.equal(await c.recover('s10a', 'step.timeout'), false);
  });
  it('지난 체크포인트가 없으면 돌아가지 않는다(사람에게)', async () => {
    const j: Array<[string, Record<string, unknown>?]> = [];
    assert.equal(await chain(j).recover('s10a', 'step.timeout'), false);
    assert.ok(!j.some(([t]) => t === 'fallback.checkpoint'));
  });
  it('간편인증 갈래를 실제로 지났다면 그 체크포인트가 마지막이다', async () => {
    const c = chain([]);
    c.confirmed('s0');
    c.confirmed('s7');
    assert.deepEqual(await c.recover('s10a', 'step.timeout'), { from: 's7' });
  });
});
