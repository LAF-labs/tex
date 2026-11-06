# ADR-028. 공급망·업데이트·서명 역할: 앱 채널을 레지스트리와 같은 신뢰 수준으로, 5인 팀에서 성립하는 쿼럼

> 상태: 채택(2026-11-03) · 개정: ADR-013(결과 절 배정표·로그 대상), D09 §8.2·§8.3, D11 §2 T13·§4, D12 §6 · 관련: ADR-015 결정 6, D01 §7, [RETRO-2026-11-02](../../../poc/reports/RETRO-2026-11-02.md) A-12·A-14·A-18·B-01
> 2026-11-05 개정: 결정 8(폐기 목록 축소 금지, `registry.revoked_shrunk`)과 서명 바이트 규약 정본 `schemas/SIGNING.md` 가리킴(엔진 PR #52, 팀장 결정).
> 2026-11-06 정합(팀장 지시, 큐 1~15): 결정 2 비고(`requireTransparency`, 패키징 PR #76), 결정 4 비고(Windows 코드서명은 법인 설립 뒤, 그 전 베타는 미서명 빌드·자동 업데이트 보류, yulmu 결정 2026-11-05), 결정 6 갱신 목록에 `@sax/docparse`(docparse PR #78).
> 근거: [AUDIT-D](../../research/AUDIT-D-v13-poc-security.md) N-10·N-32·N-42·N-80(4건) = [D19 §3.5](../19-attack-surface.md) D-02·D-23·D-27·D-50

## 맥락

- 레지스트리 산출물(플레이북·핫픽스·정책)은 2-of-3 하드웨어 쿼럼·투명성 로그·미러 split-view 점검을 받는다. 그 검증의 뿌리(핀 키·`keyEpoch`·BV-06 허용 목록·상한·eTLD+1·바 요약 표)를 바꾸는 앱 업데이트는 `latest.yml` Ed25519 키 1개와 Artifact Signing으로만 서명된다(N-10). ADR-013이 기각한 "CI 1인 서명" 구조가 더 강한 채널에 남았다.
- ADR-013의 "서로 다른 사람" 역할 분리는 초기 5인 팀에서 형식이 된다(N-42). 서명자와 레지스트리·미러·로그 운영자의 분리, 1인 1키, 서명자 기록 규칙이 없다.
- "린트 + CI로 막는다"고 적은 경계가 저장소에 없다(N-32). 린트 범위·CI 부재는 RETRO A-12·B-01이 이미 수용·백로그로 잡았다. 이 ADR은 그 위에 모듈 금지·금고 런타임 차단·필수 체크를 더한다.
- 승인 바 CSS가 앱 밖 `design-system/tokens.json`을 기동 때 읽어 검증 없이 넣는다(N-80). 디자인 저장소 파일 하나로 main이 그린 승인 표시를 가릴 수 있다.

## 결정

1. **앱 매니페스트 키는 CI 밖 하드웨어에 둔다(N-10, D-02).** `latest.yml` Ed25519 키는 비운영자 1인이 하드웨어 토큰에 보관한다. 릴리스 CI는 다이제스트만 만들고 서명 권한이 없다. D09 §8.2 키 표에 "앱 릴리스 매니페스트 키" 행을 더한다.
2. **설치 전에 로그와 미러를 본다(N-10, D-02).** `latest.yml` 다이제스트·설치본 sha512·SBOM 다이제스트를 ADR-013 투명성 로그에 먼저 기록한다. main은 E-14 미러 트리 헤드 비교와 포함 증명을 확인한 뒤에만 electron-updater에 sha512를 넘긴다. electron-updater의 sha512·DN 검사는 2차 방어로 유지한다. 확인하지 못하면 설치본을 유지하고 기존 문구로 알린다.
   - 비고(팀장 결정 2026-11-05, 패키징 PR #76): `@sax/updater`의 `requireTransparency`는 제품 빌드에서 true다. 실계정 시험·베타 빌드만 설정으로 끌 수 있고, 제품 빌드는 그 설정을 무시한다. 레지스트리에 투명성 로그가 아직 없어서, 켜 두면 모든 업데이트가 보류된다(`update.transparency_unverified`).
3. **뿌리를 바꾸는 릴리스만 2-of-3(N-10, D-02).** 핀 키 교체(`keyEpoch`)·내장 허용 목록·앱 내장 상한을 바꾸는 앱 릴리스는 2-of-3 서명을 로그 항목에 동봉한다. 모든 릴리스의 2-of-3은 팀 규모가 허락할 때 한다(검증자 정정 최소안).
4. **외부 단일 키를 고지한다(N-10, D-02).** D11 T13·D19 §8에 "코드서명(Artifact Signing)은 Microsoft가 보관하는 외부 단일 키"를 적는다.
   - 비고(yulmu 결정 2026-11-05): 코드서명은 법인 설립 뒤 Artifact Signing으로 한다. 그 전 베타 설치본은 미서명 빌드로 배포한다. 앱 상단에 "미서명 빌드"를 늘 표시하고, SmartScreen 경고 안내는 D15 F-06과 D12 §8.5에 둔다. 자동 업데이트는 서명 전까지 보류한다(D14 M4-9·P0-13, `apps/desktop/build/SIGNING-SETUP.md`).
5. **역할 규칙(필수, N-42, D-27).** 역할당 1인 1키다. 레지스트리 호스팅·CDN·투명성 로그·미러의 쓰기 권한자는 서명 키를 갖지 않는다. 루트 메타데이터에 키 ID → 보유자 역할 표를 공개해, 로그 항목마다 어느 두 역할이 서명했는지 외부에서 보이게 한다. 2-of-3을 채우지 못하면 핫픽스를 멈추고 CI 서명으로 대체하지 않는다(D12 운영 SLA). ADR-013 결과 절에 인원·역할 배정표를 둔다. 선택 항목(비엔지니어 서명 전 확인 목록, 루트 카드 1장 사외 보관, 미러 운영자 분리·외부 증인 조기 도입)은 SP-4 리허설에서 정한다.
6. **코드 경계는 기계가 지킨다(N-32, D-23).**
   - RETRO A-12(송신 규칙 범위·규칙 단위 면제)에 더한다.
   - `electron`의 `net`, `child_process`(engine·model), `dns`, `worker_threads`를 금지 모듈에 넣는다.
   - engine·model·vault에서 동적 `import()`와, 금지 모듈 이름을 리터럴로 받는 `require`/`createRequire` 호출을 막는다(ajv 로드는 유지).
   - 금고 utilityProcess는 진입점 첫 import에서 `module.registerHooks`로 `net`·`http`·`https`·`tls`·`dgram`·`dns`·`http2`·`electron` 해석을 거부한다.
   - CI(RETRO B-01)는 push·PR 필수 체크로 `--frozen-lockfile` → build → lint → test → `bundles-digest --check` → `pnpm audit --prod`를 돈다.
   - `allowlist.ts`·`profiles/thresholds.json`·`bundles/*.json`에 CODEOWNERS 보안 리뷰를 건다.
   - Renovate로 electron·playwright-core·pdfjs-dist·tesseract.js·better-sqlite3-multiple-ciphers 보안 릴리스를 받는다(`minimumReleaseAge`는 RETRO A-14). `@sax/docparse`(docparse PR #78)도 이 갱신 목록에 올린다. 새 외부 의존은 없다(ajv 8.20.0은 기존 의존, OCR 언어 데이터는 `@tesseract.js-data/kor` 안의 다른 파일).
7. **승인 바 색은 앱 내장이다(N-80, D-50).** `approval-gate.ts`에 내장 팔레트(accent·on-accent·accent-soft·ink·ink-3·surface·line-strong·attention·attention-soft, 라이트·다크)를 둔다. 외부 토큰은 `^#[0-9A-Fa-f]{6}$`와 상태별 글자/배경 대비 ≥ 4.5:1을 통과한 색만 받는다. 하나라도 실패하면 내장 팔레트 전체로 대체하고 `bar.tokens_rejected`를 남긴다. 레이아웃·가시성 규칙은 앱 상수다. 빌드 시 생성기(`tokens.gen.ts`)는 RETRO A-18과 함께 Phase 1 패키징 때 선택한다.
8. **폐기 목록은 축소할 수 없다.** 채택(2026-11-05 팀장). 한 번 폐기된 키는 새 `revoked_keys.json`에서 빠질 수 없다. 엔진은 저장된 목록보다 짧거나 이전 키가 빠진 목록을 `registry.revoked_shrunk`로 거부한다(롤백 방지, 엔진 PR #52, D09 §8.4). 서명 바이트 규약의 정본은 `design/schemas/SIGNING.md`(엔진 트랙 작성)다.

## 대안과 기각 이유

| 대안 | 기각 이유 |
|---|---|
| 모든 앱 릴리스 2-of-3(N-10 원안 (1)) | 5인 팀에서 2주 릴리스가 멈춘다. 뿌리 변경 릴리스만으로 위험의 핵심을 덮는다 |
| Artifact Signing 제거 | SmartScreen·설치 신뢰에 필요하다. 정직 고지로 둔다 |
| 토큰 런타임 읽기 유지 + 이스케이프만 | 대비·가시성 공격이 남는다 |
| 금고 런타임 차단을 `--import` 로더로 | ADR-025 결정 9(`execArgv: []`)와 충돌한다. 진입점 첫 import의 동기 훅으로 한다 |

## 결과

### 보안 영향

| 주체 | 닫는 것 |
|---|---|
| I 운영자·인프라 침해자(릴리스 CI 토큰·매니페스트 키·코드서명 계정 중 하나) | 금고·바·핀 키·허용 목록이 바뀐 설치본의 전 사용자 배포(로그 선기록·미러 확인으로 탐지 가능, 뿌리 변경은 2-of-3) |
| I 내부자 1~2인 | 같은 2~3인 카드 묶음으로 쿼럼 형식화, 운영자가 서명자를 겸해 split-view 은폐 |
| P 의존성·개발자 실수 | 금고·엔진에서 egress 밖 송신 코드 유입, 동적 로드 우회, lockfile 드리프트 |
| 디자인 저장소 변경 | 바 문구를 배경색과 같게 만들어 숨기는 토큰 |

남는 것: 코드서명(Artifact Signing)은 Microsoft가 보관하는 외부 단일 키이고, `latest.yml` 키 보유자는 1인이다. 뿌리 변경 릴리스만 2-of-3이다(D19 §8).

### UX 영향(사용자 화면 문장 그대로)

- 변화 없음. 업데이트는 그대로 자동이다. 검증 실패 때만 기존 문구 "업데이트를 확인하지 못했습니다"가 보이고 지금 설치본으로 계속 쓴다.
- 핫픽스 서명에 비운영자 1인이 들어가 서명 소요가 늘 수 있다. 사용자 쪽 반영 지연은 D12 긴급 status(1인 긴급 키, 하향 전용)가 흡수한다.

### 후속

- M4-7(업데이트)·M4-9(퓨즈→ASAR→서명 순서)·SP-4 리허설·S18 서명 소요 재측정.
- D12 §6 릴리스 절차 갱신. CI 워크플로는 RETRO B-01 순서(A-09·A-10·A-13·A-14 뒤)로 만든다.
- ADR-013 머리말에 개정 메모를 단다. design-system ApprovalBar 설명에 "색은 앱 내장 팔레트가 정본"을 적는다(디자인 시스템 담당).
- 문서 반영: D01 §7, D09 §8.2·§8.3, D11 §2·§4·§8, D12 §6, D19 §8.
