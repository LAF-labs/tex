// 에이전트 길 기억(run/agent-path.ts): 돌아간 확인 스텝이 통과해야 남기고, 확인이 실패하면 남기지 않으며, 다시 걸은 길이 틀리면 버린다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentPathMemory, planSignature, type AgentPathFile, type JsonStore } from '@sax/engine';
import { HEAL_TTL_MS, type SelectorDict } from '@sax/engine/core';

class Mem implements JsonStore<AgentPathFile> {
  f: AgentPathFile | null = null;
  read() {
    return this.f ? (JSON.parse(JSON.stringify(this.f)) as AgentPathFile) : null;
  }
  write(v: AgentPathFile) {
    this.f = JSON.parse(JSON.stringify(v)) as AgentPathFile;
  }
}

const pkg = { entries: { a: { candidates: [{ kind: 'css', value: '#a' }], role: 'textbox', namePattern: '^a$', frame: 'main', landmark: 'r', commits: false } } } as unknown as SelectorDict;
const goal = [{ stepId: 's1', kind: 'fill', key: 'a', token: '{{inputs.x}}' }];
const act = { action: 'type' as const, el: { role: 'textbox', name: '', id: 'a2' }, token: '{{inputs.x}}', option: null, step: 's1' };

describe('에이전트 길 기억', () => {
  it('done 뒤 돌아간 스텝이 통과해야 남긴다', () => {
    const store = new Mem();
    const m = new AgentPathMemory(store, { now: () => 1000 });
    const sig = planSignature(goal, 's2', pkg);
    m.propose('s1', { sig, resume: 's2', actions: [act] });
    assert.equal(store.f, null);
    m.confirmed('s9');
    assert.equal(store.f, null);
    m.confirmed('s2');
    assert.equal(store.f?.paths.s1?.actions.length, 1);
    assert.ok(new AgentPathMemory(store, { now: () => 2000 }).get('s1', sig));
  });

  it('돌아간 스텝이 실패하면 남기지 않는다. 다시 걸은 길로 실패하면 버린다', () => {
    const store = new Mem();
    const m = new AgentPathMemory(store, { now: () => 1000 });
    const sig = planSignature(goal, 's2', pkg);
    m.propose('s1', { sig, resume: 's2', actions: [act] });
    m.failed('s2', 'step.timeout');
    m.confirmed('s2');
    assert.equal(store.f, null);
    m.propose('s1', { sig, resume: 's2', actions: [act] });
    m.confirmed('s2');
    m.replaying('s1', 's2');
    m.failed('s2', 'step.repeat_exhausted');
    assert.equal(store.f?.paths.s1, undefined);
  });

  it('지문(패키지 항목·묶음)이 다르거나 기한이 지났거나 걸음이 없으면 쓰지 않는다', () => {
    const store = new Mem();
    const m = new AgentPathMemory(store, { now: () => 1000 });
    const sig = planSignature(goal, 's2', pkg);
    m.propose('s1', { sig, resume: 's2', actions: [] });
    m.confirmed('s2');
    assert.equal(store.f, null);
    m.propose('s1', { sig, resume: 's2', actions: [act] });
    m.confirmed('s2');
    const changed = { entries: { a: { ...pkg.entries.a!, namePattern: '^b$' } } } as unknown as SelectorDict;
    assert.notEqual(planSignature(goal, 's2', changed), sig);
    assert.equal(new AgentPathMemory(store, { now: () => 2000 }).get('s1', planSignature(goal, 's2', changed)), null);
    assert.equal(new AgentPathMemory(store, { now: () => 1000 + HEAL_TTL_MS + 1 }).get('s1', sig), null);
  });
});
