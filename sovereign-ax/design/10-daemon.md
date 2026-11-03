# D10. 서류 데몬

> AUDIT-D 반영 2026-11-03: 데몬의 사람 비밀 미사용을 trigger 허용 목록으로, `semi_auto` 로그인은 폰 시작 게이트 뒤에만 저장 자격 사용(§6)(ADR-022·023·026, D19 §3.5 D-01·D-34).
> v1.3 — 공격표면 감사(research/AUDIT-A·B·C, design/19-attack-surface.md) 반영: 데몬 실행은 키체인 저장 비밀을 쓰지 않음(금고가 `typist.fill` 거부), 효과 제한을 트리거 기준 런타임 검사(R-D1)로, 동의 결속(`consent_json`)과 시작 동의 메시지 분리(`consent.request/response`, `SAX-consent-v1`), `policy.daemon.autoAllowed` 이름 통일, 데몬은 AIK를 쓰지 않음, 스케줄러는 DB 키 없이 엔진 질의 IPC 사용, 추출 만료일 확정 조건.

## 1. 책임

만료 추적, 알림, 사용자가 등록한 서류의 주기적 재발급을 **사용자 동의 수준에 맞게** 수행한다. 새 종류의 작업을 만들지 않는다.

## 2. 동의 수준

| 모드 | 조건 | 동작 | 플랜 | 출시 |
|---|---|---|---|---|
| `notify` | 기본 | D-7, D-1 알림(데스크톱·폰). 사용자가 "지금 갱신" 탭 → 일반 실행 | 스타터 | Phase 1 |
| `semi_auto` | 사용자가 서류별 동의(§2.1 결속) | 예정 시각에 폰·데스크톱으로 "갱신 시작할까요" **시작 동의**(`consent.request`/`consent.response`, 토큰 아님) → 실행 → 로그인(간편인증 PUSH는 사용자가 승인, 또는 폰 봉인 비밀) → 비가역 직전 **커밋 게이트**(`gate.request`, 건별 토큰, 폰 승인 한 번) | 비즈니스 | Phase 2 |
| `auto` | 서류별 동의 + `StandingAuthorization` + 법률 의견 플래그(`policy.daemon.autoAllowed`) **그리고 앱 빌드 플래그** + 사람 없이 끝나는 로그인 경로 존재 | 예정 시각에 무인 실행. 엔진이 `StandingAuthorization{scheduleId, playbookId@major, docType, profileId, maxPerPeriod, expiresAt, userSignature}`에서 **건별 단일 사용 토큰**을 만든다 | 비즈니스 | **보류** |

`auto`를 보류하는 이유: 홈택스 공동인증서 경로는 가상키패드(사용자 직접 입력), 간편인증은 폰 승인이 필요해 **사람 없이 로그인이 끝나지 않는다**(D05 §4). 데몬은 키체인에 저장된 비밀도 쓰지 않는다(§6). 정부24는 허락 전 후처리 모드다. 사람 없이 끝나는 로그인 경로가 생기고 법률 의견이 나오면 운영 정책으로 켠다. 엔진은 `schedules.mode='auto'` 행을 정책 `policy.daemon.autoAllowed`와 앱 빌드 플래그가 **모두** 참일 때만 실행한다(현재 스키마는 `autoAllowed: const false`이므로 항상 거부). (B-27, B/C-10)

**효과 제한 R-D1** (B-27): `trigger=daemon`이면 엔진이 실행 직전에 `manifest.effects ⊆ {issue_document}`를 **런타임에 검사**한다. IR의 `pacing.profile`과 무관하다. 위반하면 실행하지 않고 `daemon.effects_denied`를 남긴 뒤 `notify`로 강등한다. `send`·`pay`·`sign`이 있는 플레이북은 어떤 모드에서도 데몬이 실행하지 않는다. (D02 V-14와 D03 §12의 규칙 문구는 이 런타임 검사를 따른다.)

### 2.1 동의 결속과 메시지 분리 (B-27)

- 동의 객체 `schedules.consent_json`의 형식은 `{playbookId, major, effects[], docType, profileId, consentedAt, deviceSig}`로 고정한다(D07 DDL, 스키마는 해당 문서 담당). `deviceSig`는 동의를 받은 기기의 서명이다.
- 실행 직전 설치된 패키지의 `major`나 `effects`가 동의 객체와 다르면 실행하지 않고 `notify`로 강등한 뒤 재동의를 받는다.
- **시작 동의는 커밋 승인과 다른 메시지다.** 시작 동의는 `consent.request`/`consent.response`, 응답 서명 문맥은 `"SAX-consent-v1"`이다. 커밋 게이트는 `gate.request`/`gate.response`와 `"SAX-approve-v1"`을 쓴다. `gate.response` 검증기는 `consent.*` 응답을 절대 받지 않는다(습관화·구현 버그로 시작 동의가 커밋 승인으로 처리되는 것을 막는 도메인 분리). 봉투 스키마(`remote-envelope.schema.json`)는 해당 문서 담당이다.

