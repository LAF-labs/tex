// main ↔ 엔진 메서드 목록(의존성 없음: main이 엔진 코드를 끌어오지 않게 분리).
/** main(스케줄러·UI)이 쓰는 읽기 전용 질의(D07 §1.3 db.query.*). */
export const READ_QUERIES = ['db.query.profiles.list', 'db.query.counterparties.list', 'db.query.counterparties.get', 'db.query.documents.list'] as const;
/** 사용자 동작으로만 오는 명령(렌더러 → main → 엔진). main은 DB를 열지 않는다. */
export const COMMANDS = [
  'profile.upsert', 'profile.delete',
  'counterparty.create', 'counterparty.update', 'counterparty.delete', 'counterparty.verify', 'counterparty.status',
  'bizcert.parse', 'bizverify.setKey', 'bizverify.hasKey',
  'document.import', 'document.update', 'document.file',
] as const;
/**
 * main만 부르는 명령(렌더러에 열지 않는다). 새 명령은 렌더러에 열리는 것이 기본이므로 main 전용이면 여기에 더한다.
 * - bizcert.parse·document.import: main이 docparse 결과를 붙여 부른다(렌더러가 텍스트·바이트를 지어 보낼 수 없다).
 * - document.file: 보관함 파일 경로를 돌려준다(main이 기본 뷰어로 열 때만, 렌더러에는 경로를 주지 않는다).
 */
export const MAIN_ONLY: readonly (typeof COMMANDS)[number][] = ['bizcert.parse', 'document.import', 'document.file'];
