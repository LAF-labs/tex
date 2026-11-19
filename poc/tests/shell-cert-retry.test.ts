// 공동인증서 로그인 실패(H-01 s7e login.simple_auth): 처음이면 같은 값으로 인증서 로그인을 한 번 더(사람에게 묻지 않음),
// 두 번째면 사람이 고른다([인증서로 다시 시도] 또는 간편인증). 폰이 맡긴 건은 폰 추적이 새 실행으로 옮겨 간다.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { interpret } from '../apps/desktop/src/shell-mock.ts';
import { CERT_FAILED_TWICE, CERT_RETRY_NOTE, ShellRuns } from '../apps/desktop/src/shell-runs.ts';
import type { Counterparty } from '../apps/desktop/src/shell-model.ts';

const CPS: Counterparty[] = [{ id: 'cp-a', name: 'A상사', bizNo: '2148651233', rep: '이에이', email: 'tax@asangsa.example', item: '경영 컨설팅', status: '계속사업자', checkedOn: '', lastIssuedOn: null }];

class FakeHost extends EventEmitter {
  readonly calls: Array<[string, unknown]> = [];
  async control(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push([method, params]);
    return {};
  }
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push([method, params]);
    return {};
  }
}
const tick = () => new Promise((r) => setImmediate(r));

describe('공동인증서 로그인 실패 뒤 다시 시도', () => {
  it('처음 실패: 차례로 보이지 않고 멈춘 뒤 같은 값의 새 실행으로 다시 준비. 두 번째 실패: [인증서로 다시 시도] 차례', async () => {
    const host = new FakeHost();
    const prepared: string[] = [];
    const runs = new ShellRuns(host, { counterparties: () => CPS, auth: () => '공동인증서', prepare: async (id: string) => (prepared.push(id), runs.prepare(id)) } as never);
    const restarts: Array<{ from: string; to: string }> = [];
    runs.on('restart', (x) => restarts.push(x));
    const a = interpret('A상사에 16만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft');
    await runs.prepare(a.run.id);
    host.emit('run', { runId: a.run.id, type: 'handoff', phase: 'login', code: 'login.simple_auth' });
    const r1 = runs.get(a.run.id)!;
    assert.equal(r1.status, 'preparing', '자동 다시 시도 동안은 사람 차례가 아니다');
    assert.ok(host.calls.some(([m, p]) => m === 'run.stop' && (p as { runId: string }).runId === a.run.id));
    host.emit('run', { runId: a.run.id, type: 'end', status: 'stopped', code: 'run.stopped' });
    assert.equal(runs.get(a.run.id)!.replaced, true);
    await tick();
    await tick();
    assert.equal(restarts.length, 1);
    const b = runs.get(restarts[0]!.to)!;
    assert.equal(b.certRetryOf, a.run.id);
    assert.deepEqual(b.notices, [CERT_RETRY_NOTE]);
    assert.deepEqual(prepared, [b.id]);
    // 두 번째 실패: 사람이 고른다
    host.emit('run', { runId: b.id, type: 'handoff', phase: 'login', code: 'login.simple_auth' });
    const r2 = runs.get(b.id)!;
    assert.equal(r2.status, 'turn');
    assert.deepEqual(r2.turn, CERT_FAILED_TWICE);
    assert.doesNotMatch(r2.turn!.text, /PC/);
    // [인증서로 다시 시도]
    await runs.retryCert(b.id);
    host.emit('run', { runId: b.id, type: 'end', status: 'stopped', code: 'run.stopped' });
    await tick();
    await tick();
    assert.equal(restarts.length, 2);
    assert.equal(runs.get(restarts[1]!.to)!.certRetryOf, b.id);
  });
  it('[인증서로 다시 시도]는 공동인증서 실패 차례에서만', async () => {
    const host = new FakeHost();
    const runs = new ShellRuns(host, { counterparties: () => CPS, auth: () => '공동인증서' });
    const a = interpret('A상사에 16만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft');
    await runs.prepare(a.run.id);
    host.emit('run', { runId: a.run.id, type: 'handoff', phase: 'login', code: 'portal.captcha' });
    await assert.rejects(runs.retryCert(a.run.id), /not_cert_turn/);
  });
});
