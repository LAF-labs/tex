// 감사 D 금고 패키지(V1~V14) 회귀 시험. 가짜 CDP 연결로 결정적인 것은 여기서, 실 Chrome이 필요한 것은 harness로 본다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import * as engine from '@sax/engine';
import { connectRunBrowser, VaultClient, warmForSecretWindow } from '@sax/engine';
import { appPaths, FileEventLog, wrapPort } from '@sax/platform';
import {
  buildChromeArgs,
  checkSessionCommand,
  knownValueVariants,
  MemoryKeyStore,
  OneShotSecrets,
  Relay,
  removeCrashDumps,
  SECRET_ORIGINS,
  SecretOps,
  stripAuthHeaders,
  Vault,
  type FillRequest,
  type SecretInputBind,
} from '@sax/vault';
import { startFixture } from './fixtures/server.ts';
import { startHarness, testPolicy } from './harness.ts';
import { RawEngine, sleep } from './raw-engine.ts';

type Json = Record<string, unknown>;
type Handler = (params: Json, sessionId?: string) => Json | Promise<Json>;

// 실 Chrome 화면 확인 식(I-4). 엔진 SIGNAL_INSPECT_EXPR와 글자 하나까지 같다(해시 고정).
const INSPECT_EXPR = "(() => ({ text: document.body ? document.body.innerText : '', status: ((performance.getEntriesByType('navigation')[0] || {}).responseStatus) || 0 }))()";

class FakeConn extends EventEmitter {
  private nextId = 1;
  readonly sent: Array<{ method: string; params: Json; sessionId?: string }> = [];
  readonly handlers = new Map<string, Handler>();
  send<T = Json>(method: string, params: Json = {}, sessionId?: string): Promise<T> {
    this.sent.push({ method, params, sessionId });
    const h = this.handlers.get(method);
    return Promise.resolve(h ? h(params, sessionId) : {}) as Promise<T>;
  }
  allocId(): number {
    return this.nextId++;
  }
  sendRaw(): void {}
  emitEvent(method: string, params: Json, sessionId?: string): void {
    const m: Json = { method, params };
    if (sessionId) m.sessionId = sessionId;
    this.emit('message', m);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 10));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

interface FakePage {
  type: string;
  active: boolean;
  connected: boolean;
  len: number;
  value: string;
  /** 보안카드 칸 번호 요소의 글자(rowLabel 셀렉터로 금고가 읽는다). */
  rowLabel?: string | null;
  /** 있으면 insertText가 이것을 기다린다(입력 도중 상태 재현). */
  gate?: Promise<void>;
}

/** 실행 page(RUN)를 노출하고 엔진 세션(E-1)까지 붙인 Relay + 가짜 password 칸 하나. */
async function setup(opts: { leak?: (hits: number) => void; now?: () => number } = {}) {
  const conn = new FakeConn();
  const toEngine: Json[] = [];
  const log = new FileEventLog(null, 'vault');
  const policy = testPolicy({ keyDelayMs: 0 });
  const relay = new Relay({ conn: conn as never, policy, log, toEngine: (raw) => toEngine.push(JSON.parse(raw) as Json), onLeakSuspected: opts.leak });
  let sessions = 0;
  conn.handlers.set('Browser.getVersion', () => ({ product: 'Chrome/156' }));
  conn.handlers.set('Target.createTarget', () => {
    setTimeout(() => conn.emitEvent('Target.attachedToTarget', { sessionId: 'V-RUN', targetInfo: { targetId: 'RUN', type: 'page', url: 'about:blank' }, waitingForDebugger: true }), 0);
    return { targetId: 'RUN' };
  });
  conn.handlers.set('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'RUN', url: 'http://127.0.0.1:1/login' } } }));
  conn.handlers.set('Target.attachToTarget', () => ({ sessionId: `E-${++sessions}` }));
  conn.handlers.set('Target.getTargetInfo', (p) => ({ targetInfo: { targetId: p.targetId, type: 'page', url: '' } }));
  const page: FakePage = { type: 'password', active: true, connected: true, len: 0, value: '' };
  conn.handlers.set('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
  conn.handlers.set('Runtime.evaluate', (p) => (p.returnByValue && String(p.expression).includes('textContent') ? { result: { value: page.rowLabel ?? null } } : { result: { objectId: 'OBJ' } }));
  conn.handlers.set('DOM.describeNode', () => ({ node: { backendNodeId: 7 } }));
  conn.handlers.set('Runtime.callFunctionOn', (p) =>
    String(p.functionDeclaration).includes('return typeof this.value')
      ? { result: { value: page.value } }
      : { result: { value: { type: page.type, active: page.active, connected: page.connected, len: page.len } } },
  );
  conn.handlers.set('Input.insertText', async (p) => {
    if (page.gate) await page.gate;
    page.value += String(p.text);
    page.len = [...page.value].length;
    return {};
  });
  await relay.init();
  await relay.createRunPage();
  relay.onEngineMessage(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } }));
  await tick();
  const events: Array<{ to: readonly string[]; name: string; data: Json }> = [];
  const ops = new SecretOps(relay, policy, log, { emit: (to, name, data) => events.push({ to, name, data }), now: opts.now });
  ops.openBlocker = async () => null;
  ops.runTriggers.set('r1', 'local');
  const t = relay.targets.get('RUN')!;
  return { conn, relay, log, toEngine, page, ops, events, t };
}

const fillReq = (over: Partial<FillRequest> = {}): FillRequest => ({
  runId: 'r1',
  targetId: 'RUN',
  frame: 'main',
  element: '#pw',
  secret: { kind: 'portal_password', scope: 'business' },
  slot: { secretKind: 'portal_password', purpose: 'login' },
  ...over,
});
const bind = (over: Partial<SecretInputBind> = {}): SecretInputBind => ({ runId: 'r1', kind: 'portal_password', scope: 'business', ...over });
/** 금고가 secret.needed를 보낸 것처럼(포트 시험은 Chrome 없이 ops를 직접 꽂으므로 요청 기록을 넣어 둔다). */
const need = (v: Vault, b: Record<string, unknown>, ttlMs = 60_000) =>
  (v as unknown as { needs: Map<string, number> }).needs.set(`${b.runId}|${b.kind}|${b.scope}|${b.row ?? ''}`, Date.now() + ttlMs);
