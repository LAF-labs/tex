import { ENV_TAMPERED } from './env-guard.ts';
import { hkdfSync } from 'node:crypto';
import type { MessagePortMain } from 'electron';
import path from 'node:path';
import { openDatabase, type Db } from '@sax/db';
import { ColumnCipher, deriveColumnKey } from '@sax/db';
import { BundleService } from '@sax/bundle';
import { Egress } from '@sax/net';
import { appPaths, defaultAppRoot, FileEventLog, wrapPort, type PortLike } from '@sax/platform';
import { BundleCatalog } from '@sax/model';
import { BizVerifier } from './bizverify.ts';
import { portGatewayAuth } from './gateway-auth.ts';
import { portIssueLock } from './issue-lock.ts';
import { connectRunBrowser, RunBrowserSlot } from './browser.ts';
import { COMMANDS, DataService, READ_QUERIES, resetRetiredAuth } from './data-service.ts';
import type { GatePortMessage } from './gate.ts';
import { fixturePortal, HOMETAX_PORTAL } from './portal.ts';
import { RunEnd } from './run-end.ts';
import { GATE_ONLY_METHODS, RUN_COMMANDS, RUN_HISTORY_QUERIES, type EngineInit } from './protocol.ts';
import { PAYROLL_COMMANDS, PAYROLL_READ_QUERIES } from './protocol.ts';
import { REGISTRY_COMMANDS, REGISTRY_READ_QUERIES } from './protocol.ts';
import { REGISTRY_TRUST_PIN } from './registry-pin.ts';
import { rateTableSink } from './registry-sinks.ts';
import { runPermit } from './core/permit.ts';
import { egressRegistryFetch, PRODUCT_CERT_IDS, PRODUCT_PACKAGE_IDS, PRODUCT_PACKAGES, RegistrySync, settingsRegistryStore } from './registry-sync.ts';
import { installedIrSource, REHEARSAL_PACKAGES_DIR, rehearsalIrSource } from './package-source.ts';
import { VaultPdfPort } from './driver/pdf.ts';
import { recordCertInputs, recordRunInputs, runHistory, runInputsOf } from './run-history.ts';
import { PHONE_COMMANDS } from './protocol.ts';
import { PhoneIntake } from '@sax/bundle';
import { PcFileIntake } from '@sax/bundle';
import { PC_FILE_COMMANDS } from './protocol.ts';
import { SETTLEMENT_COMMANDS } from './protocol.ts';
import { DAEMON_READ_QUERIES } from './protocol.ts';
import { CHAT_AGENT_COMMANDS, INTENT_COMMANDS } from './protocol.ts';
import { BANK_COMMANDS, BANK_READ_QUERIES } from './protocol.ts';
import { BankService } from './bank/service.ts';
import { SHARE_COMMANDS, SHARE_READ_QUERIES } from './protocol.ts';
import { ShareService } from './share/service.ts';
import { gatewayIntentModel, gatewayRunJudge, IntentResolver } from './intent.ts';
import { ChatAgent, gatewayChatAgentModel } from './chat-agent.ts';
import { BUNDLE_REQUEST_COMMANDS } from './protocol.ts';
import { CARD_COMMANDS, CARD_READ_QUERIES } from './protocol.ts';
import { PAYROLL_EMPLOYEE_COMMANDS, PAYROLL_EMPLOYEE_READ_QUERIES } from './protocol.ts';
import { BUNDLE_PC_COMMANDS, BUNDLE_PC_READ_QUERIES } from './protocol.ts';
import { bankServicePort, CODEF_COMMANDS, CodefClient, CodefError, codefFailResult, CodefLink, codefTxnSource, settingsCodefStore, vaultCodefSeal } from './codef/index.ts';
import { RunService, type StartParams } from './runs.ts';
import type { CertStartParams } from './cert.ts';
import { closeOnShutdown } from './shutdown.ts';
import { VaultClient } from './vault-client.ts';

