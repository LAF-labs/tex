# H-01 게시 — 사용자 단계

운영 레지스트리(`https://tax.laf-co.com`)에 H-01 전자세금계산서 발급 패키지와 정책을 처음 게시하는 절차다. 한 자리에서 Touch ID 12번으로 끝난다. 엔진 PR-D2(패키지 받기·저장·`loadPackage`)가 이 패키지를 받는다.

근거:
- 팀장 지시 2026-11-09
- D09 §8, D03 §7.1, ADR-013·023·025·028·037·043
- [CEREMONY.md](CEREMONY.md) §5·§6·§9
- [API.md](API.md) "게시 PUT"

도구:
- 게시 CLI `services/registry/src/publish/cli.ts`(아래 `publish`)

  ```bash
  node --conditions=development services/registry/src/publish/cli.ts <명령> …
  ```

- 서명 CLI는 서명 의식 때 쓴 `ceremony sign` 그대로다. 게시 도구는 서명하지 않는다. 키를 갖지 않고, 서명할 명령만 출력한다.
- 시험은 `tests/registry-publish.test.ts`다. 로컬 레지스트리(가짜 S3)로 끝까지 돌고, 서명은 공개 시험 키로 한다.

## 무엇이 올라가나

한 자리에서 끝낸다. 순서는 **패키지 서명(package 2-of-3) → 정책 서명(policy 2-of-3) → 게시**다(팀장 지시 2026-11-09).

| 순서 | 경로 | 서명 | Touch ID |
|---|---|---|---|
| 1 | `packages/hometax.invoice.lookup@1.0.0.sxp`·`hometax.invoice.email_status@1.0.0.sxp`(조회) | manifest에 패키지 키 2개씩 | 4번 |
| 2 | `packages/hometax.invoice.issue@2.1.0.sxp`(H-01) | manifest에 패키지 키 2개 | 2번 |
| 3 | `policy/2026.11.json`·`policy/current.json`(같은 바이트, monotonic 1) | 내용에 정책 키 2개 + 타임스탬프(서버) | 2번 |
| 4 | `registry/status.json`(monotonic 1) | 정책 키 2개 + 타임스탬프(서버) | 2번 |
| 5 | `registry/revoked_keys.json`(monotonic 1) | 루트 2개(서명 의식 2026-11-06에 이미 함, `ceremony/keyepoch-1/revoked_keys.signed.json`) + 타임스탬프(서버) | 0번 |
| 6 | `registry/stable/index.json`(monotonic 1) | 내용에 패키지 키 2개 + 타임스탬프(서버, ADR-043) | 2번 |

