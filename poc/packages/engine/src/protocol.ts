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