const card = (row: number, label: string | undefined = '#row') =>
  fillReq({ secret: { kind: 'security_card', scope: 'business', row }, slot: { secretKind: 'security_card', purpose: 'sign' }, rowLabel: label });
const enc = (s: string) => new TextEncoder().encode(s);

/** 크롬 없이 쓰는 금고(포트 시험). paths는 임시 루트. */
async function bareVault(opts: { keyStore?: MemoryKeyStore } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-auditv-'));
  const paths = appPaths(root);
  const log = new FileEventLog(null, 'vault');
  const keyStore = opts.keyStore ?? new MemoryKeyStore();
  const vault = new Vault({ paths, log, keyStore });
  const ctl = new MessageChannel();
  vault.attachPort('control', wrapPort(ctl.port1, 'node'));
  const control = new VaultClient(wrapPort(ctl.port2, 'node'));
  const channels = [ctl];
  const secretPort = (b?: unknown) => {
    const ch = new MessageChannel();
    channels.push(ch);
    vault.attachPort('secretInput', wrapPort(ch.port1, 'node'), b);
    return new VaultClient(wrapPort(ch.port2, 'node'));
  };
  return {
    root,
    paths,
    log,
    keyStore,
    vault,
    control,
    secretPort,
    async close() {
      await vault.shutdown();
      for (const c of channels) {
        c.port1.close();
        c.port2.close();
      }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

const noAnswer = <T>(p: Promise<T>, ms = 300) => Promise.race([p.then(() => 'answered', () => 'answered'), sleep(ms).then(() => 'silent')]);

// ───────────────────────── V1 · N-04 ─────────────────────────
describe('audit-v V1 Crashpad', () => {
  it('audit-v: buildChromeArgs always carries --disable-breakpad', () => {
    for (const extra of [[], ['--headless=new']]) {
      const args = buildChromeArgs('/p', extra);
      assert.deepEqual(args.slice(0, 5), ['--remote-debugging-pipe', '--user-data-dir=/p', '--no-first-run', '--disable-breakpad', '--disable-default-apps']);
    }
  });

  it('audit-v: removeCrashDumps deletes Crashpad tree and refuses a symlinked Crashpad', async () => {
    const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-crash-'));
    try {
      const profile = path.join(base, 'profile');
      await fs.mkdir(path.join(profile, 'Crashpad', 'reports'), { recursive: true });
      await fs.writeFile(path.join(profile, 'Crashpad', 'reports', 'a.dmp'), 'x');
      await fs.writeFile(path.join(profile, 'Crashpad', 'settings.dat'), 'x');
      assert.equal(await removeCrashDumps(profile), 2);
      await assert.rejects(fs.lstat(path.join(profile, 'Crashpad')), /ENOENT/);
      assert.equal(await removeCrashDumps(profile), 0, '없으면 0');
      // 링크 너머(밖 폴더)는 지우지 않는다
      const outside = path.join(base, 'outside');
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, 'keep'), 'x');
      await fs.symlink(outside, path.join(profile, 'Crashpad'), process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(await removeCrashDumps(profile), -1);
      assert.deepEqual(await fs.readdir(outside), ['keep']);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── V2 · N-18 ─────────────────────────
describe('audit-v V2 비밀 창 개시 조건 재검사', () => {
  it('audit-v: profileBlocker re-reads files each call', async () => {
    const b = await bareVault();
    try {
      const v = b.vault as unknown as { profileProblems: string[] | null; profileBlocker(): Promise<string | null> };
      assert.equal(await v.profileBlocker(), 'profile_not_checked', '첫 점검 전');
      const prefs = path.join(b.paths.chromeProfile, 'Default', 'Preferences');
      await fs.mkdir(path.dirname(prefs), { recursive: true });
      const ok = { credentials_enable_service: false, profile: { password_manager_enabled: false }, autofill: { profile_enabled: false, credit_card_enabled: false } };
      await fs.writeFile(prefs, JSON.stringify(ok));
      await fs.writeFile(path.join(b.paths.chromeProfile, 'Local State'), JSON.stringify({ user_experience_metrics: { reporting_enabled: false } }));
      v.profileProblems = []; // 기동 1.5초 뒤 점검 통과
      assert.equal(await v.profileBlocker(), null);
      await fs.writeFile(prefs, JSON.stringify({ ...ok, account_info: [{ gaia: 'x' }] }));
      assert.equal(await v.profileBlocker(), 'google_signin_detected', '세션 중 Google 로그인');
      await fs.writeFile(prefs, JSON.stringify({ ...ok, extensions: { settings: { abcdefghijklmnop: { location: 1 } } } }));
      assert.equal(await v.profileBlocker(), 'extension_not_allowed', '세션 중 확장 설치');
      // 진단 이벤트에는 확장 ID만 남는다. ID 꼴이 아닌 키(경로 등)는 'unknown'으로 바뀐다(팀장 결정 2026-11-06).
      const wallet = 'nmmhkkegccagdldgiimedpiccmgmieda';
      await fs.writeFile(prefs, JSON.stringify({ ...ok, extensions: { settings: { [wallet]: { location: 1, path: '/Users/x/secret-ext', manifest: { name: 'Store' } }, 'C:\\Users\\x\\ext': { location: 4 } } } }));
      assert.equal(await v.profileBlocker(), 'extension_not_allowed', '기본 앱');
      const ev = b.log.lines.filter((l) => l.includes('"vault.extension_not_allowed"')).at(-1)!;
      const e = JSON.parse(ev) as Record<string, unknown>;
      assert.equal(e.count, 2);
      assert.deepEqual([e.ext0, e.ext1].sort(), ['unknown', wallet].sort());
      assert.ok(!/secret-ext|Store|Users/.test(ev), ev);
      await fs.writeFile(prefs, JSON.stringify({ ...ok, credentials_enable_service: true }));
      assert.equal(await v.profileBlocker(), 'profile_prefs_mismatch');
    } finally {
      await b.close();
    }
  });

  it('audit-v: refusal goes to engine and control as secret_window.refused', async () => {
    const s = await setup();
    s.ops.openBlocker = async () => 'google_signin_detected';
    assert.deepEqual(await s.ops.openForHuman({ runId: 'r1', targetId: 'RUN', frame: 'main', element: '#pw' }), { ok: false, reason: 'secret_window_refused' });
    assert.deepEqual(s.events, [{ to: ['engine', 'control'], name: 'secret_window.refused', data: { reason: 'google_signin_detected' } }]);
  });
});

// ───────────────────────── V3 · N-20 ─────────────────────────
describe('audit-v V3 고정 화면 확인 식', () => {
  const policy = testPolicy();
  const tainted = { active: false, tainted: true };
  const viaPlaywright = (expr: string) => ({ functionDeclaration: '(utilityScript, ...args) => utilityScript.evaluate(...args)', arguments: [{ objectId: 'u' }, { value: false }, { value: true }, { value: expr }, { value: 0 }] });

  it('audit-v: tainted state lets the exact inspect expression through', () => {
    assert.deepEqual(checkSessionCommand('Runtime.evaluate', { expression: INSPECT_EXPR }, tainted, policy, new Set()), { ok: true });
    assert.deepEqual(checkSessionCommand('Runtime.evaluate', { expression: `  (${INSPECT_EXPR})  ` }, tainted, policy, new Set()), { ok: true }, '바깥 괄호 한 쌍');
    assert.deepEqual(checkSessionCommand('Runtime.callFunctionOn', viaPlaywright(INSPECT_EXPR), tainted, policy, new Set()), { ok: true }, 'Playwright 문자열 인자');
    // 같은 뜻이어도 글자가 다르면 면제하지 않는다
    assert.equal(checkSessionCommand('Runtime.evaluate', { expression: INSPECT_EXPR.replace('innerText', 'innerText ') }, tainted, policy, new Set()).ok, false);
  });

  it('audit-v: inspect expression plus ".value" read is still denied', () => {
    const plus = `${INSPECT_EXPR}; document.querySelector('#pw').value`;
    assert.deepEqual(checkSessionCommand('Runtime.evaluate', { expression: plus }, tainted, policy, new Set()), { ok: false, reason: 'secret_window_tainted' });
    const split = viaPlaywright(INSPECT_EXPR);
    split.arguments.push({ value: "document.querySelector('#pw').value" });
    assert.deepEqual(checkSessionCommand('Runtime.callFunctionOn', split, tainted, policy, new Set()), { ok: false, reason: 'secret_window_tainted' }, '면제 조각 옆의 다른 조각은 그대로 본다');
  });

  it('audit-v: active window still denies the inspect expression', () => {
    assert.deepEqual(checkSessionCommand('Runtime.evaluate', { expression: INSPECT_EXPR }, { active: true, tainted: true }, policy, new Set()), { ok: false, reason: 'secret_window_active' });
  });

  it('audit-v: SignalWatch.inspect reads body text through relay in tainted state', { timeout: 60_000 }, async () => {
    const fx = await startFixture();
    const h = await startHarness();
    try {
      const { browser, page, targetId } = await connectRunBrowser(h.client);
      await h.vault.profileChecked();
      await h.control.rpc('run.begin', { runId: 'v3', trigger: 'local' });
      await page.goto(`${fx.origin}/login`);
      await warmForSecretWindow(page);
      const opened = await h.client.rpc('secretWindow.openForHuman', { runId: 'v3', targetId, frame: 'main', element: '#pw' });
      // Linux CI에서 드물게 secret_window_refused(#108·#112). 거절 사유는 금고 로그에만 있어 실패 메시지에 싣는다(흔들림 추적).
      const refused = async () => (await Promise.all((await fs.readdir(h.paths.logs).catch(() => [])).map((f) => fs.readFile(path.join(h.paths.logs, f), 'utf8').catch(() => '')))).join('\n').split('\n').filter((l) => /secret_window_refused|profile_prefs_mismatch|extension_not_allowed|google_signin_detected/.test(l)).join('\n');
      assert.deepEqual(opened, { ok: true }, (opened as { ok: boolean }).ok ? undefined : `금고 로그:\n${await refused()}`);
      const vt = h.vault.relay!.targets.get(targetId)!;
      const closed = h.client.once('secret_window.closed', (d) => d.targetId === targetId, 5000);
      await h.vault.relay!.send('Runtime.evaluate', { expression: `document.getElementById('pw').focus()` }, vt.vaultSession);
      await h.vault.relay!.send('Input.insertText', { text: 'TEST-CERT-v3inspect' }, vt.vaultSession);
      await h.vault.relay!.send('Runtime.evaluate', { expression: `document.activeElement.blur()` }, vt.vaultSession);
      await closed;
      assert.equal(vt.win?.phase, 'tainted');
      // 고정 식(문자열)은 통과, 같은 일을 하는 함수 식은 여전히 거부
      const seen = (await page.mainFrame().evaluate(INSPECT_EXPR)) as { text: string; status: number };
      assert.match(seen.text, /로그인/);
      assert.equal(seen.status, 200);
      await assert.rejects(page.evaluate(() => document.body.innerText)); // Playwright는 중계 거부를 문맥 소멸 오류로 바꿔 알린다
      // 엔진 쪽(E 패키지) SignalWatch가 같은 식을 쓰는지
      assert.equal(engine.SIGNAL_INSPECT_EXPR, INSPECT_EXPR);
      const hits: string[] = [];
      const watch = new engine.SignalWatch(page, { dict: [{ id: 'audit.v3', kind: 'busy', text: '로그인', source: 'audit-v' }], portalHost: () => true, onHit: (x) => hits.push(x.id), onDialog: (d) => void d.dismiss(), mono: () => 0 });
      await watch.inspect(page);
      assert.ok(hits.includes('audit.v3'), '오염 상태에서도 본문 문구 신호를 본다');
      await browser.close().catch(() => {});
    } finally {
      await h.close();
      await fx.close();
    }
  });
});

// ───────────────────────── V4 · N-17 ─────────────────────────
describe('audit-v V4 누출 트립와이어·자기 스캔', () => {
  it('audit-v: known-value scrub hit emits secret_window.leak_suspected once per window', async () => {
    const leaks: number[] = [];
    const s = await setup({ leak: (n) => leaks.push(n) });
    const secret = 'TEST-CERT-leakwire01';
    s.relay.openWindow(s.t, 'typist', 'RUN', 7);
    s.relay.addKnownSecret('RUN', knownValueVariants(secret));
    s.relay.deactivateWindow(s.t);
    for (let i = 0; i < 2; i++) s.conn.emitEvent('Log.entryAdded', { entry: { text: `x ${secret} y` } }, 'E-1');
    await tick();
    assert.deepEqual(leaks, [1], '창마다 1회');
    assert.ok(s.toEngine.every((m) => !JSON.stringify(m).includes(secret)));
    // 창이 끝나면(문서 커밋) 다음 창에서 다시 알린다
    s.conn.emitEvent('Page.frameNavigated', { frame: { id: 'RUN', url: 'http://127.0.0.1:1/next' } }, 'V-RUN');
    s.relay.openWindow(s.t, 'typist', 'RUN', 7);
    s.relay.addKnownSecret('RUN', knownValueVariants(secret));
    s.conn.emitEvent('Log.entryAdded', { entry: { text: secret } }, 'E-1');
    await tick();
    assert.deepEqual(leaks, [1, 1]);
  });

  it('audit-v: self-scan finds a planted variant in logs', async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-selfscan-'));
    try {
      const secret = 'TEST-CERT-selfscan01';
      const logs = path.join(root, 'logs');
      const staging = path.join(root, 'staging');
      await fs.mkdir(logs);
      await fs.mkdir(staging);
      await fs.writeFile(path.join(logs, 'engine.log'), `{"x":"${Buffer.from(secret).toString('base64')}"}\n`);
      const s = await setup();
      const ops = new SecretOps(s.relay, testPolicy({ keyDelayMs: 0 }), s.log, { selfScan: { roots: [logs, staging] }, emit: (to, name, data) => s.events.push({ to, name, data }) });
      ops.openBlocker = async () => null;
      ops.runTriggers.set('r1', 'local');
      ops.secrets.provide(bind(), enc(secret));
      assert.deepEqual(await ops.fill(fillReq()), { ok: true });
      await ops.selfScanDone;
      const scan = s.log.lines.map((l) => JSON.parse(l) as Json).find((e) => e.code === 'vault.leak_scan');
      assert.ok(Number(scan?.findings) >= 1, '심어 둔 base64 변형을 찾았다');
      assert.equal(scan?.files, 1);
      const leak = s.events.filter((e) => e.name === 'secret_window.leak_suspected');
      assert.equal(leak.length, 1);
      assert.deepEqual(leak[0]!.to, ['engine', 'control']);
      assert.equal(leak[0]!.data.hits, scan?.findings);
      assert.ok(!s.log.lines.join('\n').includes(secret), '로그에는 건수만');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── V5 · N-44 ─────────────────────────
describe('audit-v V5 비밀 입력 포트 결속·TTL·secret.needed', () => {
  it('audit-v: secretInput port without bind is ignored', async () => {
    const b = await bareVault();
    try {
      const bads = [
        undefined, {}, bind({ runId: 'bad id!' }), bind({ scope: 'p1' as never }),
        bind({ kind: 'security_card', row: 0 }), bind({ kind: 'security_card', row: 36 }), bind({ kind: 'security_card', row: 1.5 }),
        // 종류별 규칙: 인증서 비밀번호는 1회용 창으로도 받지 않는다, 보안카드는 row 필수, 포털 비밀번호는 row 없음
        bind({ kind: 'cert_password' }), bind({ kind: 'security_card' }), bind({ row: 3 }),
      ];
      for (const bad of bads) {
        if (bad) need(b.vault, bad as Record<string, unknown>);
        const port = b.secretPort(bad);
        assert.equal(await noAnswer(port.rpc('secret.provide', { bytes: enc('TEST-CERT-unbound') })), 'silent');
      }
      assert.equal(b.log.lines.filter((l) => l.includes('vault.secret_input_unbound')).length, bads.length);
    } finally {
      await b.close();
    }
  });

  it('audit-v: bound port accepts exactly one provide', async () => {
    const b = await bareVault();
    const s = await setup();
    try {
      b.vault.ops = s.ops;
      need(b.vault, bind({ kind: 'security_card', row: 12 }));
      const port = b.secretPort(bind({ kind: 'security_card', row: 12 }));
      assert.deepEqual(await port.rpc('secret.provide', { bytes: enc('42') }), {});
      const second = enc('43');
      await assert.rejects(port.rpc('secret.provide', { bytes: second }), /denied/);
      assert.equal(s.ops.secrets.size, 1);
      assert.deepEqual([...(s.ops.secrets.take('r1', 'security_card', 'business', 12) ?? [])], [...enc('42')], '결속 값(kind·scope·row)으로 저장');
    } finally {
      await b.close();
    }
  });

  it('audit-v: provide with kind outside SECRET_ORIGINS is rejected', async () => {
    const b = await bareVault();
    const s = await setup();
    try {
      b.vault.ops = s.ops;
      need(b.vault, bind());
      assert.equal(await noAnswer(b.secretPort(bind({ kind: 'evil' as never })).rpc('secret.provide', { bytes: enc('TEST-CERT-evil1') })), 'silent');
      assert.equal(await noAnswer(b.secretPort(bind({ kind: 'toString' as never })).rpc('secret.provide', { bytes: enc('TEST-CERT-evil2') })), 'silent');
      const bytes = enc('TEST-CERT-mismatch');
      await assert.rejects(b.secretPort(bind()).rpc('secret.provide', { kind: 'evil', bytes }), /bind_mismatch/);
      await assert.rejects(b.secretPort(bind()).rpc('secret.provide', { scope: 'personal', bytes }), /bind_mismatch/);
      assert.equal(s.ops.secrets.size, 0);
    } finally {
      await b.close();
    }
  });

  it('audit-v: one-shot secret expires after TTL, is zeroed and emits secret.expired', async () => {
    const s = await setup();
    const ops = new SecretOps(s.relay, testPolicy(), s.log, { secretTtlMs: 50, emit: (to, name, data) => s.events.push({ to, name, data }) });
    const bytes = enc('TEST-CERT-ttl00001');
    ops.secrets.provide(bind(), bytes);
    await sleep(120);
    assert.equal(ops.secrets.size, 0);
    assert.ok(bytes.every((x) => x === 0), '0으로 덮었다');
    assert.deepEqual(s.events, [{ to: ['control'], name: 'secret.expired', data: { runId: 'r1', kind: 'portal_password' } }]);
    // 쓰기 전에 꺼내면 타이머가 풀린다
    const kept = new OneShotSecrets(50, () => assert.fail('expired after take'));
    kept.provide(bind(), enc('TEST-CERT-ttl00002'));
    assert.ok(kept.take('r1', 'portal_password', 'business'));
    await sleep(100);
  });

  it('audit-v: run.end clears that run\'s secrets only', async () => {
    const b = await bareVault();
    const s = await setup();
    try {
      b.vault.ops = s.ops;
      need(b.vault, bind({ runId: 'r1' }));
      need(b.vault, bind({ runId: 'r2' }));
      await b.secretPort(bind({ runId: 'r1' })).rpc('secret.provide', { bytes: enc('TEST-CERT-run1aaaa') });
      await b.secretPort(bind({ runId: 'r2' })).rpc('secret.provide', { bytes: enc('TEST-CERT-run2bbbb') });
      await b.control.rpc('run.end', { runId: 'r1' });
      assert.equal(s.ops.secrets.take('r1', 'portal_password', 'business'), null);
      assert.ok(s.ops.secrets.take('r2', 'portal_password', 'business'), '다른 실행 값은 남는다');
      assert.equal(s.ops.secrets.take('r2', 'portal_password', 'business'), null, '실행이 다르면 꺼내지 못한다(이미 꺼냄)');
    } finally {
      await b.close();
    }
  });

  it('audit-v: fill without secret returns secret_missing and emits secret.needed', async () => {
    const s = await setup();
    s.page.rowLabel = '3';
    assert.deepEqual(await s.ops.fill(card(3)), { ok: false, reason: 'secret_missing' });
    assert.deepEqual(s.events, [{ to: ['control'], name: 'secret.needed', data: { runId: 'r1', targetId: 'RUN', kind: 'security_card', scope: 'business', row: 3 } }]);
    assert.equal(s.t.win, undefined, '창을 열지 않았다');
    // 다른 실행의 값은 쓰지 않는다
    s.ops.secrets.provide(bind({ runId: 'r9' }), enc('TEST-CERT-otherrun'));
    assert.deepEqual(await s.ops.fill(fillReq()), { ok: false, reason: 'secret_missing' });
  });
});

// ───────────────────────── V6 · N-47 ─────────────────────────
describe('audit-v V6 사람 입력 창 정착', () => {
  const human = { runId: 'r1', targetId: 'RUN', frame: 'main', element: '#pw' };

  // 정착 판정은 주입한 시계로 본다(부하에서 타이머가 밀려도 결과가 같다). tick은 250ms 주기 판정을 직접 한 번 부른다.
  const humanTick = (s: Awaited<ReturnType<typeof setup>>) => (s.ops as unknown as { tickHuman(t: unknown): Promise<void> }).tickHuman(s.t);

  it('audit-v: human window survives a 1s blur from a keypad click', async () => {
    let now = 1_000_000;
    const s = await setup({ now: () => now });
    assert.deepEqual(await s.ops.openForHuman(human), { ok: true });
    s.page.value = 'abc';
    s.page.len = 3;
    s.page.active = false; // 가상키패드 클릭으로 blur
    await humanTick(s);
    now += 1000;
    await humanTick(s);
    assert.equal(s.t.win?.phase, 'active', '1초 blur로는 닫히지 않는다');
    s.page.active = true; // 키패드가 포커스를 돌려줌
    now += 300;
    await humanTick(s);
    s.page.active = false;
    await humanTick(s);
    now += 1000;
    await humanTick(s);
    assert.equal(s.t.win?.phase, 'active', '포커스가 돌아오면 다시 센다');
    s.page.len = 4; // 키패드로 한 글자 더
    await humanTick(s);
    now += 1000;
    await humanTick(s);
    assert.equal(s.t.win?.phase, 'active', '길이가 바뀌면 다시 센다');
    now += 499;
    await humanTick(s);
    assert.equal(s.t.win?.phase, 'active', '정착 1499ms');
    now += 1;
    await humanTick(s);
    assert.equal(s.t.win?.phase, 'tainted', '정착 1500ms에 닫힌다');
  });

  it('audit-v: human window closes 1.5s after blur with stable value (주기 타이머 경로)', async () => {
    let now = 1_000_000;
    const s = await setup({ now: () => now });
    assert.deepEqual(await s.ops.openForHuman(human), { ok: true });
    s.page.value = 'TEST-CERT-settle01';
    s.page.len = 18;
    s.page.active = false;
    const watch = () => (s.ops as unknown as { human: Map<string, { idleSince?: number }> }).human.get('RUN');
    // 주기 타이머가 blur를 처음 본 때까지(시계는 멈춰 있다)
    for (let i = 0; i < 200 && watch()?.idleSince === undefined; i++) await sleep(20);
    assert.equal(watch()?.idleSince, now);
    now += 1499;
    await sleep(600); // 주기 판정이 두 번 이상 돈다
    assert.equal(s.t.win?.phase, 'active', '정착 전에는 닫지 않는다');
    now += 1;
    for (let i = 0; i < 200 && s.t.win?.phase === 'active'; i++) await sleep(20);
    assert.equal(s.t.win?.phase, 'tainted', '정착 1500ms 뒤 주기 판정이 닫는다');
  });
});

// ───────────────────────── V7 · N-43 ─────────────────────────
describe('audit-v V7 창 상태 머신', () => {
  it('audit-v: requestClose during typist fill returns ok:false and window stays active', async () => {
    const s = await setup();
    const gate = deferred();
    s.page.gate = gate.promise;
    s.ops.secrets.provide(bind(), enc('TEST-CERT-close001'));
    const filling = s.ops.fill(fillReq());
    for (let i = 0; i < 50 && s.t.win?.phase !== 'active'; i++) await tick();
    assert.equal(s.t.win?.kind, 'typist');
    assert.deepEqual(await s.ops.requestClose({ runId: 'r1', targetId: 'RUN' }), { ok: false });
    assert.equal(s.t.win?.phase, 'active');
    assert.ok(s.log.lines.some((l) => l.includes('vault.secret_window_close_denied')));
    gate.resolve();
    assert.deepEqual(await filling, { ok: true });
  });

  it('audit-v: concurrent fill on the same target — second is denied', async () => {
    const s = await setup();
    s.ops.secrets.provide(bind(), enc('TEST-CERT-conc0001'));
    s.ops.secrets.provide(bind({ kind: 'security_card', row: 1 }), enc('TEST-CERT-conc0002'));
    s.page.rowLabel = '1';
    const [a, b] = await Promise.all([s.ops.fill(fillReq()), s.ops.fill(card(1))]);
    assert.deepEqual(a, { ok: true });
    assert.deepEqual(b, { ok: false, reason: 'denied' });
    assert.equal(s.page.value, 'TEST-CERT-conc0001', '두 비밀이 섞여 입력되지 않는다');
    // 창 개시 중 human 창도 열리지 않는다
    const s2 = await setup();
    const gate = deferred();
    s2.ops.openBlocker = () => gate.promise.then(() => null);
    const first = s2.ops.openForHuman({ runId: 'r1', targetId: 'RUN', frame: 'main', element: '#pw' });
    assert.deepEqual(await s2.ops.openForHuman({ runId: 'r1', targetId: 'RUN', frame: 'main', element: '#pw' }), { ok: false, reason: 'not_found' });
    gate.resolve();
    assert.deepEqual(await first, { ok: true });
    await s2.ops.userDone('RUN');
  });
});

// ───────────────────────── V8 · N-77 ─────────────────────────
describe('audit-v V8 트리거 허용 목록', () => {
  it('audit-v: run.begin rejects an unknown trigger', async () => {
    const b = await bareVault();
    try {
      for (const bad of ['cron', undefined, 'LOCAL', 1]) await assert.rejects(b.control.rpc('run.begin', { runId: 'r1', trigger: bad }), /bad_trigger/);
      assert.equal((b.vault as unknown as { pendingTriggers: Map<string, string> }).pendingTriggers.size, 0, '저장하지 않는다');
      assert.deepEqual(await b.control.rpc('run.begin', { runId: 'r1', trigger: 'local' }), {});
    } finally {
      await b.close();
    }
  });

  it('audit-v: fill denies missing or daemon trigger', async () => {
    const s = await setup();
    s.ops.secrets.provide(bind({ runId: 'r2' }), enc('TEST-CERT-daemon01'));
    s.ops.runTriggers.set('r2', 'daemon');
    assert.deepEqual(await s.ops.fill(fillReq({ runId: 'r2' })), { ok: false, reason: 'denied' });
    assert.deepEqual(await s.ops.fill(fillReq({ runId: 'r3' })), { ok: false, reason: 'denied' }, '트리거 없음');
    assert.deepEqual(await s.ops.openForHuman({ runId: 'r2', targetId: 'RUN', frame: 'main', element: '#pw' }), { ok: false, reason: 'denied' });
    s.ops.runTriggers.set('r2', 'remote');
    // remote 실행은 시작 게이트(SAX-start-v1) 통과 플래그가 있을 때만(ADR-029 결정 2).
    assert.deepEqual(await s.ops.fill(fillReq({ runId: 'r2' })), { ok: false, reason: 'denied' }, 'remote + startGate 없음');
    assert.deepEqual(await s.ops.fill(fillReq({ runId: 'r2', startGate: true })), { ok: true });
  });
});

// ───────────────────────── V9 · N-12 ─────────────────────────
describe('audit-v V9 MHTML·리소스·옛 스냅숏', () => {
  it('audit-v: Page.captureSnapshot / Page.getResourceContent / DOMSnapshot.getSnapshot are denied in every state', () => {
    const policy = testPolicy();
    for (const method of ['Page.captureSnapshot', 'Page.getResourceContent', 'DOMSnapshot.getSnapshot', 'Network.getResponseBody', 'Fetch.getResponseBody', 'Network.getResponseBodyForInterception', 'Network.streamResourceContent']) {
      for (const state of [{ active: false, tainted: false }, { active: false, tainted: true }, { active: true, tainted: true }]) {
        assert.equal(checkSessionCommand(method, {}, state, policy, new Set()).ok, false, `${method} ${JSON.stringify(state)}`);
      }
    }
    assert.equal(checkSessionCommand('DOMSnapshot.captureSnapshot', {}, { active: false, tainted: false }, policy, new Set()).ok, true, '정리되는 captureSnapshot은 그대로');
  });
});

// ───────────────────────── V10 · N-51 ─────────────────────────
describe('audit-v V10 쿠키·인증 헤더', () => {
  it('audit-v: stripAuthHeaders is case-insensitive', () => {
    const h: Json = { 'Set-Cookie': 'a=1', COOKIE: 'b=2', authorization: 'Bearer x', 'Content-Type': 'text/html' };
    assert.equal(stripAuthHeaders(h), 3);
    assert.deepEqual(h, { 'Content-Type': 'text/html' });
    const arr: Json[] = [{ name: 'set-cookie', value: 'a' }, { name: 'X-Ok', value: '1' }, { name: 'Authorization', value: 'b' }];
    assert.equal(stripAuthHeaders(arr), 2);
    assert.deepEqual(arr, [{ name: 'X-Ok', value: '1' }]);
  });

  it('audit-v: Set-Cookie from a login response never reaches the engine', { timeout: 60_000 }, async () => {
    const fx = await startFixture();
    const h = await startHarness();
    try {
      const eng = new RawEngine(h.client);
      await h.client.rpc('browser.launch');
      const { sessionId } = await eng.attachRunPage();
      await eng.navigate(sessionId, `${fx.origin}/session`);
      await eng.navigate(sessionId, `${fx.origin}/redirect?to=/session`);
      await eng.navigate(sessionId, `${fx.origin}/login`); // 다음 요청은 Cookie 헤더를 싣는다
      await sleep(300);
      assert.ok(fx.cookies.some((c) => c.includes('SAXTEST=')), 'Chrome은 쿠키를 받아 다시 보냈다(시험이 헛돌지 않게)');
      const sawResponse = eng.events.some((e) => e.method === 'Network.responseReceived' && String((e.params!.response as Json).url).endsWith('/session'));
      assert.ok(sawResponse, '응답 이벤트 자체는 엔진에 간다');
      assert.deepEqual(h.capture.scan([fx.cookieValue]), [], '엔진 포트 원문(인코딩 변형 포함)에 쿠키 값 0건');
      const raw = JSON.stringify(eng.events);
      assert.doesNotMatch(raw, /SAXTEST/);
      assert.doesNotMatch(raw, /set-cookie/i);
      assert.doesNotMatch(raw, /"cookie"/i);
      assert.doesNotMatch(raw, /associatedCookies|blockedCookies|headersText/);
    } finally {
      await h.close();
      await fx.close();
    }
  });
});

// ───────────────────────── V11 · N-78 ─────────────────────────
describe('audit-v V11 알려진 값 변형 범위', () => {
  it('audit-v: known variants are dropped at endWindow(commit)', async () => {
    const s = await setup();
    s.ops.secrets.provide(bind(), enc('TEST-CERT-variant01'));
    assert.deepEqual(await s.ops.fill(fillReq()), { ok: true });
    assert.ok(s.relay.knownVariantCount('RUN') > 0, '오염 상태 동안은 들고 있다');
    s.conn.emitEvent('Page.frameNavigated', { frame: { id: 'RUN', url: 'http://127.0.0.1:1/done' } }, 'V-RUN');
    assert.equal(s.t.win, undefined);
    assert.ok(s.relay.knownVariantCount('RUN') > 0, '이미 줄에 선 엔진 메시지가 나갈 때까지는 들고 있다');
    await s.relay.drained();
    assert.equal(s.relay.knownVariantCount(), 0);
  });

  it('audit-v: an engine event queued before the commit is still scrubbed after endWindow', async () => {
    const s = await setup();
    s.ops.secrets.provide(bind(), enc('TEST-CERT-order0001'));
    assert.deepEqual(await s.ops.fill(fillReq()), { ok: true });
    const sid = 'E-1'; // setup의 첫 엔진 세션
    // 같은 덩어리: 엔진 세션 이벤트(줄에 선다) 다음에 금고 세션의 커밋(바로 처리된다)
    s.conn.emitEvent('Log.entryAdded', { entry: { source: 'network', level: 'info', text: 'body=TEST-CERT-order0001' } }, sid);
    // 로그인 POST(커밋 직전): 받은 시점에 오염 상태였으므로 바디를 지우고 requestId를 오염으로 남긴다
    s.conn.emitEvent('Network.requestWillBeSent', { requestId: 'REQ-1', request: { url: 'http://127.0.0.1:1/login', method: 'POST', headers: {}, postData: 'pw=x', hasPostData: true } }, sid);
    s.conn.emitEvent('Page.frameNavigated', { frame: { id: 'RUN', url: 'http://127.0.0.1:1/done' } }, 'V-RUN');
    await s.relay.drained();
    const post = s.toEngine.find((m) => m.method === 'Network.requestWillBeSent');
    assert.ok(post && !JSON.stringify(post).includes('pw=x'), '커밋보다 먼저 받은 요청의 바디는 지운다');
    s.relay.onEngineMessage(JSON.stringify({ id: 991, sessionId: sid, method: 'Network.getRequestPostData', params: { requestId: 'REQ-1' } }));
    await tick();
    await s.relay.drained();
    const r = s.toEngine.find((m) => m.id === 991);
    assert.ok(r && r.error && !JSON.stringify(r).includes('pw=x'), '그 요청의 바디 조회는 거부한다');
    const logs = s.toEngine.filter((m) => m.method === 'Log.entryAdded');
    assert.equal(logs.length, 1);
    assert.ok(!JSON.stringify(logs).includes('TEST-CERT-order0001'), '알려진 값은 지운 뒤 나간다');
    assert.equal(s.relay.knownVariantCount(), 0);
  });

  it('audit-v: run.end with no open window clears all variants', async () => {
    const b = await bareVault();
    const s = await setup();
    try {
      b.vault.relay = s.relay;
      s.relay.openWindow(s.t, 'human', 'RUN', 7);
      s.relay.addKnownSecret('RUN', knownValueVariants('TEST-CERT-runend01'));
      s.relay.addKnownSecret('GONE', knownValueVariants('TEST-CERT-runend02')); // 사라진 타깃의 남은 변형
      await b.control.rpc('run.end', { runId: 'r1' });
      assert.ok(s.relay.knownVariantCount() > 0, '열린 창이 있으면 남긴다');
      s.relay.endWindow(s.t, 'detached');
      await s.relay.drained();
      assert.equal(s.relay.knownVariantCount(), 0, '마지막 창이 끝나면 전부 비운다');
      s.relay.addKnownSecret('GONE', knownValueVariants('TEST-CERT-runend03'));
      await b.control.rpc('run.end', { runId: 'r1' });
      assert.equal(s.relay.knownVariantCount(), 0);
    } finally {
      b.vault.relay = null;
      await b.close();
    }
  });
});

// ───────────────────────── V12 · N-30 ─────────────────────────
describe('audit-v V12 DB 키 get/create 분리', () => {
  it('audit-v: missing key with an existing db fails with db.key_missing and writes no key', async () => {
    const b = await bareVault();
    try {
      await fs.mkdir(b.paths.db, { recursive: true });
      await fs.writeFile(path.join(b.paths.db, 'db.sqlite'), 'encrypted');
      await assert.rejects(b.vault.getDbKeyOnce(), /^Error: db\.key_missing$/);
      assert.equal(await b.keyStore.get('db-key', 32), null, '새 키를 만들지 않았다');
      assert.ok(b.log.lines.some((l) => l.includes('vault.dbkey_missing')));
    } finally {
      await b.close();
    }
  });

  it('audit-v: length mismatch throws keystore_mismatch and leaves the entry', async () => {
    const ks = new MemoryKeyStore();
    ks.set('db-key', new Uint8Array(16).fill(7));
    const b = await bareVault({ keyStore: ks });
    try {
      await assert.rejects(b.vault.getDbKeyOnce(), /vault\.keystore_mismatch/);
      assert.ok(b.log.lines.some((l) => l.includes('vault.keystore_mismatch')));
      await assert.rejects(ks.get('db-key', 32), /keystore_mismatch/);
      assert.deepEqual([...(await ks.get('db-key', 16))!], new Array(16).fill(7), '덮어쓰지 않았다');
    } finally {
      await b.close();
    }
  });

  it('audit-v: first install creates and re-reads the key', async () => {
    const b = await bareVault();
    try {
      const k = await b.vault.getDbKeyOnce();
      assert.equal(k.length, 32);
      assert.deepEqual([...(await b.keyStore.get('db-key', 32))!], [...k]);
      await assert.rejects(b.vault.getDbKeyOnce(), /denied/, '기동당 1회는 그대로');
      // 다음 기동: 같은 키
      const again = new Vault({ paths: b.paths, log: b.log, keyStore: b.keyStore });
      assert.deepEqual([...(await again.getDbKeyOnce())], [...k]);
    } finally {
      await b.close();
    }
  });
});

// ───────────────────────── V13 · N-46 ─────────────────────────
describe('audit-v V13 비밀 종류↔칸 결박', () => {
  it('audit-v: built-in origins never let the typist enter a certificate password (ADR-020 decision 2)', () => {
    assert.deepEqual(SECRET_ORIGINS.cert_password, [], '공동·금융인증서 비밀번호는 사용자가 직접 입력');
    assert.deepEqual(SECRET_ORIGINS.portal_password, ['hometax.go.kr']);
    assert.deepEqual(SECRET_ORIGINS.security_card, ['hometax.go.kr']);
  });

  it('audit-v: fill with a mismatched slot kind returns not_secret_slot', async () => {
    const s = await setup();
    s.ops.secrets.provide(bind(), enc('TEST-CERT-slot0001'));
    assert.deepEqual(await s.ops.fill(fillReq({ slot: { secretKind: 'security_card', purpose: 'login' } })), { ok: false, reason: 'not_secret_slot' });
    assert.deepEqual(await s.ops.fill({ ...fillReq(), slot: undefined } as unknown as FillRequest), { ok: false, reason: 'not_secret_slot' }, 'slot 없음');
    assert.equal(s.page.value, '', '입력하지 않았다');
    assert.equal(s.ops.secrets.size, 1, '비밀을 꺼내지 않았다');
  });

  it('audit-v: second fill of the same kind in one run is denied', async () => {
    const s = await setup();
    s.ops.secrets.provide(bind(), enc('TEST-CERT-twice001'));
    assert.deepEqual(await s.ops.fill(fillReq()), { ok: true });
    s.conn.emitEvent('Page.frameNavigated', { frame: { id: 'RUN', url: 'http://127.0.0.1:1/again' } }, 'V-RUN'); // 창 종료
    s.page.value = '';
    s.page.len = 0;
    s.ops.secrets.provide(bind(), enc('TEST-CERT-twice002'));
    assert.deepEqual(await s.ops.fill(fillReq()), { ok: false, reason: 'denied' }, '같은 실행·같은 종류 두 번째');
    assert.equal(s.page.value, '');
    // 보안카드는 칸별 1회
    s.ops.secrets.provide(bind({ kind: 'security_card', row: 1 }), enc('12'));
    s.ops.secrets.provide(bind({ kind: 'security_card', row: 2 }), enc('34'));
    s.page.rowLabel = '[1]';
    assert.deepEqual(await s.ops.fill(card(1)), { ok: true });
    s.conn.emitEvent('Page.frameNavigated', { frame: { id: 'RUN', url: 'http://127.0.0.1:1/card' } }, 'V-RUN');
    s.page.value = '';
    s.page.len = 0;
    s.page.rowLabel = '2번';
    assert.deepEqual(await s.ops.fill(card(2)), { ok: true });
  });
});

// ───────────────────────── V14 · N-32 ─────────────────────────
describe('audit-v V14 금고 런타임 송신 모듈 차단', () => {
  it('audit-v: after net-deny, dynamic import of node:net fails', () => {
    const netDeny = pathToFileURL(path.resolve(import.meta.dirname, '../packages/vault/src/net-deny.ts')).href;
    const code = `
      const { netDenyInstalled } = await import(${JSON.stringify(netDeny)});
      const out = { installed: netDenyInstalled, denied: {} };
      for (const m of ['node:net', 'net', 'node:http', 'https', 'node:tls', 'dgram', 'node:dns/promises', 'http2', 'electron']) {
        try { await import(m); out.denied[m] = 'loaded'; } catch (e) { out.denied[m] = e.code; }
      }
      try { (await import('node:module')).createRequire(import.meta.url)('node:https'); out.require = 'loaded'; } catch (e) { out.require = e.code; }
      out.fs = typeof (await import('node:fs')).readFileSync;
      out.child = typeof (await import('node:child_process')).spawn;
      console.log(JSON.stringify(out));`;
    const r = spawnSync(process.execPath, ['--conditions=development', '--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim()) as { installed: boolean; denied: Record<string, string>; require: string; fs: string; child: string };
    assert.equal(out.installed, true);
    for (const [m, v] of Object.entries(out.denied)) assert.equal(v, 'ERR_SAX_NET_DENIED', m);
    assert.equal(out.require, 'ERR_SAX_NET_DENIED', 'require도 막는다');
    assert.equal(out.fs, 'function');
    assert.equal(out.child, 'function', 'Chrome 기동용 child_process는 허용');
  });
});
