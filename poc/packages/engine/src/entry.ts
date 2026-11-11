// 엔진 utilityProcess 진입점. DB의 유일한 소유자(D07 §1.3). main과는 두 통로다(ADR-021, D01 §2.1).
// - parentPort(중계 통로): main 질의·렌더러 명령·실행 명령. 여기로 온 승인·증언은 거부한다.
// - 게이트 포트(main 전용 MessagePort): 게이트 요청·닫힘(엔진 → main), LocalApproval(main → 엔진)만.
// 금고와는 전용 MessagePort.
// 환경 변수 가드가 첫 import다(playwright-core의 DEBUG 읽기·TLS 설정보다 먼저 평가되어 기동을 거부한다).
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
import { connectRunBrowser, RunBrowserSlot } from './browser.ts';
import { COMMANDS, DataService, READ_QUERIES } from './data-service.ts';
import type { GatePortMessage } from './gate.ts';
import { fixturePortal, HOMETAX_PORTAL } from './portal.ts';
import { RunEnd } from './run-end.ts';
import { GATE_ONLY_METHODS, RUN_COMMANDS, RUN_HISTORY_QUERIES, type EngineInit } from './protocol.ts';
import { PAYROLL_COMMANDS, PAYROLL_READ_QUERIES } from './protocol.ts';
import { REGISTRY_COMMANDS, REGISTRY_READ_QUERIES } from './protocol.ts';
import { REGISTRY_TRUST_PIN } from './registry-pin.ts';
import { rateTableSink } from './registry-sinks.ts';
import { runPermit } from './core/permit.ts';
import { egressRegistryFetch, PRODUCT_PACKAGE_IDS, PRODUCT_PACKAGES, RegistrySync, settingsRegistryStore } from './registry-sync.ts';
import { installedIrSource } from './package-source.ts';
import { VaultPdfPort } from './driver/pdf.ts';
import { recordRunInputs, runHistory } from './run-history.ts';
import { PHONE_COMMANDS } from './protocol.ts';
import { PhoneIntake } from '@sax/bundle';
import { PcFileIntake } from '@sax/bundle';
import { PC_FILE_COMMANDS } from './protocol.ts';
import { SETTLEMENT_COMMANDS } from './protocol.ts';
import { DAEMON_READ_QUERIES } from './protocol.ts';
import { INTENT_COMMANDS } from './protocol.ts';
import { gatewayIntentModel, gatewayRunJudge, IntentResolver } from './intent.ts';
import { BUNDLE_REQUEST_COMMANDS } from './protocol.ts';
import { CARD_COMMANDS, CARD_READ_QUERIES } from './protocol.ts';
import { PAYROLL_EMPLOYEE_COMMANDS, PAYROLL_EMPLOYEE_READ_QUERIES } from './protocol.ts';
import { BUNDLE_PC_COMMANDS, BUNDLE_PC_READ_QUERIES } from './protocol.ts';
import { RunService, type StartParams } from './runs.ts';
import { closeOnShutdown } from './shutdown.ts';
import { VaultClient } from './vault-client.ts';

