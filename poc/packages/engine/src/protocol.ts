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
  'profile.setPortalLoginId',
] as const;
/**
 * main만 부르는 명령(렌더러에 열지 않는다). 새 명령은 렌더러에 열리는 것이 기본이므로 main 전용이면 여기에 더한다.
 * - bizcert.parse·document.import: main이 docparse 결과를 붙여 부른다(렌더러가 텍스트·바이트를 지어 보낼 수 없다).
 * - document.file: 보관함 파일 경로를 돌려준다(main이 기본 뷰어로 열 때만, 렌더러에는 경로를 주지 않는다).
 * - consent.*·onboarding.*·profile.setPortalLoginId: 온보딩 저장소(db #53). 동의 기록·이어 하기 상태·금고 등록 결과의 포털 로그인 ID는
 *   main의 온보딩 흐름만 쓴다(렌더러가 동의 시각·출처를 지어 보낼 수 없다).
 */
export const MAIN_ONLY: readonly (typeof COMMANDS)[number][] = [
  'bizcert.parse', 'document.import', 'document.file',
  'consent.record', 'consent.latest', 'consent.attach',
  'onboarding.load', 'onboarding.save', 'onboarding.clear',
  'profile.setPortalLoginId',
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
 * 폰 사진·현금 수신(데스크톱 ③c 계약, 팀장 결정 2026-11-06). main 전용이다(렌더러에 열지 않는다). 처리는 @sax/bundle PhoneIntake다.
 * 폰 큐(@sax/remote ReceiveSink)가 엔진 rpc에 얇게 붙는다. 중복은 msgId(receipts.phone_msg_id)로만 보고, 고아 문서·파일을 남기지 않는다.
 */
export const PHONE_COMMANDS = ['receipt.phoneHas', 'receipt.phoneStore', 'cash.phonePut'] as const;
/**
 * 데몬 스냅숏(D10 §3, 팀장 결정 2026-11-06). main 전용 읽기 질의다(렌더러에 열지 않는다). 쓰기·실행·DB 키 노출이 없다.
 * 응답은 @sax/daemon DaemonSnapshot. 처리는 @sax/bundle BundleService(daemonSnapshot)다.
 */
export const DAEMON_READ_QUERIES = ['daemon.snapshot'] as const;
/** 실행 명령(main → 엔진 중계 통로). 승인·증언은 여기 없다. 게이트 전용 포트로만 다닌다(ADR-021, D01 §2.1). run.inspect는 값 없는 원장 상태·저널 종류(e2e). */
export const RUN_COMMANDS = ['run.start', 'run.stop', 'run.inspect'] as const;
/** 중계 통로로 오면 거부하고 보안 이벤트(security.gate_answer_from_relay)를 남기는 이름. */
export const GATE_ONLY_METHODS = ['gate.answer', 'answerGate', 'attestNotCommitted'] as const;

/** 엔진이 붙을 포털. hometax는 셀렉터가 자리표시인 동안 실행을 거부한다(PoC-3). fixture는 127.0.0.1 가짜 H-01 페이지. */
export type EnginePortal = { kind: 'hometax' } | { kind: 'fixture'; origin: string };

/** main → 엔진 첫 메시지. ports = [금고 포트, 게이트 포트]. root가 없으면 기본 앱 폴더. */
export interface EngineInit {
  t: 'init';
  root?: string;
  portal: EnginePortal;
}

/** 엔진 → main 푸시(중계 통로). 실행 단계·종료. 게이트 요청은 여기로 오지 않는다. */
export interface EngineEvent {
  t: 'ev';
  name: 'run';
  data: Record<string, unknown>;
}
