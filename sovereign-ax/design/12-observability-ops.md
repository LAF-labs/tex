# D12. 관측·운영

## 1. 텔레메트리 (옵트인, 내용 없음)

| 이벤트 | 필드 | 빈도 |
|---|---|---|
| `run.summary` | playbookId@ver, portal, status, totalMs, l1Calls, l2Calls, handoffs, captchaCount, trigger, appVer, os | 실행당 1 |
| `step.fail` | playbookId@ver, stepId, stableId, failedCandidateIdx[], code | 실패당 1 |
| `selector.repair` | playbookId@ver, stableId, proposedKind, verified(bool) | L2 성공당 1 |
| `block.signal` | portal, reason, cooldownHours | 발생당 1 |
| `decide.stats` | bundleId@ver, outcome, confidenceBucket(0.05) | 호출당 1(값 없음) |
| `policy.applied` | policyVer, portal, paceProfile | 세션당 1 |

금지 필드: URL 쿼리, 화면 텍스트, 입력값, 파일명, 이메일, 사업자번호. 송신 전 스키마 검증(허용 필드 외 드롭).

## 2. 대시보드

- 플레이북 건강: 버전별 무인 성공률, 스텝별 실패 급증(개편 감지), 복구율.
- 모델: L2 개입률(목표 ≤ 15/100), 번들별 `unknown` 비율, confidence 분포, 사용자당 비용.
- 운영 기준: 캡차 발생률(목표 ≤ 2/100), 차단 신호 건수, 쿨다운 중 기기 수.
- 비즈니스: 활성화 퍼널, 주간 활성, 데몬 동의율, 리모트 사용률.

## 3. 개편 감지 → 핫픽스 파이프라인 (24시간 SLA)

1. `step.fail` 급증 알림(버전·스텝 단위 임계: 1시간 내 실패율 ≥ 20% 또는 절대 20건).
2. 당직이 스파이크 환경(테스트 사업자)에서 재현, 셀렉터 사전 수정.
3. 리플레이 하네스(D13 §3)로 회귀 → 서명(2인) → `hotfix` 채널 1% → 1시간 관찰 → 100%.
4. L2가 이미 임시 복구한 셀렉터 제안(`selector.repair`)은 후보로 자동 집계되어 당직 화면에 표시된다. 사람이 검토 후 반영.
5. 사용자 UI: "홈택스 화면이 바뀌어 임시로 느리게 동작 중입니다 / 수정이 배포되었습니다" 상태 표시.

## 4. 운영 정책 상수 변경 절차

- `policy.json`은 서명 배포. 변경 사유를 CHANGELOG에 기록(예: "캡차율 상승으로 세션 상한 10→7").
- 긴급 보수화는 당직 1인 + 사후 승인 허용, 완화는 반드시 2인 승인 + 공문 회신 근거.
- `portalMode` 상향(`postprocess → assisted → auto`)은 운영기관 허락 문서(공문 회신·사전협의 완료)가 있어야 하며 변경 로그에 문서 번호를 남긴다. 하향은 차단 신호·제재 통지 시 당직 즉시 가능.

## 5. 지원 도구

- 사용자 "진단 내보내기": 감사 로그(마스킹) + 앱 버전 + 정책 버전 + 최근 실패 스텝. 비밀·본문 없음. 사용자가 확인 후 첨부.
- 원격 지원은 없다(우리가 사용자 PC를 조작하지 않는다). 화면 공유는 사용자가 원할 때 외부 도구로.

## 6. 릴리스 관리

- 앱: 2주 단위 정기 + 긴급. 플레이북: 수시(서명). 정책: 필요시.
- 각 릴리스에 SBOM, 서명, 변경 요약(사용자용 한국어).
