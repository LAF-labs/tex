# D12. 관측·운영

> v1.3 — 공격표면 감사(research/AUDIT-A·B·C, design/19-attack-surface.md) 반영. 바뀐 절에는 근거 ID를 괄호로 붙였다. · AUDIT-D 반영 2026-11-03: 텔레메트리 일 단위 집계·보존 90일(§1~§3), 진단 내보내기 형식 기반 검사(§5), 릴리스 매니페스트 하드웨어 서명·쿼럼 불가 시 핫픽스 중단(§6)(ADR-022·025·026, D19 §3.5).

## 1. 텔레메트리 (옵트인, 내용 없음)

| 이벤트 | 필드 | 빈도 |
|---|---|---|
| `run.daily` | playbookId@ver, portal, date(KST), counts by status(5건 단위 버킷), l1Calls·l2Calls·handoffs·captchaCount(5건 단위 버킷), trigger, appVer, os | **일 1회 로컬 집계**(B-31) |
| `step.fail` | playbookId@ver, stepId, stableId, failedCandidateIdx[], code, hour(시간 단위), count(5건 단위 버킷). 기기 식별자 없음 | 시간 버킷 집계(개편 감지용) |
| `selector.repair.daily` | playbookId@ver, stableId, proposedKind, verified(bool), `proposalDigest`, counts(5건 단위 버킷). 셀렉터 원문 없음 | 일 1회 로컬 집계 |
| `block.signal.daily` | portal, reason(코드) → counts(5건 단위 버킷), cooldownHours | 일 1회 로컬 집계 |
| `decide.stats.daily` | bundleId@ver, outcome, confidenceBucket(0.05), refusedQuestions → counts(5건 단위 버킷) | 일 1회 로컬 집계 |
| `ledger.daily` | playbookId@ver, date(KST), counts by state(armed/dispatched/committed/not_committed/in_doubt/observed_manual, 5건 단위 버킷) | **일 1회 로컬 집계**(B-31) |
| `policy.applied.daily` | policyVer, keyEpoch, portal, paceProfile → counts(5건 단위 버킷) | 일 1회 로컬 집계 |
| `security.daily` | code → counts(5건 단위 버킷) | 일 1회 로컬 집계 |
| `policy.clamped` | policyVer, field(이름만) | 발생당 1(B-23) |
| `registry.health` | statusAgeBucket(<48h/48~72h/>72h), lastIndexVer | 일 1회(B-22) |

- 텔레메트리는 일 단위 집계다. `decide.stats`·`block.signal`·`policy.applied`·`selector.repair`는 `*.daily{counts 5건 버킷}`, `allowlistedSelector`는 원문 대신 `proposalDigest`만, `step.fail`은 개편 감지용 시간 버킷(5건 단위, 기기 식별자 없음), 안전 지표는 `security.daily{code → 5건 버킷}`이다. 보존 90일. 수신 서비스·식별자(날마다 바뀌는 무작위 설치 토큰, 계정·`X-Device-Id` 금지)는 D09 §1이 정본이다(ADR-026, D-24(N-37)).
- v1.1의 `run.summary`(실행당)와 `ledger.state`(전이당)는 폐지했다. 계정별 발급 건수·시간대가 사업자의 거래 규모 대리 지표가 되기 때문이다. 로컬에서 일 단위로 모아 5건 단위 버킷으로 보내고, 시각은 시간 단위로 내린다(B-31).
- 금지 필드: URL 쿼리, 화면 텍스트, 입력값, 파일명, 이메일, 사업자번호, 셀렉터 문자열(예외 없음, `proposalDigest`만), 계정·기기 식별자, 비밀의 길이(A-26). 송신 전 스키마 검증(허용 필드 외 드롭).
- 오류 코드는 D16 체계다. 리모트 프로토콜 오류 코드는 로컬 UI 전용이며 텔레메트리에도 보내지 않는다(C/X-12).
- 게이트웨이 400·409 응답 본문은 입력을 되풀이하지 않는다(코드만). 요청 규범은 [schemas/gateway-request.schema.json](schemas/gateway-request.schema.json)이다(B-20).

## 2. 대시보드

- 플레이북 건강: 버전별 무인 성공률, 스텝별 실패 급증(개편 감지), 복구율.
- 모델: L2 개입률(목표 ≤ 15/100), L2 `click` 제안의 사용자 확인 비율(B-16), 번들별 `unknown` 비율, confidence 분포, 사용자당 비용, 결정적 사전 필터 적중률, 게이트웨이 `pii_tripwire` 건수. **Phase 1 모델 이미지 입력은 0건**이어야 하며 게이트웨이 거부 카운트로 감시한다(B-18).
- 운영 기준: 캡차 발생률(목표 ≤ 2/100), 차단 신호 건수, 쿨다운 중 기기 수, `policy.clamped` 발생, status stale 기기 비율.
- 안전: `security.daily`의 `security.commit_payload_mismatch`, `step.commit_shadow`, `step.identity_mismatch`, `commit_guard.unclassified`, `ledger.observed_manual` 비율(일 집계 기준). 경로 패턴은 보내지 않는다.
- 비즈니스: 활성화 퍼널, 주간 활성, 데몬 동의율, 리모트 사용률.

