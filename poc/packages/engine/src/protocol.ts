// main ↔ 엔진 메서드 목록(의존성 없음: main이 엔진 코드를 끌어오지 않게 분리).
/** main(스케줄러·UI)이 쓰는 읽기 전용 질의(D07 §1.3 db.query.*). */
export const READ_QUERIES = ['db.query.profiles.list', 'db.query.counterparties.list', 'db.query.counterparties.get', 'db.query.documents.list'] as const;
/** 사용자 동작으로만 오는 명령(렌더러 → main → 엔진). main은 DB를 열지 않는다. */
export const COMMANDS = [
  'profile.upsert', 'profile.delete',
  'counterparty.create', 'counterparty.update', 'counterparty.delete', 'counterparty.verify', 'counterparty.status',
  'bizcert.parse', 'bizverify.setKey', 'bizverify.hasKey',
  'document.import', 'document.update',
] as const;
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
