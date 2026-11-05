// 저장 컬럼 ↔ D09 §1.1 "릴레이" 행. 시험이 마이그레이션의 실제 컬럼과 이 표가 같은지 본다.
// Noise·HPKE 평문, 키, 의도 봉투의 pair_id·seq·exp, 계정·기기와 우편함의 연결, IP는 어떤 테이블에도 없다.
export const RELAY_VISIBILITY: Record<string, Record<string, string>> = {
  mailboxes: {
    mbx_key: '우편함 ID(SHA-256 해시만)',
    read_hash: '능력 토큰 해시(D08 §8 "서버는 해시만 저장")',
    write_hash: '능력 토큰 해시',
    next_seq: '메시지 수(큐 순번)',
  },
  queue: {
    mbx_key: '우편함 ID(해시)',
    seq: '메시지 수(큐 순번)',
    sealed: '암호문 큐(E2E 암호문을 QUEUE_KEY로 한 번 더 봉인, 72시간)',
    bytes: '크기(큐 1MiB 상한 계산)',
    expires_at: '시각(만료, 72시간)',
  },
  mailbox_bundles: { mbx_key: '우편함 ID(해시)', sealed: 'D09 추가 필요: 우편함 번들 슬롯(PC의 Vx 서명 공개 번들, 봉인)' },
  mailbox_quota: { device_id: 'D09 추가 필요: 기기당 우편함 개수(어느 우편함인지 없음)', n: 'D09 추가 필요: 개수' },
  relay_stats: { day: '시각(KST 일, 7일)', kind: '바깥 kind', size_bucket: '크기 버킷', n: '메시지 수' },
};