## 3. 개편 감지 → 핫픽스 파이프라인 (Phase 1~2: 영업일 1일 임시 조치·3영업일 핫픽스, 전담 인력 채용 후 24시간)

1. `step.fail` 급증 알림. 개편 감지 임계는 '일 20건 이상'이다(버전·스텝 단위, 시간 버킷은 급증 시점 파악용, D-24(N-37)).
2. 당직이 스파이크 환경(테스트 사업자)에서 재현하고 셀렉터 사전 수정안을 만든다.
3. **범위 확인**(B-01, ADR-012): 수정안이 D02 §2.2의 핫픽스 범위(적격 항목의 `candidates` 교체, `commitEndpoints` 추가)를 벗어나면 핫픽스가 아니라 정식 버전 + 전체 리플레이로 간다. `commits`·`commitEffect`·`secretSlot`·`closeAffordance`·`readbackOf`·`fieldKey`·`role`·`namePattern`·`landmark`·`frame`·`expect`·`navigationOnly`·`allowedConstants`와 IR 본문, 조회 하위 플레이북은 핫픽스 대상이 아니다. 적격 항목이라도 랜드마크 항목, IR의 `decide.scope`·조건식·`rowLabel`·`readback.fields`·`signFlow.confirmTarget`이 참조하는 항목, 커밋 구간 W(X) 안 스텝이 참조하는 항목은 핫픽스로 바꿀 수 없다(E-03).
4. **적용 전 재검증**(레지스트리 핫픽스 CI): (IR + 핫픽스 반영 사전)에 V-01~V-24와 SV-01~SV-06을 돌린다. SV는 여기서만 돈다(클라이언트는 다시 돌리지 않음, 정본 D03 §3.1-6). SV-01(충돌)·SV-04(랜드마크 유일성)는 이번 개편 화면의 새 녹화 DOM·HAR로 돌린다. 리플레이 하네스(D13 §3) 회귀도 통과해야 한다.
5. **서명과 결속**: 핫픽스 파일([schemas/hotfix.schema.json](schemas/hotfix.schema.json))의 `appliesTo.packageDigest`를 대상 패키지의 정확한 다이제스트로 채우고, 서로 다른 사람이 각자 승인한 **2-of-3 서명**을 받는다(B-22). 키 운영은 D09 §8·ADR-013. 2-of-3 절차의 소요 시간이 SLA에 주는 영향은 확인 필요(S18).
6. `hotfix` 채널 1% → 1시간 관찰 → 100%. 클라이언트는 로드 시 스키마·V-01~V-24와 적격 조건을 다시 검사하고 실패하면 거부하며, 실행 중에는 R-A1·R-A2·`DENY_ACTION_NAME` 검사를 매번 한다(D03 §3.1·§5.2). 핫픽스 다이제스트는 게이트 토큰의 `packageDigest`에 들어가므로 적용 시 진행 중 실행의 토큰은 폐기된다.
7. 사용자 UI: "홈택스 화면이 바뀌어 임시로 느리게 동작 중입니다 / 수정이 배포되었습니다" 상태 표시.

### 3.1 L2 제안의 집계 (B-17)

- 집계는 `proposalDigest`(제안 셀렉터의 해시)만 올린다. 셀렉터 원문은 허용 속성 셀렉터라도 보내지 않는다(ADR-026, D-24(N-37)). 같은 다이제스트가 여러 기기에서 모이면 당직이 테스트 사업자 환경에서 같은 제안을 재현한다.
- `role`+이름 셀렉터는 이름의 해시만 올린다.
- 결정적 사전 필터(D04 §3, B-15)에 걸린 실행의 제안과 `risk_flags`가 붙은 제안은 집계에서 뺀다.
- 집계는 당직 화면의 **참고 후보**일 뿐이다. 당직은 테스트 사업자 환경에서 재현한 뒤에만 반영하고, 반영은 위 3~6단계를 그대로 거친다. 여러 사용자의 L2를 같은 잘못된 셀렉터로 유도하는 오염(제3자 텍스트)을 전제로 한다.

## 4. 운영 정책 상수 변경 절차

