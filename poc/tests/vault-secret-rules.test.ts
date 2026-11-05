// 비밀 종류별 입력 규칙과 1회용 비밀 창 결속(ADR-020 결정 2, ADR-025 결정 10, D05 §3.5·§4).
// - 타이피스트는 포털 비밀번호·보안카드만 넣는다. 인증서 비밀번호는 정책이 호스트를 허용해도 넣지 않는다.
// - 보안카드는 칸 하나씩, 화면에 보인 칸 번호가 요청 칸과 같을 때만 넣는다.
// - 1회용 입력 창(secretInput oneshot)은 금고가 secret.needed로 부른 것만 붙는다.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { VaultClient } from '@sax/engine';
import { appPaths, FileEventLog, wrapPort } from '@sax/platform';
import { MemoryKeyStore, parseCardRow, Vault, type FillRequest, type SecretInputBind } from '@sax/vault';
import { fakeRelay, tick } from './fake-relay.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noAnswer = <T>(p: Promise<T>, ms = 200) => Promise.race([p.then(() => 'answered', () => 'answered'), sleep(ms).then(() => 'silent')]);

const req = (over: Partial<FillRequest> = {}): FillRequest => ({
  runId: 'r1', targetId: 'RUN', frame: 'main', element: '#pw',
  secret: { kind: 'portal_password', scope: 'business' }, slot: { secretKind: 'portal_password', purpose: 'login' }, ...over,
});
const card = (row: number, rowLabel: string | undefined = '#row') =>
  req({ secret: { kind: 'security_card', scope: 'business', row }, slot: { secretKind: 'security_card', purpose: 'sign' }, rowLabel });
const count = (log: FileEventLog, ev: string) => log.lines.filter((l) => l.includes(`"${ev}"`)).length;

describe('타이피스트 종류 규칙(ADR-020 결정 2·ADR-025 결정 10)', () => {
  it('인증서 비밀번호는 정책이 호스트를 허용하고 1회용 값이 있어도 넣지 않는다', async () => {
    const f = await fakeRelay({ policy: { secretHosts: { cert_password: ['127.0.0.1'], portal_password: ['127.0.0.1'], security_card: ['127.0.0.1'] } } });
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

  it('보안카드는 row 필수(1~35), 포털 비밀번호는 row가 없다', async () => {
    const f = await fakeRelay();
    f.page.rowLabel = '3';
    for (const row of [undefined, 0, 36, 1.5]) {
      assert.deepEqual(await f.ops.fill(req({ secret: { kind: 'security_card', scope: 'business', row } as never, slot: { secretKind: 'security_card', purpose: 'sign' }, rowLabel: '#row' })), { ok: false, reason: 'denied' }, String(row));
    }
    assert.deepEqual(await f.ops.fill(req({ secret: { kind: 'portal_password', scope: 'business', row: 3 } })), { ok: false, reason: 'denied' });
    assert.ok(!f.events.some((e) => e.name === 'secret.needed'));
  });
});

describe('보안카드 칸 번호 확인(D05 §4)', () => {
  const provided = async (label: string | null) => {
    const f = await fakeRelay();
    f.page.rowLabel = label;
    f.ops.secrets.provide({ runId: 'r1', kind: 'security_card', scope: 'business', row: 12 }, enc('1011'));
    return f;
  };

  it('화면 칸 번호가 요청 칸과 같으면 넣는다(괄호·전각·"번" 허용)', async () => {
    for (const label of ['12', ' [12] ', '１２', '12번', 'No.12']) {
      const f = await provided(label);
      assert.deepEqual(await f.ops.fill(card(12)), { ok: true }, label);
      assert.equal(f.page.value, '1011');
    }
  });

  it('칸 번호가 다르거나 읽을 수 없으면 row_mismatch, 값을 꺼내지도 창을 부르지도 않는다', async () => {
    const cases: Array<[string | null, string | undefined, boolean]> = [
      // readable: 칸 번호를 하나로 읽었나(로그에는 이것만 남는다)
      ['13', '#row', true], // 다른 칸
      ['12번 앞 2자리', '#row', false], // 숫자 둘
      ['', '#row', false], // 숫자 없음
      [null, '#row', false], // 요소 없음
      ['12', undefined, false], // 셀렉터 없음
      ['12', '', false],
      ['12', 'x'.repeat(257), false], // 셀렉터 너무 김
      ['1'.repeat(65), '#row', false], // 글자 너무 김
    ];
    for (const [label, sel, readable] of cases) {
      const f = await provided(label);
      const r = sel === undefined ? { ...card(12), rowLabel: undefined } : card(12, sel);
      assert.deepEqual(await f.ops.fill(r), { ok: false, reason: 'row_mismatch' }, `${label}/${sel?.length}`);
      assert.equal(f.page.value, '');
      assert.equal(f.ops.secrets.size, 1, '값은 남아 있다(꺼내지 않음)');
      assert.ok(!f.events.some((e) => e.name === 'secret.needed'));
      const line = f.log.lines.find((l) => l.includes('vault.card_row_mismatch'));
      assert.ok(line);
      assert.ok(line.includes(`"readable":${readable}`), line);
      assert.ok(!line.includes('1011') && !line.includes('"12"'), '로그에 값·칸 번호가 없다');
    }
  });

  it('칸 번호는 금고의 격리 세계에서 셀렉터 문자열로만 읽는다(식 주입 불가)', async () => {
    const f = await provided('12');
    const sel = `#row'); alert(1); ('`;
    await f.ops.fill(card(12, sel));
    const ev = f.conn.sent.find((m) => m.method === 'Runtime.evaluate' && String(m.params.expression).includes('textContent'));
    assert.ok(ev);
    const p = ev.params as { expression: string; contextId: number; returnByValue: boolean };
    assert.ok(p.expression.includes(JSON.stringify(sel)), '셀렉터는 JSON 문자열로 들어간다');
    assert.equal(p.returnByValue, true);
    assert.equal(p.contextId, 1, '격리 세계에서');
    assert.equal(ev.sessionId, 'V-RUN', '금고 세션에서');
  });

  it('parseCardRow', () => {
    const ok: Array<[unknown, number]> = [['1', 1], ['35', 35], ['07', 7], ['３５', 35], ['[ 3 ]', 3], ['제 12 번', 12]];
    for (const [t, n] of ok) assert.equal(parseCardRow(t), n, String(t));
    for (const t of ['0', '36', '', 'abc', '1 2', '12-13', '1'.repeat(65), 12, null, undefined, {}]) assert.equal(parseCardRow(t), null, String(t));
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
  const need = (b: { runId: string; kind: string; scope: string; row?: number }, ttlMs = 60_000) => needs.set(`${b.runId}|${b.kind}|${b.scope}|${b.row ?? ''}`, Date.now() + ttlMs);
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
      // 다른 run·scope·row의 요청으로는 열리지 않는다
      b.need({ ...bind, runId: 'r2' });
      b.need({ ...bind, scope: 'personal' });
      b.need({ runId: 'r1', kind: 'security_card', scope: 'business', row: 4 });
      for (const other of [bind, { runId: 'r1', kind: 'security_card', scope: 'business', row: 5 }]) {
        assert.equal(await noAnswer(b.port(other).rpc('secret.provide', { bytes: enc('1234') })), 'silent');
      }
      assert.equal(count(b.log, 'vault.secret_input_unrequested'), 3);
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
      assert.deepEqual([...b.needs.keys()], ['r10|portal_password|business|'], 'r1로 시작하는 다른 run은 남는다');
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