- Touch ID는 모두 **12번**이다. 3단계에서 10번(패키지 6 → 정책 2 → status 2), 5단계에서 2번(인덱스)이다. 키체인 키는 그대로이고 새 키를 만들지 않는다.
- 게시는 6단계 push 한 번에 8건이다(폐기 목록 → 정책 2건 → status → 패키지 3개 → 인덱스).
- 폐기 목록과 status가 함께 올라가는 이유: 엔진은 24시간 안의 폐기 목록이 없으면 새 패키지를 받지 않는다. status가 없으면 데몬이 멈춘다(`daemon_stop`).
- 정책이 함께 올라가는 이유: 정책이 없거나 낡으면 엔진은 홈택스도 후처리(postprocess)로만 돈다(D03 §7.1, fail-closed).
- 올린 뒤 폐기 목록(24시간)·정책·status·인덱스(48시간)는 서버 cron이 timestamp-1 키로 자동으로 다시 서명한다. 사람은 내용이 바뀔 때만 서명한다(ADR-043, 팀장 결정 2026-11-06·2026-11-09).
- status 상한은 `hometax: auto`다(팀장 결정 2026-11-09, #234 뒤 정정).
  - 엔진은 실효 수준이 auto가 아니면 자동 실행을 거부한다(#234). assisted로 바꿔 돌리는 실행이 아직 없기 때문이다.
  - 그래도 되돌릴 수 없는 스텝은 매번 사람 승인 카드를 거친다. 커밋 뒤 verify와 서버 긴급 정지(`killPlaybooks`, 상한 하향)는 그대로 남는다.
- **H-01 셀렉터는 실제 화면 미대조다. 첫 실기기 실행에서 확인한다**(ADR-025). 틀리면 판을 올려(2.1.1 등) 다시 게시한다. 이번 게시 판은 2.1.0 그대로다.

### 정책 2026.11

원본은 `services/registry/policy/2026.11.json`이다. 서명 대상은 이 파일에 `monotonic`·`keyEpoch`를 붙인 내용이다. 기간과 타임스탬프는 서버가 붙인다.

- `portalMode`: `hometax: auto`, 나머지(`gov24`·`wetax`·`sminfo`·`insure4`)는 `postprocess`다. status 상한과 같다.
- 홈택스 요청률 상한은 ADR-025의 PoC 값이었다.
  - 프로필당 하루 실행 20회, 되돌릴 수 없는 실행 1회, 하루 로그인 3회, 차단 신호 1번이면 쿨다운
  - 그 밖의 값(로그인 세션당 15회, 분당 이동 12회, 로그인 실패 2회, 동시 1)은 정책 예시(SIGNING.md) 그대로다.
- 이번 게시에 없는 포털(`gov24`·`sminfo`·`insure4`)은 실행 상한이 0이다. 캡차 중계는 모두 `disabled`다. 원격 승인의 하루 되돌릴 수 없는 실행은 1회다.
- 내용을 바꾸려면 `version`을 올린다(예 `2026.11.1`). 같은 판에 다른 내용은 `publish.policy_version_exists`로 거부된다.

### 정책 2026.11.1

원본은 `services/registry/policy/2026.11.1.json`이다. 대표 결정(2026-11-12) "우리가 설정한 상한은 웬만해선 닿지 않게"에 따라 사용량 상한만 바꿨다.

- 엔진은 받은 정책과 앱 내장 값 가운데 필드마다 엄격한 쪽을 쓴다(`stricterRate`). 그래서 홈택스 상한은 앱 내장 값(`HOMETAX_POLICY`)과 같게 했다. 더 높여도 효과가 없다.
  - 하루 실행 100회, 하루 발급 50회, 로그인 세션당 30회, 하루 로그인 12회, 양성 탐지 2번이면 쿨다운(24시간). 모두 정책 스키마 최대값이다.
- 원격 승인의 하루 되돌릴 수 없는 실행은 5회다(스키마·앱 하한 최대). 지금은 제품 코드가 이 값을 쓰지 않는다.
- 그 밖의 필드(포털 수준·캡차 중계·지연·verify·run·retries·daemon·queue, 분당 이동 12회, 로그인 실패 2회)는 2026.11 그대로다. 시험 `tests/registry-publish.test.ts`가 바뀐 필드 목록을 고정한다.

## 0. 준비

- 서명 의식을 한 맥이어야 한다. 키체인 키 11개와 도우미 `~/.sax/bin/sax-keychain`이 있어야 한다. **도우미를 다시 빌드하지 않는다.**
- 저장소 `poc/`에서 main 최신으로 돌린다.
  - 첫 게시 도장(#229)·인덱스 신선도 분리(ADR-043, #232)·정책 묶기가 main에 있고 **운영에 배포된 뒤**여야 한다. 배포 전이면 폐기 목록·status·정책·인덱스가 `registry.schema_invalid`·`registry.timestamp_invalid`로 거부된다.
  - 원본은 `packages/engine/playbooks/<패키지 id>/`다(엔진 #231·#237). H-01은 `hometax.invoice.issue`, 조회 패키지 2개는 `hometax.invoice.lookup`·`hometax.invoice.email_status`다.
- 운영자 토큰(`REGISTRY__REGISTRY_ADMIN_TOKEN`의 값)을 비밀번호 관리자에서 꺼낼 수 있어야 한다.
  - 6단계에서 터미널이 보이지 않게 묻는다. 명령 인자·셸 기록·파일에 넣지 않는다.
- 작업 폴더는 저장소 밖에 둔다(예 `~/sax-publish/h01-1`).
  - 공개 산출물과 서명 기록만 들어간다. 비밀은 없다.
  - 단계마다 새 파일만 쓰고 덮어쓰지 않는다. 다시 할 때는 새 폴더 이름을 쓴다.

## 1. dry-run (Touch ID 없음, 운영에 쓰지 않음)

```bash
node --conditions=development services/registry/src/publish/cli.ts dry-run --registry https://tax.laf-co.com --work ~/sax-publish/h01-dry --trust services/registry/ceremony/keyepoch-1/trust-root.json --revoked services/registry/ceremony/keyepoch-1/revoked_keys.signed.json --policy services/registry/policy/2026.11.json --ceiling hometax=auto packages/engine/playbooks/hometax.invoice.lookup packages/engine/playbooks/hometax.invoice.email_status packages/engine/playbooks/hometax.invoice.issue
```

- 운영 레지스트리는 **읽기만** 한다(GET). 서명은 메모리 안 임시 키로 하고, 게시는 이 맥 안의 임시 로컬 레지스트리에만 한다.
- 화면은 아래와 같다.
  - `dry-run 1/2: …` 아래에 패키지 3줄이 나온다. 각 줄에 manifest 다이제스트와 확인 코드가 있다.
  - 이어 `policy monotonic 1 확인 코드 …`, `status monotonic 1 확인 코드 …`가 나온다.
  - 마지막에 `리허설: 임시 키 서명 14번, 게시 8건(…), 되읽기·로그 포함 증명 통과`가 나오고, 이어 `dry-run 끝`이 나온다.
- 2026-11-09 운영에 돌린 결과다. 소스가 바뀌면 확인 코드도 바뀐다. 원본 위치 이동(엔진 #231)은 내용을 바꾸지 않으므로 코드도 같다.

  | 문서 | 확인 코드 |
  |---|---|
  | `hometax.invoice.lookup@1.0.0` | `5935-5dd9-0788-f815-39eb-b5f3-f9e8-48c3` |
  | `hometax.invoice.email_status@1.0.0` | `8f91-2f81-f1ea-92c9-7591-aa92-3a38-3113` |
  | `hometax.invoice.issue@2.1.0` | `2bb4-aa6f-1263-b286-142a-e36e-3440-54da` |
  | 정책 `2026.11` monotonic 1 | `955a-eddc-7af1-6b3a-b4d3-c67a-e90e-9260` |
  | status monotonic 1(`hometax: auto`) | `9977-02fe-4c56-1b92-134f-715c-ec6a-d1d7` |

- 오류가 나면 여기서 멈추고 팀장에게 알린다. 코드는 아래 "실패하면" 표에 있다.

## 2. prepare (Touch ID 없음)

dry-run과 같은 인자에 `prepare`, 새 작업 폴더를 준다.

```bash
node --conditions=development services/registry/src/publish/cli.ts prepare --registry https://tax.laf-co.com --work ~/sax-publish/h01-1 --trust services/registry/ceremony/keyepoch-1/trust-root.json --revoked services/registry/ceremony/keyepoch-1/revoked_keys.signed.json --policy services/registry/policy/2026.11.json --ceiling hometax=auto packages/engine/playbooks/hometax.invoice.lookup packages/engine/playbooks/hometax.invoice.email_status packages/engine/playbooks/hometax.invoice.issue
```

- 화면
  - 확인 코드 5개가 dry-run과 같아야 한다. 다르면 멈춘다.
  - `revoked_keys monotonic 1: 루트 2개 서명이 이미 있다`
  - `다음: 서명 10번(Touch ID)` 아래에 `ceremony … sign` 명령 10줄. 순서는 패키지 6줄(`--kind manifest`) → 정책 2줄(`--kind policy`) → status 2줄(`--kind status`)이다.
- 이 단계에서 엔진 로더 연습을 한다. 임시 키로 서명해 `loadPackage`를 돌린다(번들 허용 목록, 조회 다이제스트, 정적 검증, 승인 바 요약). 정책 초안은 엔진 정책 스키마로 본다. 통과하지 않으면 서명할 것을 내놓지 않는다.

## 3. 서명 10번 (Touch ID 10번: 패키지 6 → 정책 2 → status 2)

화면에 나온 `sign` 명령을 위에서부터 한 줄씩 그대로 실행한다. 아래는 첫 줄의 모양이다.

```bash
node --conditions=development services/registry/src/ceremony/cli.ts sign --kind manifest --key-id package-1 --confirm 5935-5dd9-0788-f815-39eb-b5f3-f9e8-48c3 --trust services/registry/ceremony/keyepoch-1/trust-root.json --out ~/sax-publish/h01-1/sig/hometax.invoice.lookup@1.0.0.package-1.json ~/sax-publish/h01-1/manifests/hometax.invoice.lookup@1.0.0.json
```

| 줄 | 키 | 문서 | Touch ID |
|---|---|---|---|
| 1–6 | `package-1`·`package-2` | 패키지 manifest 3개 | 6번 |
| 7–8 | `policy-1`·`policy-2` | 정책 `docs/policy.json` | 2번 |
| 9–10 | `policy-1`·`policy-2` | status `docs/status.json` | 2번 |

- 명령마다 Touch ID 창이 뜬다. **창의 확인 코드가 명령의 `--confirm` 값과 같은지 보고** 누른다(CEREMONY.md §1 "남는 위험").
- 화면에 `서명 기록 package-1 → …`이 나온다.
- 순서를 바꿔도 결과는 같다. 같은 명령을 두 번 돌리면 `EEXIST`로 멈춘다. 이미 된 것이니 다음 줄로 간다.

## 4. assemble (Touch ID 없음)

```bash
node --conditions=development services/registry/src/publish/cli.ts assemble --trust services/registry/ceremony/keyepoch-1/trust-root.json --work ~/sax-publish/h01-1
```

- 서명을 모은다. 문서마다 서로 다른 키 2개여야 하고, 같은 키 두 번이나 다른 문서의 서명은 거부한다.
- `.sxp`를 묶고, **실제 서명으로** 관문 규칙(`verifySxp`)과 엔진 로더(`loadPackage`)를 다시 돌린다.
- 화면
  - `묶음: 패키지 3개(엔진 로더·관문 규칙 통과, 실제 서명)`
  - `인덱스 stable monotonic 1, 항목 3개(기간은 서버가 붙이고 다시 서명한다)`
  - `인덱스 확인 코드 …`
  - 아래에 `sign --kind index` 명령 2줄
- 인덱스 초안에는 `issuedAt`·`expiresAt`이 없다. 사용자가 서명하는 것은 항목·monotonic뿐이고, 기간은 6단계에서 서버가 붙인다. 그래서 5·6단계를 서두를 필요가 없다.

## 5. 인덱스 서명 2번 (Touch ID 2번)

화면의 `sign --kind index` 명령 두 줄(`package-1`·`package-2`)을 그대로 실행한다. 3단계와 같다. 여기까지 Touch ID가 모두 12번이다.

## 6. push (운영 게시, Touch ID 없음)

```bash
node --conditions=development services/registry/src/publish/cli.ts push --trust services/registry/ceremony/keyepoch-1/trust-root.json --work ~/sax-publish/h01-1
```

- `운영자 토큰(https://tax.laf-co.com, 보이지 않음): `이 뜨면 비밀번호 관리자에서 붙여 넣는다. 화면에 보이지 않는다.
- 올리기 전에 서명이 모두 갖춰졌는지 먼저 본다. 모자라면 아무것도 올리지 않고 멈춘다.
- 화면
  - `게시 revoked_keys monotonic 1`
  - `게시 정책 2026.11 monotonic 1`
  - `게시 status monotonic 1`
  - `게시 hometax.invoice.lookup@1.0.0.sxp …B`(3줄)
  - `게시 인덱스 stable monotonic 1`
  - `되읽기·로그 확인: 8건, 로그 크기 0 → 8, 루트 …`
  - `기록 …/record.json`
- 되읽기: 공개 경로가 올린 바이트와 같은지 본다. 폐기 목록·정책·status·인덱스는 서명한 내용이 그대로인지와, 서버가 붙인 타임스탬프까지 핀 키로 검증한다. `policy/2026.11.json`과 `policy/current.json`은 같은 바이트여야 한다.
- 투명성 로그: 새 헤드(timestamp-1 서명), 이전 헤드와의 일관성, 올린 경로마다 항목과 포함 증명을 본다.
- 공개 GET(head·status·인덱스·정책)은 CDN이 60초까지 캐시한다. 옛 판이 보이면 5초마다 다시 읽고, 모두 합쳐 90초까지 기다린다. 그래서 마지막 줄까지 1분쯤 걸릴 수 있다.
- **push가 `publish.log_invalid`·`publish.readback_failed`로 끝나면, 1~2분 뒤 같은 폴더로 `verify`를 돌린다.** 다시 올리지 않는다(PUT 없음). 확인이 통과하면 `record.json`을 쓴다.

  ```bash
  node --conditions=development services/registry/src/publish/cli.ts verify --trust services/registry/ceremony/keyepoch-1/trust-root.json --work ~/sax-publish/h01-1
  ```

  - `push-started.json`(push가 첫 PUT 직전에 남기는 이전 헤드)이 없는 폴더라면, 이전 헤드와의 일관성 증명만 건너뛴다. 이 수정 전에 push한 폴더(2026-11-09 18:18 `h01-1`)가 그렇다. `record.json`의 `logHead.before`는 `null`이다.

## 7. 기록

- `record.json`(경로·sha256·로그 순번·헤드)을 CEREMONY.md §9 서명 기록과 함께 보관한다. 비밀은 없다.
- 팀장에게 아래를 알린다.
  - `record.json`의 `logHead`
  - 인덱스 `expiresAt`
- 엔진 세션은 이것으로 PR-D2 시연을 맞춘다.

## 판을 바꿀 때: 인덱스 다시 서명

인덱스의 기간은 서버가 48시간마다 다시 서명한다. 사람이 다시 서명하는 것은 **항목이 바뀔 때**뿐이다(새 판·롤아웃 비율, ADR-043).

- 같은 소스로 다시 하면 prepare 화면에서 바뀌지 않은 패키지는 `이미 게시됨(서명 없음)`이다.
- assemble가 `인덱스 stable monotonic 2`를 만든다. 서명은 2번(Touch ID 2번)이다.
- push는 바뀐 패키지와 인덱스만 올린다.
- 셀렉터를 고칠 때는 판을 올린다(예 2.1.1). 같은 판에 다른 내용은 `publish.version_exists`로 거부된다.
- 정책이 그대로면 prepare 화면에 `정책 2026.11 monotonic 1: 레지스트리에 같은 내용이 있다(서명·게시 없음 …)`가 나오고 정책 서명은 없다. 정책을 바꿀 때는 `version`을 올린 새 파일을 `--policy`로 준다(정책 서명 2번 더).

## 정책만 바꿀 때 (Touch ID 2번)

패키지 폴더 없이 `--policy`만 준다. 패키지·인덱스·status·폐기 목록은 건드리지 않는다.

1. dry-run: `dry-run --registry https://tax.laf-co.com --work <새 폴더>-dry --trust services/registry/ceremony/keyepoch-1/trust-root.json --policy services/registry/policy/<ver>.json`
   - 마지막에 `리허설: 임시 키 서명 2번, 게시 2건(policy/<ver>.json, policy/current.json), …`이 나와야 한다.
2. prepare: 같은 인자에 `prepare`와 새 작업 폴더. 화면에 `policy monotonic <n> 확인 코드 …`와 `sign --kind policy` 명령 2줄(`policy-1`·`policy-2`)이 나온다. 확인 코드는 dry-run과 같아야 한다.
3. 서명 2번(Touch ID 2번). 3단계와 같다.
4. assemble은 하지 않는다. 패키지가 없는 계획에서 push는 인덱스를 보지도 올리지도 않는다.
5. push. 게시는 `policy/<ver>.json`·`policy/current.json` 2건이다. `record.json`의 `index`는 지금 인덱스 그대로다.

## 실패하면

| 코드 | 뜻 | 할 일 |
|---|---|---|
| `publish.engine_rejected: <패키지> <코드> <규칙>` | 엔진 로더가 받지 않는다(예 `loader.bundle_not_allowed BV-06`) | 멈추고 팀장(엔진 세션)에게. 서명하지 않는다 |
| `publish.lookup_missing`·`publish.lookup_version` | H-01이 가리키는 조회 패키지가 계획에도 레지스트리에도 없다·버전이 다르다 | 소스 목록을 확인한다 |
| `publish.version_exists` | 같은 이름(id@version)에 다른 내용이 이미 게시됐다(불변 경로) | 버전을 올린다(엔진 세션) |
| `registry.portal_blocked` | fixture·wetax 포털 | 게시하지 않는다(ADR-022·039) |
| `ceremony.confirm_mismatch` | `--confirm`이 문서와 다르다 | 명령을 화면에서 다시 복사한다 |
| `ceremony.quorum_short`·`ceremony.wrong_document`·`ceremony.duplicate_signer` | 서명이 모자라다·다른 문서 서명·같은 키 두 번 | 빠진 `sign`을 돌린다. 문서를 고쳤다면 prepare부터 새 폴더로 |
| `publish.policy_invalid: …` | 정책 초안이 엔진 정책 스키마를 통과하지 않는다 | 서명하지 않는다. 메시지의 필드를 고치고 prepare부터 새 폴더로 |
| `publish.policy_version_exists` | 같은 정책 `version`에 다른 내용이 이미 게시됐다 | 정책 파일의 `version`을 올린다 |
| `publish.index_changed` | 준비한 뒤 운영 인덱스의 내용(monotonic·항목)이 바뀌었다. cron의 기간 재서명은 해당하지 않는다 | prepare부터 새 폴더로 |
| `publish.trust_changed` | 핀 파일이 준비 때와 다르다 | 같은 `--trust`를 쓴다 |
| `registry.unauthorized` | 토큰이 틀렸다 | 아무것도 올라가지 않았다. 토큰을 다시 넣는다 |
| `registry.schema_invalid`(폐기 목록·정책·status에서)·`registry.timestamp_invalid`(인덱스에서) | 운영이 첫 게시 도장·ADR-043 전 판이다 | 팀장에게 배포를 확인한다 |
| `publish.readback_failed`·`publish.log_invalid` | 90초를 기다려도 공개된 것이 올린 것과 다르거나 로그 증명이 맞지 않는다(CDN 캐시가 더 오래 남았을 수 있다) | 다시 올리지 않는다. 1~2분 뒤 같은 폴더로 `verify`(6단계). 그래도 같으면 **멈추고 바로 팀장에게** |
| 6단계 중간에 네트워크 오류 | 일부만 올라갔다 | 같은 폴더로 push를 다시 한다. 폐기 목록·정책·status·패키지는 같은 내용이면 다시 받는다. 인덱스가 이미 올라갔으면 `publish.index_changed`가 나온다. 그때는 공개 경로로 확인하고 팀장에게 알린다 |
