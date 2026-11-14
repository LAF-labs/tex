// main ↔ 엔진 메서드 목록(의존성 없음: main이 엔진 코드를 끌어오지 않게 분리).
/** main(스케줄러·UI)이 쓰는 읽기 전용 질의(D07 §1.3 db.query.*). */
export const READ_QUERIES = ['db.query.profiles.list', 'db.query.counterparties.list', 'db.query.counterparties.get', 'db.query.documents.list'] as const;
/** 사용자 동작으로만 오는 명령(렌더러 → main → 엔진). main은 DB를 열지 않는다. */
export const COMMANDS = [
  'profile.upsert', 'profile.delete',
  'counterparty.create', 'counterparty.update', 'counterparty.delete', 'counterparty.verify', 'counterparty.status',
  'bizcert.parse', 'bizverify.setKey', 'bizverify.hasKey',
  'document.import', 'document.update', 'document.file',
  'consent.record', 'consent.latest', 'consent.attach',
  'onboarding.load', 'onboarding.save', 'onboarding.clear',
  'profile.setPortalLoginId', 'profile.setCertName',
  'counterparty.setItems', 'counterparty.getItems',
  'resume.save', 'resume.take',
] as const;
/**
 * main만 부르는 명령(렌더러에 열지 않는다). 새 명령은 렌더러에 열리는 것이 기본이므로 main 전용이면 여기에 더한다.
 * - bizcert.parse·document.import: main이 docparse 결과를 붙여 부른다(렌더러가 텍스트·바이트를 지어 보낼 수 없다).
 * - document.file: 보관함 파일 경로를 돌려준다(main이 기본 뷰어로 열 때만, 렌더러에는 경로를 주지 않는다).
 * - consent.*·onboarding.*·profile.setPortalLoginId·profile.setCertName: 온보딩 저장소(db #53). 동의 기록·이어 하기 상태·금고 등록 결과의 포털 로그인 ID는
 *   main의 온보딩 흐름만 쓴다(렌더러가 동의 시각·출처를 지어 보낼 수 없다).
 */
export const MAIN_ONLY: readonly (typeof COMMANDS)[number][] = [
  'bizcert.parse', 'document.import', 'document.file',
  'consent.record', 'consent.latest', 'consent.attach',
  'onboarding.load', 'onboarding.save', 'onboarding.clear',
  'profile.setPortalLoginId', 'profile.setCertName',
  // 셸 이어 하기(run-resume.ts): 커밋 전 일의 거래처 id·금액·품목. 암호화된 DB settings에 두고 main만 쓴다.
  'resume.save', 'resume.take',
];
/**
 * 급여대장·세무사 꾸러미·S-06 조회와 명령(팀장 결정 2026-11-06, ADR-031·032·034). 처리는 @sax/bundle BundleService(엔진 프로세스)다.
 * 급여·직원 이름·주민번호 가림값·내보내기 파일 경로·암호가 오가므로 조회까지 모두 main 전용이다(PAYROLL_MAIN_ONLY, 렌더러에 열지 않는다).
 */
export const PAYROLL_READ_QUERIES = ['db.query.payroll.month', 'db.query.payroll.employees', 'db.query.bundle.status', 'db.query.bundle.missing', 'db.query.rateTables.installed'] as const;
export const PAYROLL_COMMANDS = [
  'payroll.compute', 'payroll.saveDraft', 'payroll.confirm', 'payroll.revise', 'payroll.takeHome',
  'notice.card', 'notice.confirm',
  'bundle.ensureItems', 'bundle.addItem', 'bundle.cardSlipEnough', 'bundle.setIncludeRrn', 'bundle.export', 'bundle.markOpened', 'bundle.markSent',
  'payroll.exportRecord',
] as const;
/** 위 둘 전부. MAIN_ONLY와 같은 뜻이다(MAIN_ONLY는 COMMANDS 이름만 받는 타입이라 따로 둔다). */
export const PAYROLL_MAIN_ONLY: readonly ((typeof PAYROLL_READ_QUERIES)[number] | (typeof PAYROLL_COMMANDS)[number])[] = [...PAYROLL_READ_QUERIES, ...PAYROLL_COMMANDS];
/**
 * 레지스트리 동기화(D03 §3.1·§7.1, D09 §8.4, ADR-028). 모두 main 전용이다(REGISTRY_MAIN_ONLY, 렌더러에 열지 않는다).
 * - registry.sync: 폐기 목록 → status → stable 인덱스 → 데이터 패키지(급여 시행일 표)를 받아 엔진 수용 함수로 검증한다. 결과는 단계별 코드만.
 * - db.query.registry.revocation: {keyIds, fresh(24시간), monotonic, expiresAt}. 업데이터(@sax/updater Revocation)가 쓴다.
 * - db.query.registry.pins: 앱에 핀 고정한 키(TrustPin, trust.json 모양). 업데이터의 release·root 키도 여기서 받는다.
 * - db.query.registry.status: {freshness: fresh|stale|daemon_stop, emergency, monotonic, portalModeCeiling, killPlaybooks}.
 */