interface ParentPort {
  on(ev: 'message', fn: (e: { data: unknown; ports: MessagePortMain[] }) => void): void;
  postMessage(m: unknown): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;
let log = new FileEventLog(null, 'engine');
let data: DataService | null = null;
/** 급여·꾸러미·S-06(BundleService). DB와 컬럼 키를 가진다. 컬럼 키는 이 프로세스 밖으로 나가지 않고 로그에도 남기지 않는다. */
let payroll: BundleService | null = null;
/** 폰 사진·현금 수신(PhoneIntake). 보관함 파일과 documents·receipts 행을 한 번에 쓴다. */
let phone: PhoneIntake | null = null;
/** PC 파일 보관(PcFileIntake): 종이 증빙·꾸러미 파일 칸. 보관함 파일과 documents·receipts|bundle_entries 행을 한 번에 쓴다. */
let pcFiles: PcFileIntake | null = null;
/** 대화 의도 판정(intent.resolve). 모델 경로는 엔진 Egress 게이트웨이뿐이고, 없으면 decide.unavailable(main은 연결 안 됨). */
let intent: IntentResolver | null = null;
let browser: RunBrowserSlot | null = null;
let runs: RunService | null = null;
/** 레지스트리 동기화(main 전용 질의·명령). 핀 키가 없으면 null(registry.not_pinned). */
let registry: RegistrySync | null = null;
let initialized = false;
/** 실행 이력 조회·입력 요약 봉인(run-history.ts). DB·컬럼 키는 init이 연다. */
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
// 정산내역 넣기(M6-5)도 PcFileIntake가 맡는다(보관함 파일 + 문서 + 그달 표시를 한 번에).
for (const m of SETTLEMENT_COMMANDS) {
  PC_FILE.add(m);
  ALLOWED.add(m);
}
// daemon.snapshot도 BundleService가 맡는다(컬럼 키로 직원 이름을 읽는 missingReport가 들어 있다). 정책·status는 엔진이 들고 있게 되면 BundleService 옵션 daemon으로 넘긴다.
for (const m of DAEMON_READ_QUERIES) {
  PAYROLL.add(m);
  ALLOWED.add(m);
}
// 세무사 요청 붙여넣기 후보(M6-7)도 BundleService가 맡는다(꾸러미 항목을 읽어 이미 있는 항목을 가리킨다).
for (const m of BUNDLE_REQUEST_COMMANDS) {
  PAYROLL.add(m);
  ALLOWED.add(m);
}
// 사업용 카드 내역 화면(M6-3)도 BundleService가 맡는다.
for (const m of [...CARD_READ_QUERIES, ...CARD_COMMANDS]) {
  PAYROLL.add(m);
  ALLOWED.add(m);
}
// 급여대장 직원 입력·지난달과 같나요?·급여 기능 켜기(M6-9)도 BundleService가 맡는다.
for (const m of [...PAYROLL_EMPLOYEE_READ_QUERIES, ...PAYROLL_EMPLOYEE_COMMANDS]) {
  PAYROLL.add(m);
  ALLOWED.add(m);
}
// 꾸러미 PC 입력(현금매출·종이 증빙 확인·항목 상태, M6-2·M6-4)도 BundleService가 맡는다.
for (const m of [...BUNDLE_PC_READ_QUERIES, ...BUNDLE_PC_COMMANDS]) {
  PAYROLL.add(m);
  ALLOWED.add(m);
}

const INTENT = new Set<string>(INTENT_COMMANDS);
for (const m of INTENT) ALLOWED.add(m);

async function init(msg: EngineInit, vaultPort: MessagePortMain, gatePort: MessagePortMain | undefined, authPort: MessagePortMain | undefined): Promise<void> {
  const paths = appPaths(msg.root ?? defaultAppRoot());
  log = new FileEventLog(paths.logs, 'engine');
  const vault = new VaultClient(wrapPort(vaultPort, 'electron'));
  // 실행 페이지는 개발 콘솔(browser.open)과 플레이북(RunService)이 같은 칸을 쓴다. 동시 열기·Chrome 내려감 복구는 칸이 맡는다.
  const slot = new RunBrowserSlot(() => connectRunBrowser(vault), () => vault.rpc('browser.shutdown'));
  browser = slot;
  const key = await vault.rpc<Uint8Array>('getDbKeyOnce');
  const db = openDatabase(path.join(paths.db, 'db.sqlite'), key);
  // 종료(SIGTERM·exit) 때 DB를 닫는다. 진행 중 실행이 있어도 프로세스가 끝나는 중이다(원장은 이미 커밋한 행만 믿는다).
  closeOnShutdown(() => db.close());
  // 원장 HMAC 키는 DB 키에서 HKDF로 파생한다(ADR-021). DB 키는 지금처럼 바로 지운다.
  const ledgerKey = new Uint8Array(hkdfSync('sha256', key, new Uint8Array(0), 'SAX-ledger-hmac-v1', 32));
  // 컬럼 키(주민번호 rrn_enc 등, D07 §2 *_enc)도 DB 키를 지우기 전에 한 번 파생한다. ColumnCipher가 복사해 갖고, 파생 바이트는 바로 지운다.
  const columnKey = deriveColumnKey(key);
  const cipher = new ColumnCipher(columnKey);
  columnKey.fill(0);
  history = { db, cipher };
  key.fill(0);
  // 게이트웨이 인증은 main auth 포트로 요청마다 받는다(ADR-040 결정 3: gateway 범위 기기 토큰, 엔진은 토큰·키를 갖지 않는다).
  // auth 포트가 없으면(개발 콘솔·시험 기동) 게이트웨이 구성 없이 둔다. 그때 intent.resolve는 decide.unavailable이다.
  const egress = new Egress(authPort ? { gateway: { auth: portGatewayAuth(wrapPort(authPort, 'electron')), bundles: BundleCatalog.load().allowEntries() } } : {});
  if (egress.envTampered.length) log.event('egress.env_tampered', { keys: egress.envTampered.join(',') });
  data = new DataService(db, new BizVerifier(egress), { vaultDir: paths.vault });
  payroll = new BundleService(db, cipher, { exportDir: path.join(paths.root, 'exports') });
  // 레지스트리 GET은 Egress 레지스트리 바이트 GET(origin tax.laf-co.com 고정·허용 경로, ADR-028)으로만 나간다. main이 registry.sync를 부를 때만 받는다.
  // H-01 패키지는 받아 둔 서명 설치본을 실행 시작마다 다시 검증해 IR로 돌린다(PR-D2).
  if (REGISTRY_TRUST_PIN) registry = new RegistrySync({ trust: REGISTRY_TRUST_PIN, fetch: egressRegistryFetch(egress), store: settingsRegistryStore(db), packages: { ids: PRODUCT_PACKAGE_IDS }, sinks: [rateTableSink(db)], log, appVersion: typeof msg.appVersion === 'string' ? msg.appVersion : null });
  phone = new PhoneIntake(db, { vaultDir: paths.vault });
  pcFiles = new PcFileIntake(db, { vaultDir: paths.vault });
  intent = new IntentResolver(db, { model: gatewayIntentModel(egress) });
  const portal = msg.portal.kind === 'fixture' ? fixturePortal(msg.portal.origin) : HOMETAX_PORTAL;
  if (gatePort) {
    const gate: PortLike = wrapPort(gatePort, 'electron');
    // 실행기(PR-D2, 팀장 지시 2026-11-09): 홈택스는 레지스트리에서 받은 서명 H-01 패키지를 IR로 돌린다(설치본이 없으면 package.not_loaded).
    // fixture 개발 포털(시연·e2e)은 H01Runner 그대로다. 제품 dist 로더는 fixture 패키지를 거부하므로(ADR-039) 시연 경로를 막지 않으려는 최소한이다.
    const ir = portal.kind === 'hometax';
    const runJudge = ir ? gatewayRunJudge(egress) : null;
    // save_pdf(H-01 s32): 금고가 지금 실행 탭을 인쇄해 staging에 두면 보관함에 실행 산출물로 넣는다(발급 결과 PDF, 재시작 뒤에도 남는다).
    // 포트가 없으면 s32가 engine.unhandled_step이 되어 메일 확인(s33)까지 건너뛴다(2026-11-11 리허설).
    const pdf = new VaultPdfPort({
      vault,
      targetId: () => slot.current?.targetId ?? '',
      staging: paths.staging,
      documents: data.documents,
      artifact: (bytes, o) => data!.documents.importRunArtifact(bytes, o),
    });
    // 공동인증서 비밀번호(B1 로그인 s4·B2 발급 서명 s21): 금고 비밀 창(전용 Chrome 칸에 사람이 직접) 또는 사람 직접 입력 대기. 값은 엔진에 오지 않는다.
    const secret = { vault, targetId: () => slot.current?.targetId ?? '' };
    runs = new RunService({
      db, data, ledgerKey, portal, engine: ir ? 'ir' : 'h01',
      ...(ir && registry ? { irSource: installedIrSource(registry, { id: PRODUCT_PACKAGES.h01, portal, pdf, secret, ...(runJudge ? { judge: runJudge.judge, runTokenFor: runJudge.runTokenFor } : {}) }) } : {}),
      page: async () => (await slot.open()).page, log, postGate: (m) => gate.postMessage(m),
      // 실행 허가(팀장 결정 2026-11-09 ④⑤, D03 §3.1·§7.1·§12): status killPlaybooks·portalModeCeiling ∧ 서명 정책 portalMode·만료 규칙.
      // 홈택스는 정책이 없거나(핀 없음 포함) 만료 뒤 168시간이 지나면 postprocess(fail-closed): 정책 게시 전에는 H-01을 자동으로 돌리지 않는다.
      // fixture 개발 포털은 status 상한·kill만 따르고 정책은 보지 않는다(실제 포털 접속이 없다).
      permit: (id) => runPermit(registry?.status() ?? null, 'hometax', id, portal.kind === 'hometax' ? (registry?.policy() ?? { freshness: 'none', policy: null }) : undefined),
      closeBrowser: () => slot.close(),
      // 요청률은 받은 서명 정책과 내장 값 중 더 엄격한 쪽만(팀장 결정 2026-11-09 ③, D03 §7). 정책이 없으면 내장 값.
      receivedPolicy: () => registry?.policy().policy ?? null,
    });
    gate.onMessage((m) => {
      const g = m as GatePortMessage;
      // 증언 처리는 M2-3에서 붙인다. 그 전에는 엔진이 증언 요청을 내지 않으므로 어떤 증언도 미결 요청이 없다.
      if (g?.t === 'attest.answer') return gate.postMessage({ t: 'attest.answer.result', attestReqId: String(g.attestation?.attestReqId ?? ''), ok: false, code: 'attest.no_request' } satisfies GatePortMessage);
      if (g?.t !== 'gate.answer') return log.event('engine.gate_port_unknown');
      const r = runs!.answer(g.approval);
      gate.postMessage({ t: 'gate.answer.result', reqId: String(g.approval?.reqId ?? ''), ...r } satisfies GatePortMessage);
    });
    runs.on('event', (data: Record<string, unknown>) => parentPort.postMessage({ t: 'ev', name: 'run', data }));
    // 금고가 비밀 값이 새는 기미를 보면 발급 전에 멈춘다(I-3).
    vault.on('secret_window.leak_suspected', () => runs?.leakSuspected());
  }
  log.event('engine.db_opened', { portal: portal.kind, gatePort: !!gatePort, authPort: !!authPort });
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  // 승인·증언은 중계 통로로 받지 않는다. 게이트 포트가 따로 있다.
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
  if (method === 'run.start' || method === 'run.stop' || method === 'run.inspect' || method === 'run.secretDone') {
    if (!runs) throw new Error('runs_not_ready');
    if (method === 'run.secretDone') return runs.secretDone(String(params.runId));
    if (method === 'run.inspect') return runs.inspect(String(params.runId));
    if (method === 'run.stop') return runs.stop(String(params.runId));
    const started = runs.start(params as unknown as StartParams);
    // 재시작 뒤 결과 카드·지난 실행 안내용 입력 요약(거래처 id·금액, 컬럼 키로 봉인). 실행 동작과 무관하다(쓰지 못해도 실행은 그대로).
    try {
      if (history) recordRunInputs(history.db, history.cipher, started.runId, { counterpartyId: params.counterpartyId as string, supply: params.supply as number, tax: params.tax as number });
    } catch {
      log.event('engine.run_inputs_not_recorded');
    }
    return started;
  }
  // 실행 중에는 개발 콘솔의 브라우저 명령을 받지 않는다(실행 탭을 옮기거나 닫지 못하게).
  if ((method === 'browser.open' || method === 'browser.close') && runs?.activeRunId) throw new Error('busy');
  if (method === 'browser.open') {
    if (!browser) throw new Error('vault_not_connected');
    // PoC-4/5 개발 콘솔: 실행 페이지만 띄운다. 발급은 run.start(H-01 플레이북). 첫 이동도 칸의 줄에서 돈다.
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
    // 동기화로 status가 바뀌었을 수 있다: 진행 중 실행의 허가를 다시 본다(kill이면 다음 스텝 전에, 승인 대기면 바로 멈춘다).
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
  if (INTENT.has(method)) {
    if (!intent) throw new Error('db_not_ready');
    return intent.handle(method, params);
  }
  if (PAYROLL.has(method)) {
    if (!payroll) throw new Error('db_not_ready');
    return payroll.handle(method, params);
  }
  if (!data) throw new Error('db_not_ready');
  return data.handle(method, params);
}

parentPort.on('message', (e) => {
  if (ENV_TAMPERED) return; // 기동 거부 중(env-guard가 fatal을 보냈다)
  const msg = e.data as { t?: string; id?: number; method?: string; params?: Record<string, unknown> };
  // 게이트 포트 없는 옛 기동(개발 콘솔 vault-port 메시지)은 받지 않는다. 게이트 없는 실행 경로를 남기지 않는다(N-24).
  if (msg?.t === 'vault-port') return parentPort.postMessage({ t: 'fatal', code: 'engine.vault_port_unsupported' });
  if (msg?.t === 'init' && e.ports[0]) {
    // 초기화는 한 번만. 다시 받으면 재시작 처리(in_doubt 승격·게이트 만료)가 진행 중인 실행을 망가뜨린다.
    if (initialized) return log.event('engine.init_again');
    initialized = true;
    init(msg as unknown as EngineInit, e.ports[0], e.ports[1], e.ports[2]).then(
      () => parentPort.postMessage({ t: 'ready' }),
      (err: Error) => parentPort.postMessage({ t: 'fatal', code: err.message.slice(0, 80) }),
    );
    return;
  }
  // 게이트 메시지 모양이 중계 통로로 오면 RPC가 아니어도 거부를 남긴다.
  // 증언(attest.answer)도 같다(ADR-021: 중계 통로에서 온 answerGate·attestNotCommitted는 거부하고 보안 이벤트).
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
