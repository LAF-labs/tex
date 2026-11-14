// 사람 비밀 입력 창 포트(M2-3, D05 §3.5, ADR-005 v3): 금고 secretWindow.openForHuman → secret_window.closed | TTL → requestClose. 가짜 금고.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VaultSecretPort, type SecretVault, type VaultSecretInput } from '@sax/engine';
import type { SelectorDict, SelectorEntry } from '@sax/engine/core';

type Json = Record<string, unknown>;
const entry = (o: Partial<SelectorEntry>): SelectorEntry => ({ role: 'textbox', namePattern: '^비밀번호$', landmark: 'p.root', candidates: [{ kind: 'role', role: 'textbox', name: '비밀번호' }], frame: 'main', commits: false, lastVerified: '2026-11-01', ...o });
const DICT: SelectorDict = {
  portal: 'hometax', commitEndpoints: [], knownEndpoints: [],
  entries: {
    'f.pw': entry({ candidates: [{ kind: 'role', role: 'textbox', name: '비밀번호' }, { kind: 'css', value: '#pw' }], secretKind: 'cert_password' } as Partial<SelectorEntry>),
    'f.roleOnly': entry({}),
    'f.inFrame': entry({ frame: 'iframe#cert', candidates: [{ kind: 'css', value: '#pw' }] }),
    'f.noFrame': entry({ frame: '', candidates: [{ kind: 'css', value: '#pw' }] }),
  },
};

class FakeVault implements SecretVault {
  calls: Array<[string, Json]> = [];
  answers: Record<string, unknown> = { 'secretWindow.openForHuman': { ok: true }, 'secretWindow.requestClose': { ok: true } };
  ls = new Set<(d: Json) => void>();
  onOpen?: () => void;
  async rpc<T>(m: string, p: Json = {}): Promise<T> {
    this.calls.push([m, p]);
    if (m === 'secretWindow.openForHuman') queueMicrotask(() => this.onOpen?.());
    return this.answers[m] as T;
  }
  on(_n: string, fn: (d: Json) => void) {
    this.ls.add(fn);
    return () => this.ls.delete(fn);
  }
  close(targetId: string) {
    for (const f of [...this.ls]) f({ targetId });
  }
}

const mk = (o: Partial<VaultSecretInput> = {}) => {
  const vault = new FakeVault();
  const journal: Array<[string, unknown]> = [];
  const events: string[] = [];
  const timers: Array<() => void> = [];
  const port = new VaultSecretPort({
    vault, targetId: () => 'T1', dict: DICT, journal: (t, p) => journal.push([t, p]),
    announce: (r) => events.push(`announce ${r.stepId} ${r.prompt ?? ''}`), closed: (r) => events.push(`closed ${r.why}`),
    setTimer: (fn) => (timers.push(fn), () => {}), ...o,
  });
  return { port, vault, journal, events, timers };
};
const REQ = { runId: 'r1', stepId: 's4', target: 'f.pw', prompt: 'p.cert', ttlMs: 60_000 };

describe('VaultSecretPort(금고 비밀 창, D05 §3.5)', () => {
  it('css 후보로 창을 열고, 이 탭의 secret_window.closed면 done(값은 엔진에 오지 않는다)', async () => {
    const { port, vault, journal, events } = mk();
    vault.onOpen = () => {
      vault.close('OTHER');
      vault.close('T1');
    };
    assert.equal(await port.secret(REQ), 'done');
    assert.deepEqual(vault.calls, [['secretWindow.openForHuman', { runId: 'r1', targetId: 'T1', frame: 'main', element: '#pw' }]]);
    assert.deepEqual(journal.map(([t]) => t), ['human.secret_opened', 'human.secret_done']);
    assert.deepEqual(events, ['announce s4 p.cert', 'closed done']);
    assert.equal(vault.ls.size, 0);
  });

  it('하위 프레임 칸(frame = iframe 선택자, 홈택스 iframe#dscert)은 그 선택자를 금고에 넘겨 창을 연다', async () => {
    const { port, vault } = mk();
    vault.onOpen = () => vault.close('T1');
    assert.equal(await port.secret({ ...REQ, target: 'f.inFrame' }), 'done');
    assert.deepEqual(vault.calls, [['secretWindow.openForHuman', { runId: 'r1', targetId: 'T1', frame: 'iframe#cert', element: '#pw' }]]);
  });

  it('TTL이면 requestClose를 부르고 ttl(금고가 거부해도 ttl)', async () => {
    const { port, vault, timers, journal } = mk();
    vault.answers['secretWindow.requestClose'] = { ok: false };
    const w = port.secret(REQ);
    await new Promise((r) => setImmediate(r));
    timers.at(-1)!();
    assert.equal(await w, 'ttl');
    assert.deepEqual(vault.calls.at(-1), ['secretWindow.requestClose', { runId: 'r1', targetId: 'T1' }]);
    assert.deepEqual(journal.at(-1), ['human.secret_ttl', { stepId: 's4' }]);
  });

  it('열지 못하면(타깃 없음·css 후보 없음·프레임 없음·금고 거부·RPC 오류) 사유를 남기고 ttl, 금고를 부르지 않거나 한 번만', async () => {
    for (const [req, reason, opened] of [
      [{ ...REQ, target: undefined }, 'no_target', false], [{ ...REQ, target: 'f.roleOnly' }, 'no_css_candidate', false], [{ ...REQ, target: 'f.noFrame' }, 'frame_unsupported', false],
    ] as const) {
      const { port, vault, journal, events } = mk();
      assert.equal(await port.secret(req), 'ttl');
      assert.deepEqual(journal, [['human.secret_refused', { stepId: 's4', reason }]]);
      assert.equal(vault.calls.length > 0, opened);
      assert.deepEqual(events, ['closed refused']);
    }
    const a = mk();
    a.vault.answers['secretWindow.openForHuman'] = { ok: false, reason: 'origin_not_allowed' };
    assert.equal(await a.port.secret(REQ), 'ttl');
    assert.deepEqual(a.journal, [['human.secret_refused', { stepId: 's4', reason: 'origin_not_allowed' }]]);
    const b = mk();
    b.vault.rpc = async () => {
      throw new Error('vault: gone');
    };
    assert.equal(await b.port.secret(REQ), 'ttl');
    assert.deepEqual(b.journal, [['human.secret_refused', { stepId: 's4', reason: 'port_error' }]]);
    assert.equal(b.vault.ls.size, 0);
  });
});
