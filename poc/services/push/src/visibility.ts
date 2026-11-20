export const PUSH_VISIBILITY: Record<string, Record<string, string>> = {
  push_tokens: {
    device_id: 'device_id',
    platform: 'device_id↔푸시 토큰(공급사 구분 apns, apns_dev, fcm)',
    sealed_token: 'device_id↔푸시 토큰(별도 키 PUSH_TOKEN_KEY로 봉인)',
  },
};
