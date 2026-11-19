// 비밀 종류별 입력 규칙과 1회용 비밀 창 결속(ADR-020 결정 2, ADR-025 결정 10, D05 §3.5·§4).
// - 타이피스트는 포털 비밀번호만 넣는다. 인증서 비밀번호는 정책이 호스트를 허용해도 넣지 않는다.
// - 보안카드는 지원하지 않는다(대표 결정 2026-11-19): 타이피스트·1회용 창 어디에서도 받지 않는다.
// - 1회용 입력 창(secretInput oneshot)은 금고가 secret.needed로 부른 것만 붙는다.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { VaultClient } from '@sax/engine';
import { appPaths, FileEventLog, wrapPort } from '@sax/platform';
import { MemoryKeyStore, parseSecretInputBind, RPC_BY_PORT, Vault, type FillRequest, type SecretInputBind } from '@sax/vault';
import { fakeRelay, tick } from './fake-relay.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noAnswer = <T>(p: Promise<T>, ms = 200) => Promise.race([p.then(() => 'answered', () => 'answered'), sleep(ms).then(() => 'silent')]);

const req = (over: Partial<FillRequest> = {}): FillRequest => ({
  runId: 'r1', targetId: 'RUN', frame: 'main', element: '#pw',
  secret: { kind: 'portal_password', scope: 'business' }, slot: { secretKind: 'portal_password', purpose: 'login' }, ...over,
});
const count = (log: FileEventLog, ev: string) => log.lines.filter((l) => l.includes(`"${ev}"`)).length;

describe('타이피스트 종류 규칙(ADR-020 결정 2·ADR-025 결정 10)', () => {
  it('인증서 비밀번호는 정책이 호스트를 허용하고 1회용 값이 있어도 넣지 않는다', async () => {
    const f = await fakeRelay({ policy: { secretHosts: { cert_password: ['127.0.0.1'], portal_password: ['127.0.0.1'] } } });
    f.ops.secrets.provide({ runId: 'r1', kind: 'cert_password', scope: 'business' } as SecretInputBind, enc('TEST-CERT-rule0001'));
    const before = f.ops.secrets.size;
    const r = await f.ops.fill(req({ secret: { kind: 'cert_password', scope: 'business' }, slot: { secretKind: 'cert_password', purpose: 'login' } }));
    assert.deepEqual(r, { ok: false, reason: 'denied' });
    assert.equal(f.page.value, '', '입력하지 않았다');
    assert.equal(f.ops.secrets.size, before, '값을 꺼내지 않았다');
    assert.equal(count(f.log, 'vault.typist_kind_refused'), 1);
    assert.ok(!f.events.some((e) => e.name === 'secret.needed'), '창도 부르지 않는다');
    assert.ok(!f.log.lines.some((l) => l.includes('TEST-CERT')), '로그에 값이 없다');
  });

  it('모르는 종류·종류 없음은 거부한다', async () => {
    const f = await fakeRelay();
    for (const kind of ['evil', undefined, 42]) {
      assert.deepEqual(await f.ops.fill(req({ secret: { kind, scope: 'business' } as never })), { ok: false, reason: 'denied' }, String(kind));
    }
    assert.equal(count(f.log, 'vault.typist_kind_refused'), 3);
  });

  it('보안카드는 지원하지 않는다(대표 결정 2026-11-19): 타이피스트는 넣지 않고, 결속·엔진 RPC도 없다', async () => {
    const f = await fakeRelay();
    f.ops.secrets.provide({ runId: 'r1', kind: 'security_card', scope: 'business' } as never, enc('1011'));
    assert.deepEqual(await f.ops.fill(req({ secret: { kind: 'security_card', scope: 'business' }, slot: { secretKind: 'security_card' as never, purpose: 'sign' } })), { ok: false, reason: 'denied' });
    assert.equal(f.page.value, '');
    assert.equal(count(f.log, 'vault.typist_kind_refused'), 1);
    assert.ok(!f.events.some((e) => e.name === 'secret.needed'));
    // 1회용·등록 결속은 받지 않는다(포트를 붙이지 않는다)
    assert.equal(parseSecretInputBind({ runId: 'r1', kind: 'security_card', scope: 'business' }), null);
    assert.equal(parseSecretInputBind({ mode: 'store', kind: 'security_card', scope: 'business', notice: { version: 'v1' } }), null);
    // 보안카드 창 입력 RPC는 어느 포트에도 없다
    assert.ok(!Object.values(RPC_BY_PORT).flat().some((m) => m.includes('Card')));
  });
});

async function bareVault() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-rules-'));
  const log = new FileEventLog(null, 'vault');
  const vault = new Vault({ paths: appPaths(root), log, keyStore: new MemoryKeyStore() });
  const f = await fakeRelay();
  vault.ops = f.ops;
  const ctl = new MessageChannel();
  vault.attachPort('control', wrapPort(ctl.port1, 'node'));
  const control = new VaultClient(wrapPort(ctl.port2, 'node'));
  const channels = [ctl];
  const port = (b: unknown) => {
    const ch = new MessageChannel();
    channels.push(ch);
    vault.attachPort('secretInput', wrapPort(ch.port1, 'node'), b);
    return new VaultClient(wrapPort(ch.port2, 'node'));
  };
  const needs = (vault as unknown as { needs: Map<string, number> }).needs;
  const need = (b: { runId: string; kind: string; scope: string }, ttlMs = 60_000) => needs.set(`${b.runId}|${b.kind}|${b.scope}`, Date.now() + ttlMs);
  const close = async () => {
    await vault.shutdown();
    for (const c of channels) {
      c.port1.close();
      c.port2.close();
    }
    await fs.rm(root, { recursive: true, force: true });
  };
  return { vault, log, f, control, port, need, needs, close };
}