interface ParentPort {
  on(ev: 'message', fn: (e: { data: unknown; ports: MessagePortMain[] }) => void): void;
  postMessage(m: unknown): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;
let log = new FileEventLog(null, 'engine');
let data: DataService | null = null;
let payroll: BundleService | null = null;
let phone: PhoneIntake | null = null;
let pcFiles: PcFileIntake | null = null;
let bank: BankService | null = null;
let share: ShareService | null = null;
let intent: IntentResolver | null = null;
let chatAgent: ChatAgent | null = null;
let browser: RunBrowserSlot | null = null;
let runs: RunService | null = null;
let registry: RegistrySync | null = null;
let initialized = false;
let history: { db: Db; cipher: ColumnCipher } | null = null;

const ALLOWED = new Set<string>([...READ_QUERIES, ...COMMANDS, ...RUN_COMMANDS, ...RUN_HISTORY_QUERIES, 'browser.open', 'browser.close', 'engine.status']);
const GATE_ONLY = new Set<string>(GATE_ONLY_METHODS);
const PAYROLL = new Set<string>([...PAYROLL_READ_QUERIES, ...PAYROLL_COMMANDS]);
for (const m of PAYROLL) ALLOWED.add(m);
const REGISTRY = new Set<string>([...REGISTRY_READ_QUERIES, ...REGISTRY_COMMANDS]);
for (const m of REGISTRY) ALLOWED.add(m);
const PHONE = new Set<string>(PHONE_COMMANDS);
for (const m of PHONE) ALLOWED.add(m);
const PC_FILE = new Set<string>(PC_FILE_COMMANDS);
for (const m of PC_FILE) ALLOWED.add(m);
for (const m of SETTLEMENT_COMMANDS) {
  PC_FILE.add(m);
  ALLOWED.add(m);
}
for (const m of DAEMON_READ_QUERIES) {
  PAYROLL.add(m);
  ALLOWED.add(m);
}
for (const m of BUNDLE_REQUEST_COMMANDS) {
  PAYROLL.add(m);
  ALLOWED.add(m);
}
for (const m of [...CARD_READ_QUERIES, ...CARD_COMMANDS]) {
  PAYROLL.add(m);
  ALLOWED.add(m);
}
for (const m of [...PAYROLL_EMPLOYEE_READ_QUERIES, ...PAYROLL_EMPLOYEE_COMMANDS]) {
  PAYROLL.add(m);
  ALLOWED.add(m);
}
for (const m of [...BUNDLE_PC_READ_QUERIES, ...BUNDLE_PC_COMMANDS]) {
  PAYROLL.add(m);
  ALLOWED.add(m);
}

const BANK = new Set<string>([...BANK_READ_QUERIES, ...BANK_COMMANDS]);
for (const m of BANK) ALLOWED.add(m);
const SHARE = new Set<string>([...SHARE_READ_QUERIES, ...SHARE_COMMANDS]);
for (const m of SHARE) ALLOWED.add(m);

const INTENT = new Set<string>(INTENT_COMMANDS);
for (const m of INTENT) ALLOWED.add(m);
const CHAT_AGENT = new Set<string>(CHAT_AGENT_COMMANDS);
for (const m of CHAT_AGENT) ALLOWED.add(m);
const CODEF = new Set<string>(CODEF_COMMANDS);
for (const m of CODEF) ALLOWED.add(m);
let codef: CodefLink | null = null;

async function init(msg: EngineInit, vaultPort: MessagePortMain, gatePort: MessagePortMain | undefined, authPort: MessagePortMain | undefined): Promise<void> {
  const paths = appPaths(msg.root ?? defaultAppRoot());
  log = new FileEventLog(paths.logs, 'engine');
  const vault = new VaultClient(wrapPort(vaultPort, 'electron'));
  const slot = new RunBrowserSlot(() => connectRunBrowser(vault), () => vault.rpc('browser.shutdown'));
  browser = slot;
  const key = await vault.rpc<Uint8Array>('getDbKeyOnce');
  const db = openDatabase(path.join(paths.db, 'db.sqlite'), key);
  closeOnShutdown(() => db.close());
  const ledgerKey = new Uint8Array(hkdfSync('sha256', key, new Uint8Array(0), 'SAX-ledger-hmac-v1', 32));
  const bankKey = new Uint8Array(hkdfSync('sha256', key, new Uint8Array(0), 'SAX-bank-hmac-v1', 32));
  const columnKey = deriveColumnKey(key);
  const cipher = new ColumnCipher(columnKey);
  columnKey.fill(0);
  history = { db, cipher };
  key.fill(0);
  const auth = authPort ? wrapPort(authPort, 'electron') : null;
  const issueLock = auth ? portIssueLock(auth) : null;
  const egress = new Egress(auth ? { gateway: { auth: portGatewayAuth(auth), bundles: BundleCatalog.load().allowEntries() } } : {});
  if (egress.envTampered.length) log.event('egress.env_tampered', { keys: egress.envTampered.join(',') });
  data = new DataService(db, new BizVerifier(egress), { vaultDir: paths.vault });
  resetRetiredAuth(data.profiles, log);
  payroll = new BundleService(db, cipher, { exportDir: path.join(paths.root, 'exports') });
  if (REGISTRY_TRUST_PIN) registry = new RegistrySync({ trust: REGISTRY_TRUST_PIN, fetch: egressRegistryFetch(egress), store: settingsRegistryStore(db), packages: { ids: PRODUCT_PACKAGE_IDS }, sinks: [rateTableSink(db)], log, appVersion: typeof msg.appVersion === 'string' ? msg.appVersion : null });
  phone = new PhoneIntake(db, { vaultDir: paths.vault });
  pcFiles = new PcFileIntake(db, { vaultDir: paths.vault });
  bank = new BankService(db, cipher, bankKey, { vaultDir: paths.vault });
  share = new ShareService(db, cipher);
  bankKey.fill(0);
  intent = new IntentResolver(db, { model: gatewayIntentModel(egress) });
  chatAgent = new ChatAgent(db, { model: gatewayChatAgentModel(egress), closeOnCards: true });
  const codefBank = bankServicePort(bank, db);
  codef = new CodefLink({
    client: new CodefClient({ egress }),
    seal: vaultCodefSeal(vault),
    store: settingsCodefStore(db),
    bank: () => codefBank,
    onEvent: (e) => {
      log.event('engine.codef', { phase: e.phase, ...(e.code ? { code: e.code } : {}), ...(e.cf ? { cf: e.cf } : {}), ...(e.param ? { param: e.param } : {}), ...(e.clientType ? { clientType: e.clientType } : {}), ...(e.order ? { order: e.order } : {}), ...(e.hint ? { hint: e.hint } : {}) });
      const shown = { ...e };
      delete shown.hint;
      parentPort.postMessage({ t: 'ev', name: 'codef', data: shown });
    },
  });
  if (codef.status().cleanupPending) void codef.sweep().catch(() => undefined);
  bank.registerSource(codefTxnSource(codef));
  const portal = msg.portal.kind === 'fixture' ? fixturePortal(msg.portal.origin) : HOMETAX_PORTAL;
  if (gatePort) {
    const gate: PortLike = wrapPort(gatePort, 'electron');
    const ir = portal.kind === 'hometax';
    const runJudge = ir ? gatewayRunJudge(egress) : null;
    const pdf = new VaultPdfPort({
      vault,
      targetId: () => slot.current?.targetId ?? '',
      staging: paths.staging,
      documents: data.documents,
      artifact: (bytes, o) => data!.documents.importRunArtifact(bytes, o),
    });
    const secret = { vault, targetId: () => slot.current?.targetId ?? '' };
    runs = new RunService({
      db, data, ledgerKey, portal, engine: ir ? 'ir' : 'h01',
      ...(ir && registry ? { irSource: installedIrSource(registry, { id: PRODUCT_PACKAGES.h01, portal, pdf, secret, ...(runJudge ? { judge: runJudge.judge, runTokenFor: runJudge.runTokenFor, locate: runJudge.locate } : {}) }) } : {}),
      ...(ir && registry ? {
        certSource: (id: string) => PRODUCT_CERT_IDS.includes(id)
          ? installedIrSource(registry!, { id, portal, pdf, secret, ...(runJudge ? { judge: runJudge.judge, runTokenFor: runJudge.runTokenFor, locate: runJudge.locate } : {}) })()
          : { ok: false as const, code: 'cert.unknown_doc' },
      } : {}),
      rehearsalSnapDir: path.join(paths.root, 'rehearsal-snaps'),
      ...(ir && registry ? { rehearsalIrSource: rehearsalIrSource(registry, { id: PRODUCT_PACKAGES.h01, dir: path.join(paths.root, REHEARSAL_PACKAGES_DIR), portal, pdf, secret, ...(runJudge ? { judge: runJudge.judge, runTokenFor: runJudge.runTokenFor, locate: runJudge.locate } : {}) }) } : {}),
      ...(ir && registry ? {
        certRehearsalSource: (id: string) => PRODUCT_CERT_IDS.includes(id)
          ? rehearsalIrSource(registry!, { id, unsignedBaseline: PRODUCT_PACKAGES.h01, dir: path.join(paths.root, REHEARSAL_PACKAGES_DIR), portal, pdf, secret, ...(runJudge ? { judge: runJudge.judge, runTokenFor: runJudge.runTokenFor, locate: runJudge.locate } : {}) })()
          : null,
      } : {}),
      page: async () => (await slot.open()).page, log, postGate: (m) => gate.postMessage(m),
      ...(issueLock ? { issueLock } : {}),
      permit: (id) => runPermit(registry?.status() ?? null, 'hometax', id, portal.kind === 'hometax' ? (registry?.policy() ?? { freshness: 'none', policy: null }) : undefined),
      closeBrowser: () => slot.close(),
      currentPage: () => slot.current?.page ?? null,
      runInputs: (runId) => runInputsOf(db, cipher, runId),
      receivedPolicy: () => registry?.policy().policy ?? null,
    });
    gate.onMessage((m) => {
      const g = m as GatePortMessage;
      if (g?.t === 'attest.answer') return gate.postMessage({ t: 'attest.answer.result', attestReqId: String(g.attestation?.attestReqId ?? ''), ok: false, code: 'attest.no_request' } satisfies GatePortMessage);
      if (g?.t !== 'gate.answer') return log.event('engine.gate_port_unknown');
      const r = runs!.answer(g.approval);
      gate.postMessage({ t: 'gate.answer.result', reqId: String(g.approval?.reqId ?? ''), ...r } satisfies GatePortMessage);
    });
    runs.on('event', (data: Record<string, unknown>) => parentPort.postMessage({ t: 'ev', name: 'run', data }));
    vault.on('secret_window.leak_suspected', () => runs?.leakSuspected());
  }
  log.event('engine.db_opened', { portal: portal.kind, gatePort: !!gatePort, authPort: !!authPort });
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (GATE_ONLY.has(method)) {
    if (runs) runs.answerFromRelay(method);
    log.event('security.gate_answer_from_relay', { method });
    throw new Error('forbidden_channel');
  }
  if (!ALLOWED.has(method)) throw new Error('unknown_method');
  if (method === 'db.query.runs.history') {
    if (!history) throw new Error('db_not_ready');
    return runHistory(history.db, history.cipher, typeof params.limit === 'number' ? params.limit : 50);
  }
  if (method === 'engine.status') return { db: !!data, browser: !!browser?.current, runs: !!runs, activeRun: runs?.activeRunId ?? null };
  if (method === 'run.reverify') {
    if (!runs) throw new Error('runs_not_ready');
    return runs.reverify(typeof params.exclude === 'string' ? params.exclude : null);
  }
  if (method === 'run.simpleAuth') {
    if (!runs) throw new Error('runs_not_ready');
    const op = params.op === 'complete' ? 'complete' : params.op === 'request' ? 'request' : null;
    if (!op) throw new Error('bad_params');
    const d = op === 'request' ? { provider: String(params.provider ?? ''), name: String(params.name ?? ''), birth: String(params.birth ?? ''), phone: String(params.phone ?? ''), ...(typeof params.carrier === 'string' ? { carrier: params.carrier } : {}) } : undefined;
    return runs.simpleAuth(String(params.runId), op, d);
  }
  if (method === 'run.resume' || method === 'run.manualDone') {
    if (!runs) throw new Error('runs_not_ready');
    return method === 'run.resume' ? runs.resume(String(params.runId)) : runs.manualDone(String(params.runId));
  }
  if (method === 'run.start' || method === 'run.startCert' || method === 'run.stop' || method === 'run.inspect') {
    if (!runs) throw new Error('runs_not_ready');
    if (method === 'run.inspect') return runs.inspect(String(params.runId));
    if (method === 'run.stop') return runs.stop(String(params.runId));
    if (method === 'run.startCert') {
      const started = runs.startCert(params as unknown as CertStartParams);
      try {
        const inputs = runs.certInputsOf(started.runId);
        if (history && inputs) recordCertInputs(history.db, history.cipher, started.runId, inputs);
      } catch {
        log.event('engine.run_inputs_not_recorded');
      }
      return started;
    }
    const started = runs.start(params as unknown as StartParams);
    try {
      if (history) recordRunInputs(history.db, history.cipher, started.runId, { counterpartyId: params.counterpartyId as string, supply: params.supply as number, tax: params.tax as number });
    } catch {
      log.event('engine.run_inputs_not_recorded');
    }
    return started;
  }
  if ((method === 'browser.open' || method === 'browser.close') && runs?.activeRunId) throw new Error('busy');
  if (method === 'browser.open') {
    if (!browser) throw new Error('vault_not_connected');
    const run = await browser.open(async (r) => {
      if (params.portal === 'hometax') await r.page.goto('https://www.hometax.go.kr/');
    });
    return { targetId: run.targetId };
  }
  if (method === 'browser.close') {
    await browser?.close();
    return {};
  }
  if (REGISTRY.has(method)) {
    if (!data) throw new Error('db_not_ready');
    if (!registry) throw new Error('registry.not_pinned');
    const r = await registry.handle(method);
    runs?.recheckPermit();
    return r;
  }
  if (PC_FILE.has(method)) {
    if (!pcFiles) throw new Error('db_not_ready');
    return pcFiles.handle(method, params);
  }
  if (PHONE.has(method)) {
    if (!phone) throw new Error('db_not_ready');
    return phone.handle(method, params);
  }
  if (CODEF.has(method)) {
    if (!codef) throw new Error('db_not_ready');
    const c = codef;
    const run = async (): Promise<object> => {
      switch (method) {
        case 'codef.status':
          return c.status();
        case 'codef.connect':
          return c.connect(params);
        case 'codef.choose':
          return c.choose(params);
        case 'codef.sms':
          return c.sms(params);
        case 'codef.refresh':
          return c.refresh();
        case 'codef.cancel':
          return c.cancel();
        default:
          return c.disconnect();
      }
    };
    try {
      return { ok: true, ...(await run()) };
    } catch (e) {
      if (e instanceof CodefError) return codefFailResult(e);
      throw e;
    }
  }
  if (BANK.has(method)) {
    if (!bank) throw new Error('db_not_ready');
    return bank.handle(method, params);
  }
  if (SHARE.has(method)) {
    if (!share) throw new Error('db_not_ready');
    return share.handle(method, params as Record<string, unknown> | undefined);
  }
  if (INTENT.has(method)) {
    if (!intent) throw new Error('db_not_ready');
    return intent.handle(method, params);
  }
  if (CHAT_AGENT.has(method)) {
    if (!chatAgent) throw new Error('db_not_ready');
    return chatAgent.handle(method, params);
  }
  if (PAYROLL.has(method)) {
    if (!payroll) throw new Error('db_not_ready');
    return payroll.handle(method, params);
  }
  if (!data) throw new Error('db_not_ready');
  return data.handle(method, params);
}

parentPort.on('message', (e) => {
  if (ENV_TAMPERED) return;
  const msg = e.data as { t?: string; id?: number; method?: string; params?: Record<string, unknown> };
  if (msg?.t === 'vault-port') return parentPort.postMessage({ t: 'fatal', code: 'engine.vault_port_unsupported' });
  if (msg?.t === 'init' && e.ports[0]) {
    if (initialized) return log.event('engine.init_again');
    initialized = true;
    init(msg as unknown as EngineInit, e.ports[0], e.ports[1], e.ports[2]).then(
      () => parentPort.postMessage({ t: 'ready' }),
      (err: Error) => parentPort.postMessage({ t: 'fatal', code: err.message.slice(0, 80) }),
    );
    return;
  }
  if (msg?.t === 'gate.answer' || msg?.t === 'attest.answer') {
    log.event('security.gate_answer_from_relay', { method: msg.t });
    if (runs) {
      try {
        runs.answerFromRelay(msg.t);
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
