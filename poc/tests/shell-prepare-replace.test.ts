// 정정·다음 건: 진행 중인 건이 있어도 사장님께 [중지]를 시키지 않는다(대표 지적 2026-11-19 "100원으로 정정했는데 앞 건이 끝나야 한대, 중지를 눌러야 하는 것도 말이 안 됨").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { ShellRuns } from '../apps/desktop/src/shell-runs.ts';

const cps = [
  { id: 'cp1', name: '일호유통', bizNo: '1234567890', email: 'a@b.co', item: '기타' },
  { id: 'cp2', name: 'A상사', bizNo: '2234567890', email: 'c@d.co', item: '기타' },
] as never[];
const mk = () => new ShellRuns({ control: async () => ({}), rpc: async () => ({}), on: () => {} } as never, { counterparties: () => cps, auth: () => '' });

describe('ShellRuns: 바꿔도 되는 진행 중 실행', () => {
  it('승인 전 준비만 바꾼다. 승인을 보냈거나 게이트를 지났거나 발급 중이면 바꾸지 않는다', () => {
    const runs = mk();
    const r = runs.createDraft(cps[0]!, 100, null, '기타');
    assert.equal(runs.activeRun(), null);
    assert.equal(runs.replaceable(r.id), false); // 초안은 진행 중이 아니다
    r.status = 'preparing';
    assert.equal(runs.activeRun()?.id, r.id);
    assert.equal(runs.replaceable(r.id), true);
    r.status = 'turn';
    r.handoff = { phase: 'login', afterGate: false, kind: 'login' };
    assert.equal(runs.replaceable(r.id), true);
    r.handoff = { phase: 'sign', afterGate: true, kind: 'sign' };
    assert.equal(runs.replaceable(r.id), false);
    r.handoff = null;
    r.status = 'preparing';
    r.approvedPending = true;
    assert.equal(runs.replaceable(r.id), false);
    r.approvedPending = false;
    r.status = 'issuing';
    assert.equal(runs.replaceable(r.id), false);
  });
  it('noteOn은 진행 중인 다른 실행으로 옮기지 않고 그 카드에만 붙인다', () => {
    const runs = mk();
    const a = runs.createDraft(cps[0]!, 110, null, '기타');
    a.status = 'preparing';
    const b = runs.createDraft(cps[0]!, 100, 'included', '기타');
    runs.noteOn(b.id, '앞에서 준비하던 건을 멈추고 이 내용으로 바로 준비해요.');
    assert.deepEqual(runs.get(b.id)?.notices, ['앞에서 준비하던 건을 멈추고 이 내용으로 바로 준비해요.']);
    assert.equal(runs.get(a.id)?.notices?.length ?? 0, 0);
  });
});

describe('shell-app: 바쁠 때 [중지] 없이 바꾸거나 이어서 준비한다(배선)', () => {
  const src = fs.readFileSync(new URL('../apps/desktop/src/shell-app.ts', import.meta.url), 'utf8');
  it('0클릭 준비와 [홈택스에서 준비]가 둘 다 queueIfBusy를 먼저 본다', () => {
    assert.match(src, /log\.event\('main\.prepare_auto', \{\}\);\s*if \(queueIfBusy\(id\)\) return;/);
    assert.match(src, /'run\.prepare': async \(p\) => \{\s*needGesture\(2_000\);\s*const id = String\(p\.id\);[\s\S]{0,120}if \(queueIfBusy\(id\)\) return runs\.get\(id\);/);
  });
  it('같은 거래처의 승인 전 준비는 멈추고 바꾸고, 그 밖에는 앞 건이 끝나면 이어서 시작한다', () => {
    assert.match(src, /runs\.replaceable\(active\.id\) && active\.counterparty\.id === d\.counterparty\.id/);
    assert.match(src, /runs\.stop\(active\.id\)/);
    assert.match(src, /if \(!nextUp \|\| runs\.anyActive\(\)\) return;/);
  });
  it('사장님께 [중지]를 누르라는 말이 없다', () => {
    for (const m of src.matchAll(/const (REPLACING|REPLACED|QUEUED)_NOTE = '([^']+)'/g)) assert.doesNotMatch(m[2]!, /중지를 눌러|\[중지\]/);
  });
});