describe('1회용 비밀 창은 금고가 부른 것만(ADR-025 결정 10)', () => {
  const bind: SecretInputBind = { runId: 'r1', kind: 'portal_password', scope: 'business' };

  it('secret.needed 없이 열린 1회용 포트는 붙이지 않는다(vault.secret_input_unrequested)', async () => {
    const b = await bareVault();
    try {
      assert.equal(await noAnswer(b.port(bind).rpc('secret.provide', { bytes: enc('TEST-PW-unreq001') })), 'silent');
      assert.equal(count(b.log, 'vault.secret_input_unrequested'), 1);
      assert.equal(b.f.ops.secrets.size, 0);
      // 다른 run·scope·종류의 요청으로는 열리지 않는다
      b.need({ ...bind, runId: 'r2' });
      b.need({ ...bind, scope: 'personal' });
      b.need({ runId: 'r1', kind: 'cert_password', scope: 'business' });
      assert.equal(await noAnswer(b.port(bind).rpc('secret.provide', { bytes: enc('TEST-PW-unreq002') })), 'silent');
      assert.equal(count(b.log, 'vault.secret_input_unrequested'), 2);
      assert.ok(!b.log.lines.some((l) => l.includes('TEST-PW')));
    } finally {
      await b.close();
    }
  });

  it('저장(store) 결속 포트는 secret.needed가 없어도 붙는다(설정 화면의 등록)', async () => {
    const b = await bareVault();
    try {
      // 붙었으면 답이 온다(여기서는 금고가 잠겨 있어 vault_locked).
      await assert.rejects(
        b.port({ mode: 'store', kind: 'portal_password', scope: 'business', notice: { version: 'v1' } }).rpc('secret.store', { entries: [{ field: 'pw', bytes: enc('TEST-PW-store001') }] }),
        /vault_locked/,
      );
      assert.equal(count(b.log, 'vault.secret_input_unrequested'), 0);
    } finally {
      await b.close();
    }
  });

  it('요청 한 번에 값 한 번: provide 뒤 같은 결속의 새 포트는 붙지 않는다', async () => {
    const b = await bareVault();
    try {
      b.need(bind);
      await b.port(bind).rpc('secret.provide', { bytes: enc('TEST-PW-once0001') });
      assert.equal(b.f.ops.secrets.size, 1);
      assert.equal(b.needs.size, 0, '요청 기록을 지웠다');
      assert.equal(await noAnswer(b.port(bind).rpc('secret.provide', { bytes: enc('TEST-PW-once0002') })), 'silent');
      assert.equal(b.f.ops.secrets.size, 1);
      assert.equal(count(b.log, 'vault.secret_input_unrequested'), 1);
    } finally {
      await b.close();
    }
  });

  it('run.end는 그 run의 요청 기록만 지운다', async () => {
    const b = await bareVault();
    try {
      b.need(bind);
      b.need({ ...bind, runId: 'r10' });
      await b.control.rpc('run.end', { runId: 'r1' });
      assert.deepEqual([...b.needs.keys()], ['r10|portal_password|business'], 'r1로 시작하는 다른 run은 남는다');
      assert.equal(await noAnswer(b.port(bind).rpc('secret.provide', { bytes: enc('TEST-PW-ended001') })), 'silent');
    } finally {
      await b.close();
    }
  });

  it('만료된 요청으로는 열리지 않는다', async () => {
    const b = await bareVault();
    try {
      b.need(bind, -1);
      assert.equal(await noAnswer(b.port(bind).rpc('secret.provide', { bytes: enc('TEST-PW-expir001') })), 'silent');
      assert.equal(b.needs.size, 0, '만료 기록은 지웠다');
    } finally {
      await b.close();
    }
  });

  it('창이 열린 뒤 요청이 사라지면(run.end) provide는 not_requested, 값은 받지 않는다', async () => {
    const b = await bareVault();
    try {
      b.need(bind);
      const port = b.port(bind);
      await b.control.rpc('run.end', { runId: 'r1' });
      const bytes = enc('TEST-PW-late0001');
      await assert.rejects(port.rpc('secret.provide', { bytes }), /not_requested/);
      assert.equal(b.f.ops.secrets.size, 0);
    } finally {
      await b.close();
    }
  });

  it('타이피스트가 값이 없어 보낸 secret.needed가 그 결속을 연다(1회용 → 입력)', async () => {
    const b = await bareVault();
    try {
      // Chrome 없이: ops의 emit을 금고 emit 경로(attachRelay)처럼 needs 기록으로 잇는다.
      const rec = (b.vault as unknown as { recordNeed(n: unknown): void }).recordNeed.bind(b.vault);
      const ops = b.f.ops as unknown as { emit: (to: unknown, name: string, data: Record<string, unknown>) => void };
      const orig = ops.emit;
      ops.emit = (to, name, data) => {
        if (name === 'secret.needed') rec(data);
        orig(to, name, data);
      };
      assert.deepEqual(await b.f.ops.fill(req()), { ok: false, reason: 'secret_missing' });
      assert.deepEqual(b.f.events.find((e) => e.name === 'secret.needed')?.data, { runId: 'r1', targetId: 'RUN', kind: 'portal_password', scope: 'business' });
      await b.port(bind).rpc('secret.provide', { bytes: enc('TEST-PW-flow0001') });
      await tick();
      assert.deepEqual(await b.f.ops.fill(req()), { ok: true });
      assert.equal(b.f.page.value, 'TEST-PW-flow0001');
    } finally {
      await b.close();
    }
  });
});