export const REGISTRY_READ_QUERIES = ['db.query.registry.revocation', 'db.query.registry.pins', 'db.query.registry.status'] as const;
export const REGISTRY_COMMANDS = ['registry.sync'] as const;
export const REGISTRY_MAIN_ONLY: readonly ((typeof REGISTRY_READ_QUERIES)[number] | (typeof REGISTRY_COMMANDS)[number])[] = [...REGISTRY_READ_QUERIES, ...REGISTRY_COMMANDS];
/**
 * 폰 사진·현금 수신(데스크톱 ③c 계약, 팀장 결정 2026-11-06). main 전용이다(렌더러에 열지 않는다). 처리는 @sax/bundle PhoneIntake다.
 * 폰 큐(@sax/remote ReceiveSink)가 엔진 rpc에 얇게 붙는다. 중복은 msgId(receipts.phone_msg_id)로만 보고, 고아 문서·파일을 남기지 않는다.
 */
export const PHONE_COMMANDS = ['receipt.phoneHas', 'receipt.phoneStore', 'cash.phonePut'] as const;
/**
 * 데몬 스냅숏(D10 §3, 팀장 결정 2026-11-06). main 전용 읽기 질의다(렌더러에 열지 않는다). 쓰기·실행·DB 키 노출이 없다.
 * 응답은 @sax/daemon DaemonSnapshot. 처리는 @sax/bundle BundleService(daemonSnapshot)다.
 */
export const DAEMON_READ_QUERIES = ['daemon.snapshot'] as const;
/**
 * 대화 의도 판정(M4-3 ③, D01 §5.1, 계약: desktop-pending.md 「M4-3 ③」). main 전용이다(렌더러에 열지 않는다: main이 입력창 문장만 넘긴다).
 * 결과는 route·refuse_advice·unknown 셋이고, 판정을 못 하면 decide.unavailable(main은 "연결 안 됨"과 [다시 시도], 오프라인 해석 없음). 실행·저장은 없다.
 * chat.respond {text}: unknown 문장에 모델이 짧게 답한다(chat_reply, 팀장 지시 2026-11-10). 결과 {reply, kind, suggest, filtered},
 * 오류 bad_text·chat.unavailable·chat.bad_response·chat.budget_exceeded·chat.quota_exceeded·chat.input_too_large·chat.secret_rejected. 오프라인 대체 없음.
 */
export const INTENT_COMMANDS = ['intent.resolve', 'chat.respond'] as const;
/**
 * 대화 에이전트 모델 경계(D04 §4 chat_agent, 결정안 agent-chat-design-2026-11-12). main 전용이다(루프·도구 실행은 main AgentChat).
 * chat.step {start:{text, frame, profileId}} | {continue:{outputs}} → {kind:'tools', calls} | {kind:'reply', reply}. 처리는 ChatAgent(chat-agent.ts).
 * 오류 bad_text·chat.unavailable·chat.bad_response·chat.bad_tool_output·chat.turn_limit·chat.budget_exceeded·chat.quota_exceeded·chat.input_too_large·chat.secret_rejected.
 */
export const CHAT_AGENT_COMMANDS = ['chat.step'] as const;
/**
 * 세무사 요청 붙여넣기 → 꾸러미 항목 후보(D14 M6-7, ADR-032 결정 8·11). main 전용이다(붙여 넣은 글이 오간다). 규칙 사전만, 모델 없음.
 * 처리는 @sax/bundle BundleService다. 읽기만 하고 DB에 쓰지 않는다. 고른 후보는 bundle.addItem {source:'pasted_request'}로 넣는다.
 */