## 3. 스케줄러

- `main` 프로세스, 1분 틱, 조건 확인 후 엔진에 `trigger: 'daemon'`으로 실행 요청. `main`은 DB 키를 갖지 않는다. 일정은 엔진의 **읽기 전용 IPC 질의**(`db.query.schedules`)로 읽는다(DB 소유 프로세스는 엔진 하나, D05 §2). (A-24, A/C-08)
- 실행 조건: 실행 창 안(요일·시간대), PC 유휴(사용자 입력 없음 5분 이상) 또는 사용자 허용, 네트워크 OK, 쿨다운 아님, 포털별 동시 실행 없음, 일일 상한 여유, R-D1 통과, 동의 결속 일치(§2.1).
- 시각 지터·간격·유예·재시도 상수는 서명된 `policy.daemon`에서 온다(±30분, 5~15분, 10분, 30분).
- 실패: 직전 실행에 `in_doubt` 원장이 있으면 재시도하지 않고 `notify`로 강등. 그 외 1회 재시도(`policy.daemon.retryAfterMin`), 그래도 실패 → `notify` 강등 + 알림 + 원인 코드.
- PC 꺼짐으로 놓침: 다음 기동 시 "놓친 갱신 N건" 카드 → 사용자가 실행 선택. 자동 모드라도 기동 직후 자동 실행은 하지 않는다(사용자가 막 켠 PC에서 브라우저가 튀어나오는 경험 방지, 10분 유예).

## 4. 만료 계산

- `documents.expires_at` 우선(문서 추출값). 추출값은 `doc_meta_check_v1`(후보 선택형, D04 §3)이 `ok`일 때, 즉 규칙표 값과 30일 이내일 때만 자동 확정한다. 30일 넘게 차이 나거나 `none_found`·`unknown`이면 사용자 확인 전까지 `validity_rules` 값을 쓴다(PDF 숨김 텍스트로 만료일을 오염시켜 재발급을 반복시키는 경로 차단, B-15). 없으면 `validity_rules`.
- `next_due_at = expires_at - lead_days`(기본 7, 사용자 조정). 제출 예정일 입력 시 그 날짜 기준.
- 중소기업확인서처럼 회계연도 규칙은 `fiscal_year_rule` 평가기: 직전 사업연도 말일 + 3개월 + 1년 − lead.

## 5. UX 원칙

- 데몬 실행 중에는 트레이 아이콘 상태 + "지금 자동 갱신 중: 지방세 납세증명(중단 가능)" 토스트.
- 브라우저 창은 최소화 상태로 시작하되 사용자가 언제든 볼 수 있다. 숨김 창·가상 데스크톱 트릭은 쓰지 않는다.
- 실행 결과는 알림 1회 + 감사 로그.

## 6. 안전장치

- 데몬 실행은 `policy.pace.daemon`(더 느림) 적용.
- **저장 비밀 미사용** (A-23): 데몬 실행(`trigger:'daemon'`)은 키체인에 저장된 비밀을 쓰지 않는다. 로그인은 간편인증 PUSH 또는 폰 봉인 비밀(`fillFromRemote`, 라이브 세션)만 쓴다. 금고는 `trigger=daemon` 실행의 `typist.fill`을 `denied`로 거부한다(D05 §4). 유휴 시간에는 Hello 프롬프트를 받을 사람이 없으므로, 이 규칙이 없으면 구현 단계에서 사람 비밀을 무인 등급에 저장하게 되어 같은 사용자 악성코드가 조용히 읽을 수 있는 비밀이 늘어난다.
- 데몬은 사람 비밀을 쓰지 않는다. 금고는 `typist.fill`을 `trigger ∈ {local, remote}`에만 허용하므로 `daemon`은 fail-closed로 거부된다. `semi_auto`의 로그인은 폰 시작 게이트(생체 + 기기 키 서명, D08 §7) 뒤에만 저장 자격을 쓴다(ADR-023·026, D-01(N-07), D-34(N-13)).
- **AIK 미사용** (감사 C C-22): 데몬은 AIK를 쓰지 않는다. AIK가 필요한 작업(기기 추가·폐기·삭제·KEK 회전)은 데몬 실행에서 일어나지 않으며, 금고는 `trigger=daemon` 문맥의 AIK 서명 요청을 거부한다.
- 캡차·추가 인증이 뜨면 `semi_auto`와 동일하게 사람에게 넘긴다(폰). 90초 무응답 → 보류.
- 같은 서류를 30일 내 3회 이상 자동 재발급 시도하면 자동 모드 해제 + 알림(루프 방지).
