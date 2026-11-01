// 엔진 utilityProcess 진입점. DB의 유일한 소유자(D07 §1.3). main과는 두 통로다(ADR-021, D01 §2.1).
// - parentPort(중계 통로): main 질의·렌더러 명령·실행 명령. 여기로 온 승인·증언은 거부한다.
// - 게이트 포트(main 전용 MessagePort): 게이트 요청·닫힘(엔진 → main), LocalApproval(main → 엔진)만.
// 금고와는 전용 MessagePort.
import { hkdfSync } from 'node:crypto';
import type { MessagePortMain } from 'electron';
import path from 'node:path';
import { openDatabase } from '@sax/db';
import { Egress } from '@sax/net';
import { appPaths, defaultAppRoot, FileEventLog, wrapPort, type PortLike } from '@sax/platform';
import type { Browser, Page } from 'playwright-core';
import { BizVerifier } from './bizverify.ts';
import { connectRunBrowser } from './browser.ts';
import { COMMANDS, DataService, READ_QUERIES } from './data-service.ts';
import type { GatePortMessage } from './gate.ts';
import { fixturePortal, HOMETAX_PORTAL } from './h01/portal.ts';
import { RunEnd } from './h01/runner.ts';
import { GATE_ONLY_METHODS, RUN_COMMANDS, type EngineInit } from './protocol.ts';
import { RunService, type StartParams } from './runs.ts';
import { VaultClient } from './vault-client.ts';

interface ParentPort {
  on(ev: 'message', fn: (e: { data: unknown; ports: MessagePortMain[] }) => void): void;
  postMessage(m: unknown): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;
let log = new FileEventLog(null, 'engine');
let vault: VaultClient | null = null;
let data: DataService | null = null;
let runs: RunService | null = null;
let run: { browser: Browser; page: Page; targetId: string } | null = null;

const ALLOWED = new Set<string>([...READ_QUERIES, ...COMMANDS, ...RUN_COMMANDS, 'browser.open', 'browser.close', 'engine.status']);
const GATE_ONLY = new Set<string>(GATE_ONLY_METHODS);

async function runPage(): Promise<Page> {
  if (!vault) throw new Error('vault_not_connected');
  if (!run || run.page.isClosed()) run = await connectRunBrowser(vault);
  return run.page;
}

async function init(msg: EngineInit, vaultPort: MessagePortMain, gatePort: MessagePortMain | undefined): Promise<void> {
  const paths = appPaths(msg.root ?? defaultAppRoot());
  log = new FileEventLog(paths.logs, 'engine');
  vault = new VaultClient(wrapPort(vaultPort, 'electron'));
  const key = await vault.rpc<Uint8Array>('getDbKeyOnce');
  const db = openDatabase(path.join(paths.db, 'db.sqlite'), key);
  // 원장 HMAC 키는 DB 키에서 HKDF로 파생한다(ADR-021). DB 키는 지금처럼 바로 지운다.
  const ledgerKey = new Uint8Array(hkdfSync('sha256', key, new Uint8Array(0), 'SAX-ledger-hmac-v1', 32));
  key.fill(0);
  data = new DataService(db, new BizVerifier(new Egress()));
  const portal = msg.portal.kind === 'fixture' ? fixturePortal(msg.portal.origin) : HOMETAX_PORTAL;
  if (gatePort) {
    const gate: PortLike = wrapPort(gatePort, 'electron');
    runs = new RunService({ db, data, ledgerKey, portal, page: runPage, log, postGate: (m) => gate.postMessage(m) });
    gate.onMessage((m) => {
      const g = m as GatePortMessage;
      if (g?.t !== 'gate.answer') return log.event('engine.gate_port_unknown');
      const r = runs!.answer(g.approval);
      gate.postMessage({ t: 'gate.answer.result', reqId: String(g.approval?.reqId ?? ''), ...r } satisfies GatePortMessage);
    });
    runs.on('event', (data: Record<string, unknown>) => parentPort.postMessage({ t: 'ev', name: 'run', data }));
  }
  log.event('engine.db_opened', { portal: portal.kind, gatePort: !!gatePort });
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  // 승인·증언은 중계 통로로 받지 않는다. 게이트 포트가 따로 있다.
  if (GATE_ONLY.has(method)) {
    if (runs) runs.answerFromRelay(method);
    log.event('security.gate_answer_from_relay', { method });
    throw new Error('forbidden_channel');
  }
  if (!ALLOWED.has(method)) throw new Error('unknown_method');
  if (method === 'engine.status') return { db: !!data, browser: !!run, runs: !!runs, activeRun: runs?.activeRunId ?? null };
  if (method === 'run.start' || method === 'run.stop') {
    if (!runs) throw new Error('runs_not_ready');
    return method === 'run.start' ? runs.start(params as unknown as StartParams) : runs.stop(String(params.runId));
  }
  if (method === 'browser.open') {
    const page = await runPage();
    // PoC-4/5 개발 콘솔: 실행 페이지만 띄운다. 발급은 run.start(H-01 플레이북).
    if (params.portal === 'hometax') await page.goto('https://www.hometax.go.kr/');
    return { targetId: run!.targetId };
  }
  if (method === 'browser.close') {
    await run?.browser.close().catch(() => {});
    run = null;
    await vault?.rpc('browser.shutdown').catch(() => {});
    return {};
  }
  if (!data) throw new Error('db_not_ready');
  return data.handle(method, params);
}

parentPort.on('message', (e) => {
  const msg = e.data as { t?: string; id?: number; method?: string; params?: Record<string, unknown> };
  if ((msg?.t === 'init' || msg?.t === 'vault-port') && e.ports[0]) {
    // 'vault-port'는 게이트 포트 없는 옛 기동(개발 콘솔). 실행 명령을 받지 않는다.
    const m: EngineInit = msg.t === 'init' ? (msg as unknown as EngineInit) : { t: 'init', portal: { kind: 'hometax' } };
    init(m, e.ports[0], msg.t === 'init' ? e.ports[1] : undefined).then(
      () => parentPort.postMessage({ t: 'ready' }),
      (err: Error) => parentPort.postMessage({ t: 'fatal', code: err.message.slice(0, 80) }),
    );
    return;
  }
  // 게이트 메시지 모양이 중계 통로로 오면 RPC가 아니어도 거부를 남긴다.
  if (msg?.t === 'gate.answer') {
    log.event('security.gate_answer_from_relay', { method: 'gate.answer' });
    if (runs) {
      try {
        runs.answerFromRelay('gate.answer');
      } catch {
        // 기록만 한다
      }
    }
    return;
  }
  if (msg?.t !== 'rpc' || typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
  handle(msg.method, msg.params ?? {}).then(
    (result) => parentPort.postMessage({ t: 'rpc', id: msg.id, result }),
    (err: Error & { code?: string }) => parentPort.postMessage({ t: 'rpc', id: msg.id, error: err instanceof RunEnd ? err.code : (err.code ?? err.message.slice(0, 120)) }),
  );
});