export const BUNDLE_REQUEST_COMMANDS = ['bundle.requestCandidates'] as const;
/**
 * 사업용 카드 내역 화면(08 D-04, D14 M6-3). 처리는 @sax/bundle BundleService다. 가게 이름·금액·메모가 오가므로 조회까지 main 전용이다.
 * - db.query.card.list {profileId, month}: 그달 행·건별 메모, 마지막 최신화·며칠 전, 그달 덮임(full|partial|none), 다시 잇지 못한 메모.
 * - card.setMemo {profileId, txnId, memo}(빈 글이면 지움), card.reattachMemo {profileId, memoId, txnId}, card.deleteMemo {profileId, memoId}.
 * [최신화] 실행은 여기 없다(플레이북 H-12, M6-1).
 */
export const CARD_READ_QUERIES = ['db.query.card.list'] as const;
export const CARD_COMMANDS = ['card.setMemo', 'card.reattachMemo', 'card.deleteMemo'] as const;
/**
 * 급여대장 직원 입력·"지난달과 같나요?"·급여 기능 켜기(08 D-06, D14 M6-9). 처리는 @sax/bundle BundleService다. 이름·생년월일·주민번호가 오가므로 main 전용이다.
 * - db.query.payroll.carryOver {profileId, month}: 지난달 가장 큰 개정의 과세 수당·차감을 이달 inputs로, 새로 들어온·퇴사한 직원. 읽기만.
 * - db.query.payroll.enabled {profileId}: {enabled, source: setting|employees}. payroll.setEnabled {profileId, on}.
 * - payroll.addEmployee {profileId, employee}, payroll.updateEmployee {profileId, employeeId, patch}: 결과는 가림값(maskedRrn)만, 주민번호 원문 없음.
 * 직원을 지우는 명령은 없다(임금대장 3년 보관, 퇴사는 leftOn).
 */
export const PAYROLL_EMPLOYEE_READ_QUERIES = ['db.query.payroll.carryOver', 'db.query.payroll.enabled'] as const;
export const PAYROLL_EMPLOYEE_COMMANDS = ['payroll.addEmployee', 'payroll.updateEmployee', 'payroll.setEnabled'] as const;
/**
 * 세무사 꾸러미 PC 입력(08 D-05, D14 M6-2·M6-4). 처리는 @sax/bundle BundleService다. 금액·가게 이름·문서 id가 오가므로 main 전용이다.
 * - db.query.cash.month {profileId, month}, cash.put {profileId, day, amount}(source pc), cash.remove {profileId, day}.
 * - db.query.receipt.list {profileId, month}, receipt.confirm {profileId, docId, issuedOn, amount, merchant?, merchantBizNo?}: 사장님이 확인한 값만 대조·내보내기에 쓴다.
 * - bundle.setEntry {profileId, itemId, month, status|null, docIds?, note?}: 해당 없음·파일 칸. 기간은 엔진이 항목 주기로 정한다.
 */
export const BUNDLE_PC_READ_QUERIES = ['db.query.cash.month', 'db.query.receipt.list'] as const;
export const BUNDLE_PC_COMMANDS = ['cash.put', 'cash.remove', 'receipt.confirm', 'bundle.setEntry'] as const;
/**
 * PC 파일을 보관함에 넣기(08 D-05, D14 M6-2·M6-4). main 전용이다(파일 바이트·문서 id가 오간다). 처리는 @sax/bundle PcFileIntake다.
 * - receipt.pcStore {profileId, bytes, format: jpg|png|pdf, ocr?}: 종이 증빙. ocr은 main이 docparse 샌드박스에서 받은 후보(기록만).
 * - bundle.attachFile {profileId, itemId, month, bytes, format, displayName?}: 꾸러미 항목 파일 칸. 그달 표시에 문서를 더한다.
 * 엔진은 파일을 열지 않는다(머리 바이트·크기만). 같은 파일(sha256)은 다시 쓰지 않는다.
 */
export const PC_FILE_COMMANDS = ['receipt.pcStore', 'bundle.attachFile'] as const;
/**
 * 배달앱·오픈마켓 정산내역 넣기(D14 M6-5, J-01·J-02). main 전용이다. 처리는 PC_FILE과 같은 @sax/bundle PcFileIntake다.
 * - settlement.store {profileId, itemId, month, bytes, format: xlsx|csv, parsed, displayName?}: parsed는 docparse SettlementResult. 요약(플랫폼·기간·합계)만 남긴다.
 */