- `policy.json`은 서명 배포. 변경 사유를 CHANGELOG에 기록(예: "캡차율 상승으로 세션 상한 10→7").
- 정책 신선도 만료는 발행 후 **72시간 이하**다(C-26). 내용 변경이 없는 재발행은 **온라인 타임스탬프 키(국내 HSM 안, 자동)**가 48시간마다 `timestamp` 서명으로 하고(사람 쿼럼 불필요, E-05), 내용 변경은 2-of-3 서명이다. 타임스탬프 재서명이 60시간 넘게 안 되면 당직에게 경보한다. 신선도를 잃은 클라이언트는 마지막 유효 정책 유지 + 완화 금지 + 데몬 중지 + 핫픽스 로드 거부로 동작하고, 만료 후 168시간(7일)이 지나면 전 포털 `postprocess`로 내려가므로 그 전에 복구하는 것을 운영 목표로 둔다. `status.json`도 같은 타임스탬프 키가 48시간마다 재서명한다.
- 긴급 보수화는 당직 1인이 **긴급 키**로 서명할 수 있으나, 클라이언트는 정책의 **모든 필드**가 보수 방향인 정책만 받는다(D03 §7.1 필드별 표, C-26, E-04). 사후 2인 승인 기록을 남긴다. 긴급 키로 하향한 `status.json`은 72시간 뒤 자동 만료되므로 유지하려면 그 안에 2-of-3으로 재확인한다. 완화는 반드시 2-of-3 서명 + 공문 회신 근거.
- 정책 값은 앱 내장 상한·하한(`PORTAL_MODE_CEILING`·`CAPTCHA_RELAY_CEILING`·`POLICY_FLOOR`)으로 잘린다(B-23). 따라서 정부24 등 `postprocess` 상한 포털의 `portalMode` 상향은 운영기관 허락 문서(공문 회신·사전협의 완료)를 근거로 **앱 업데이트**로 상한을 올린 뒤에만 가능하고, 변경 로그에 문서 번호를 남긴다. 하향은 차단 신호·제재 통지 시 당직이 정책 또는 레지스트리 status(48시간 만료)로 즉시 할 수 있다.
- 서명 키 세대(`keyEpoch`)를 바꿀 때는 앱 업데이트로 새 공개키를 핀 고정하고, 버전 비교는 새 세대 안에서 다시 시작한다(C-26).

## 5. 지원 도구

- 사용자 "진단 내보내기": 감사 로그(마스킹) + 앱 버전 + 정책 버전 + 최근 실패 스텝. 비밀·본문 없음. 사용자가 확인 후 첨부. 내보내기 전에 누출 스캐너 규칙(테스트 패턴 + 인코딩 변형)을 로컬에서 실행하고, 로그는 14일만 보존한다(A-21, D05 §8). 진단 내보내기는 형식 기반 2차 검사(사업자번호·승인번호·이메일·`sk-` 접두·10자리 이상 숫자열·긴 base64/hex 토큰)를 하고, 걸린 줄을 지운 뒤 사용자에게 보여 준다(Phase 1, ADR-022, D-11(N-17)). 내보내기 직전 `RunJournal.verify`로 체인을 확인하고 불일치를 번들에 표시한다(D03 §9, D-45(N-71)).
- 원격 지원은 없다(우리가 사용자 PC를 조작하지 않는다). 화면 공유는 사용자가 원할 때 외부 도구로.

## 6. 릴리스 관리

- 앱: 2주 단위 정기 + 긴급. 플레이북: 수시(2-of-3 서명). 정책: 타임스탬프 키 48시간 주기 자동 재서명 + 내용 변경 시 2-of-3. 번들 정의는 앱 릴리스에만 포함된다(BV-06).
- 각 릴리스에 SBOM, 서명, 변경 요약(사용자용 한국어).
- 릴리스 CI는 `latest.yml` 다이제스트만 만든다. 보유자가 하드웨어 키로 서명하고 투명성 로그에 기록한 뒤 배포한다. 2-of-3 서명을 채우지 못하면 핫픽스를 멈춘다(운영 SLA, CI 서명 대체 금지)(ADR-025, D-02(N-10), D-27(N-42)).
- 앱 업데이트는 실행 중·커밋 구간·데몬 실행 중에는 설치되지 않는다(D03 §2, A-29).

## 7. 보안 공지 추적 (A-11)

- 당직은 KISA 보호나라 보안 공지와 포털이 요구하는 보안 모듈(키보드 보안·전자서명 모듈 등)의 취약점 공지를 주 1회 확인하고, 확인 기록을 남긴다.
- 영향이 있으면 금고의 확장 허용 목록(`vault.extensionAllowlist`, 앱 내장)과 설치 안내를 **앱 업데이트**로 고친다. 설치 안내는 운영기관 공식 배포처만 가리킨다.
- Electron·Chrome·Playwright·`electron-updater`의 보안 릴리스도 같은 주기로 추적해 긴급 릴리스 여부를 정한다.
