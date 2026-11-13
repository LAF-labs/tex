// 저장 컬럼 ↔ D09 §1.1 "모델 게이트웨이" 행. 시험이 마이그레이션의 실제 컬럼과 이 표가 같은지 본다.
// 본문(프롬프트·응답)·마스킹 전 원문·비밀·사업자번호(진위확인 통과분)는 어떤 테이블에도 없다.
export const GATEWAY_VISIBILITY: Record<string, Record<string, string>> = {
  usage_monthly: {
    account_id: '계정',
    month: '시각(월)',
    input_tokens: '토큰 수',
    output_tokens: '토큰 수',
    cost_micro_usd: 'D09 §3 계량 분리 (1) 결제 레코드의 cost',
  },
  call_records: {
    call_id: '호출 단위 기록 ID(무작위)',
    account_id: '계정(35일 안의 호출 단위 계정 연결 기록)',
    device_id: 'X-Device-Id',
    at: '시각',
    surface: '번들·툴셋 ID',
    input_tokens: '토큰 수',
    output_tokens: '토큰 수',
  },
  ops_stats: { day: '시각(KST 일)', surface: '번들·툴셋 ID', outcome: 'D09 §3 계량 분리 (2) 운영 통계 outcome', n: '호출 수', latency_ms_sum: '지연' },
  run_scopes: {
    scope_hash: 'D09 §1.1 보충: 실행 예산 범위(HMAC(계정·runId), 원문 없음)',
    kind: 'D09 §1.1 보충: 실행·대화 구분',
    l1: 'D09 §1.1 보충: 실행당 L1 사용 수',
    l2_calls: 'D09 §1.1 보충: 실행당 L2 사용 수',
    l2_turns: 'D09 §1.1 보충: 실행당 L2 턴 수',
    agent_calls: '실행당 판정·브라우저 에이전트 호출 수(page_judge·browser_agent)',
    expires_at: 'D09 §1.1 보충: 실행 예산 만료(2시간)',
  },
};