export const SETTLEMENT_COMMANDS = ['settlement.store'] as const;
/**
 * 돈 맞추기 1단계(09, 은행 거래내역 파일·홈택스 발급 목록·받을 돈). 처리는 엔진 bank/service.ts BankService다.
 * 계좌번호·입금자명·금액이 오가므로 조회까지 모두 main 전용이다(렌더러에 열지 않는다). 파일은 main이 docparse 샌드박스로 읽어 다듬은 줄만 보낸다.
 * bank.refresh는 자동 연결 원천(bank/source.ts)으로 최신화를 시작만 하고 돌아온다. 진행은 db.query.bank.refreshStatus로 본다.
 */
export const BANK_READ_QUERIES = ['db.query.bank.accounts', 'db.query.bank.overview', 'db.query.bank.summary', 'db.query.bank.receivable', 'db.query.bank.counterparty', 'db.query.bank.format', 'db.query.bank.refreshStatus'] as const;
export const BANK_COMMANDS = [
  'bank.consent', 'bank.addAccount', 'bank.updateAccount', 'bank.deleteAccount', 'bank.revealAccount', 'bank.setLink', 'bank.refresh',
  'bank.importTxns', 'bank.importInvoices', 'bank.rematch',
  'bank.accept', 'bank.attach', 'bank.detach', 'bank.reject', 'bank.markReceived', 'bank.closeFee', 'bank.ignoreTxn', 'bank.assignTxn', 'bank.setPromised', 'bank.exclude', 'bank.undo',
  'bank.addCpAccount', 'bank.deleteCpAccount', 'bank.revealCpAccount', 'bank.addAlias', 'bank.deleteAlias', 'bank.setPayTerms', 'bank.setDefaultTerms',
] as const;
/**
 * 실행 명령(main → 엔진 중계 통로). 승인·증언은 여기 없다. 게이트 전용 포트로만 다닌다(ADR-021, D01 §2.1). run.inspect는 값 없는 원장 상태·저널 종류(e2e).
 * run.start = H-01 세금계산서, run.startCert {runId, playbookId, inputs} = 홈택스 민원증명(cert.ts CertStartParams, 승인 카드 cert.confirm).
 * run.reverify는 재시작 뒤 원장 in_doubt 행을 발급목록 조회로만 확정한다(run/reverify.ts). 발급·클릭은 없다.
 */
export const RUN_COMMANDS = ['run.start', 'run.startCert', 'run.stop', 'run.inspect', 'run.resume', 'run.manualDone', 'run.reverify'] as const;
/** 실행 이력(재시작 뒤 활동 기록·결과 카드·지난 실행 안내, run-history.ts). main만 부른다. */
export const RUN_HISTORY_QUERIES = ['db.query.runs.history'] as const;
/** 중계 통로로 오면 거부하고 보안 이벤트(security.gate_answer_from_relay)를 남기는 이름. */
export const GATE_ONLY_METHODS = ['gate.answer', 'answerGate', 'attestNotCommitted'] as const;

/** 엔진이 붙을 포털. hometax는 셀렉터가 자리표시인 동안 실행을 거부한다(PoC-3). fixture는 127.0.0.1 가짜 H-01 페이지. */
export type EnginePortal = { kind: 'hometax' } | { kind: 'fixture'; origin: string };

/** main → 엔진 첫 메시지. ports = [금고 포트, 게이트 포트]. root가 없으면 기본 앱 폴더. */
export interface EngineInit {
  t: 'init';
  root?: string;
  portal: EnginePortal;
  /** 앱 판(app.getVersion(), semver). 레지스트리 항목 minAppVersion 대조에 쓴다. 없으면 minAppVersion이 있는 패키지는 받지도 돌리지도 않는다(fail-closed). */
  appVersion?: string;
}

/** 엔진 → main 푸시(중계 통로). 실행 단계·종료. 게이트 요청은 여기로 오지 않는다. */
export interface EngineEvent {
  t: 'ev';
  /** codef: 계좌 자동조회 진행(phase·실패 코드·새 줄 수만) */
  name: 'run' | 'codef';
  data: Record<string, unknown>;
}
