// 저장 컬럼 ↔ D09 §1.1 "푸시 디스패처" 행. 시험이 마이그레이션의 실제 컬럼과 이 표가 같은지 본다.
// 우편함 ID·계정·알림 내용·깨우기 시각은 저장하지 않는다.
export const PUSH_VISIBILITY: Record<string, Record<string, string>> = {
  push_tokens: {
    device_id: 'device_id',
    platform: 'device_id↔푸시 토큰(공급사 구분 apns·fcm)',
    sealed_token: 'device_id↔푸시 토큰(별도 키 PUSH_TOKEN_KEY로 봉인)',
  },
};
