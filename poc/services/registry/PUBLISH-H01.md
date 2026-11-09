# H-01 게시 — 사용자 단계

운영 레지스트리(`https://tax.laf-co.com`)에 H-01 전자세금계산서 발급 패키지를 처음 게시하는 절차다. 엔진 PR-D2(패키지 받기·저장·`loadPackage`)가 이 패키지를 받는다.

근거:
- 팀장 지시 2026-11-09
- D09 §8, ADR-013·023·028·037
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

| 순서 | 경로 | 서명 | 누가 |
|---|---|---|---|
| 1 | `registry/revoked_keys.json`(첫 판, monotonic 1) | 루트 2개(서명 의식 2026-11-06에 이미 함, `ceremony/keyepoch-1/revoked_keys.signed.json`) + 타임스탬프 | 타임스탬프는 서버가 올릴 때 붙인다 |
| 2 | `registry/status.json`(첫 판, monotonic 1) | 정책 2개 + 타임스탬프 | 정책 키는 사용자(Touch ID 2번), 타임스탬프는 서버 |
| 3 | `packages/hometax.invoice.lookup@1.0.0.sxp`·`hometax.invoice.email_status@1.0.0.sxp`(조회) | manifest에 패키지 2개 | 사용자(Touch ID 4번) |
| 4 | `packages/hometax.invoice.issue@2.1.0.sxp`(H-01) | manifest에 패키지 2개 | 사용자(Touch ID 2번) |
| 5 | `registry/stable/index.json`(monotonic 1, 14일) | 패키지 2개 | 사용자(Touch ID 2번) |

- Touch ID는 모두 **10번**이다. 키체인 키는 그대로이고 새 키를 만들지 않는다.
- 폐기 목록과 status가 함께 올라가는 이유: 엔진은 24시간 안의 폐기 목록이 없으면 새 패키지를 받지 않는다. status가 없으면 데몬이 멈춘다(`daemon_stop`).
- 올린 뒤 폐기 목록(24시간)·status(48시간)는 서버 cron이 자동으로 다시 서명한다.
- **인덱스는 다시 서명하지 않는다**(타임스탬프가 없다). 14일 안에 사람이 다시 서명해야 한다(아래 "14일마다").
  - 이 수동 절차는 임시다. ADR-043(인덱스 내용 서명과 신선도 서명 분리, 신선도는 cron이 timestamp-1 키로 재서명)이 배포되면 없어진다(팀장 결정 2026-11-09).
- status 상한은 `hometax: assisted`(사람 보조)다. 실제 홈택스 화면과 셀렉터를 아직 대조하지 않았기 때문이다(팀장 결정 2026-11-09).
- **H-01 셀렉터는 실제 화면 미대조다. 첫 실기기 실행에서 확인한다**(ADR-025). 틀리면 판을 올려(2.1.1 등) 다시 게시한다. 이번 게시 판은 2.1.0 그대로다.
- 원본 경로는 `packages/engine/playbooks/<패키지 id>/`다(#231, 팀장 결정 2026-11-09). H-01은 `hometax.invoice.issue`, 조회 패키지 2개는 `hometax.invoice.lookup`·`hometax.invoice.email_status`.

## 0. 준비

- 서명 의식을 한 맥이어야 한다. 키체인 키 11개와 도우미 `~/.sax/bin/sax-keychain`이 있어야 한다. **도우미를 다시 빌드하지 않는다.**
- 저장소 `poc/`에서 main 최신으로 돌린다. 이 절차가 들어간 PR(첫 게시 도장)이 **운영에 배포된 뒤**여야 한다. 배포 전이면 2~3단계의 폐기 목록·status가 `registry.schema_invalid`로 거부된다.
- 운영자 토큰(`REGISTRY__REGISTRY_ADMIN_TOKEN`의 값)을 비밀번호 관리자에서 꺼낼 수 있어야 한다.
  - 6단계에서 터미널이 보이지 않게 묻는다. 명령 인자·셸 기록·파일에 넣지 않는다.
- 작업 폴더는 저장소 밖에 둔다(예 `~/sax-publish/h01-1`).
  - 공개 산출물과 서명 기록만 들어간다. 비밀은 없다.
  - 단계마다 새 파일만 쓰고 덮어쓰지 않는다. 다시 할 때는 새 폴더 이름을 쓴다.

## 1. dry-run (Touch ID 없음, 운영에 쓰지 않음)

```bash
node --conditions=development services/registry/src/publish/cli.ts dry-run --registry https://tax.laf-co.com --trust services/registry/ceremony/keyepoch-1/trust-root.json --work ~/sax-publish/h01-dry --revoked services/registry/ceremony/keyepoch-1/revoked_keys.signed.json --ceiling hometax=assisted packages/engine/playbooks/hometax.invoice.lookup packages/engine/playbooks/hometax.invoice.email_status packages/engine/playbooks/hometax.invoice.issue
```

- 운영 레지스트리는 **읽기만** 한다(GET). 서명은 메모리 안 임시 키로 하고, 게시는 이 맥 안의 임시 로컬 레지스트리에만 한다.
- 화면은 아래와 같다.
  - `dry-run 1/2: …` 아래에 패키지 3줄이 나온다. 각 줄에 manifest 다이제스트와 확인 코드가 있다.
  - 마지막에 `리허설: 임시 키 서명 12번, 게시 6건(…), 되읽기·로그 포함 증명 통과`가 나오고, 이어 `dry-run 끝`이 나온다.
- 2026-11-09 운영에 돌린 결과다. 소스가 바뀌면 확인 코드도 바뀐다.

  | 문서 | 확인 코드 |
  |---|---|
  | `hometax.invoice.lookup@1.0.0` | `5935-5dd9-0788-f815-39eb-b5f3-f9e8-48c3` |
  | `hometax.invoice.email_status@1.0.0` | `8f91-2f81-f1ea-92c9-7591-aa92-3a38-3113` |
  | `hometax.invoice.issue@2.1.0` | `2bb4-aa6f-1263-b286-142a-e36e-3440-54da` |
  | status monotonic 1(`hometax: assisted`) | `71ba-dba0-765b-6603-d2bb-6333-7048-304d` |

- 오류가 나면 여기서 멈추고 팀장에게 알린다. 코드는 아래 "실패하면" 표에 있다.

## 2. prepare (Touch ID 없음)

dry-run과 같은 인자에 `prepare`, 새 작업 폴더를 준다.

```bash
node --conditions=development services/registry/src/publish/cli.ts prepare --registry https://tax.laf-co.com --trust services/registry/ceremony/keyepoch-1/trust-root.json --work ~/sax-publish/h01-1 --revoked services/registry/ceremony/keyepoch-1/revoked_keys.signed.json --ceiling hometax=assisted packages/engine/playbooks/hometax.invoice.lookup packages/engine/playbooks/hometax.invoice.email_status packages/engine/playbooks/hometax.invoice.issue
```

- 화면
  - 확인 코드 4개가 dry-run과 같아야 한다. 다르면 멈춘다.
  - `revoked_keys monotonic 1: 루트 2개 서명이 이미 있다`
  - `다음: 서명 8번(Touch ID)` 아래에 `ceremony … sign` 명령 8줄
- 이 단계에서 엔진 로더 연습을 한다. 임시 키로 서명해 `loadPackage`를 돌린다(번들 허용 목록, 조회 다이제스트, 정적 검증, 승인 바 요약). 통과하지 않으면 서명할 것을 내놓지 않는다.

## 3. 서명 8번 (Touch ID 8번)

화면에 나온 `sign` 명령을 한 줄씩 그대로 실행한다. 아래는 첫 줄의 모양이다.

```bash
node --conditions=development services/registry/src/ceremony/cli.ts sign --kind manifest --key-id package-1 --confirm 5935-5dd9-0788-f815-39eb-b5f3-f9e8-48c3 --trust services/registry/ceremony/keyepoch-1/trust-root.json --out ~/sax-publish/h01-1/sig/hometax.invoice.lookup@1.0.0.package-1.json ~/sax-publish/h01-1/manifests/hometax.invoice.lookup@1.0.0.json
```

- 명령마다 Touch ID 창이 뜬다. **창의 확인 코드가 명령의 `--confirm` 값과 같은지 보고** 누른다(CEREMONY.md §1 "남는 위험").
- 화면에 `서명 기록 package-1 → …`이 나온다.
- 순서는 상관없다. 같은 명령을 두 번 돌리면 `EEXIST`로 멈춘다. 이미 된 것이니 다음 줄로 간다.

## 4. assemble (Touch ID 없음)

```bash
node --conditions=development services/registry/src/publish/cli.ts assemble --trust services/registry/ceremony/keyepoch-1/trust-root.json --work ~/sax-publish/h01-1
```

- 서명을 모은다. 서로 다른 package 키 2개여야 하고, 같은 키 두 번이나 다른 문서의 서명은 거부한다.
- `.sxp`를 묶고, **실제 서명으로** 관문 규칙(`verifySxp`)과 엔진 로더(`loadPackage`)를 다시 돌린다.
- 화면
  - `묶음: 패키지 3개(엔진 로더·관문 규칙 통과, 실제 서명)`
  - `인덱스 stable monotonic 1, <지금> ~ <14일 뒤>`
  - `인덱스 확인 코드 …`
  - 아래에 `sign --kind index` 명령 2줄
- 인덱스 만료는 이 시각부터 14일이다. 5·6단계는 그 안에 한다(보통 바로).

## 5. 인덱스 서명 2번 (Touch ID 2번)

화면의 `sign --kind index` 명령 두 줄을 그대로 실행한다. 3단계와 같다.

## 6. push (운영 게시)

```bash
node --conditions=development services/registry/src/publish/cli.ts push --trust services/registry/ceremony/keyepoch-1/trust-root.json --work ~/sax-publish/h01-1
```

- `운영자 토큰(https://tax.laf-co.com, 보이지 않음): `이 뜨면 비밀번호 관리자에서 붙여 넣는다. 화면에 보이지 않는다.
- 올리기 전에 서명이 모두 갖춰졌는지 먼저 본다. 모자라면 아무것도 올리지 않고 멈춘다.
- 화면
  - `게시 revoked_keys monotonic 1`
  - `게시 status monotonic 1`
  - `게시 hometax.invoice.lookup@1.0.0.sxp …B`(3줄)
  - `게시 인덱스 stable monotonic 1`
  - `되읽기·로그 확인: 6건, 로그 크기 0 → 6, 루트 …`
  - `기록 …/record.json`
- 되읽기: 공개 경로가 올린 바이트와 같은지 본다. 폐기 목록·status는 서버가 붙인 타임스탬프까지 핀 키로 검증한다.
- 투명성 로그: 새 헤드(timestamp-1 서명), 이전 헤드와의 일관성, 올린 경로마다 항목과 포함 증명을 본다.

## 7. 기록

- `record.json`(경로·sha256·로그 순번·헤드)을 CEREMONY.md §9 서명 기록과 함께 보관한다. 비밀은 없다.
- 팀장에게 아래를 알린다.
  - `record.json`의 `logHead`
  - 인덱스 `expiresAt`
- 엔진 세션은 이것으로 PR-D2 시연을 맞춘다.

## 14일마다: 인덱스 다시 서명

인덱스는 타임스탬프가 없어 서버가 다시 서명하지 못한다(API.md 서명 규칙 표). **임시 절차다.** ADR-043이 배포되면 서버 cron이 인덱스 신선도를 다시 서명하고 이 절은 없어진다.

인덱스가 만료되면(엔진 세션 확인 2026-11-09) 이렇게 된다.
- 이미 받은 PC는 설치본을 계속 쓴다(`loadInstalled`는 인덱스를 보지 않는다).
- 엔진은 만료된 인덱스를 받지 않는다(`registry.expired_on_arrival`).
- 그래서 새 판 배포가 멈춘다.
- 새 PC는 첫 설치를 못 한다(`package.not_loaded`).

만료 전에 같은 소스로 2·4·5·6단계를 다시 한다. `--revoked`·`--ceiling`은 빼고, 작업 폴더는 새 이름을 쓴다.

- prepare 화면에서 패키지 3줄은 `이미 게시됨(서명 없음)`이다. 서명할 것이 없다.
- assemble가 `인덱스 stable monotonic 2`를 만든다. 서명은 2번(Touch ID 2번)이다.
- push는 인덱스 한 건만 올린다.

## 실패하면

| 코드 | 뜻 | 할 일 |
|---|---|---|
| `publish.engine_rejected: <패키지> <코드> <규칙>` | 엔진 로더가 받지 않는다(예 `loader.bundle_not_allowed BV-06`) | 멈추고 팀장(엔진 세션)에게. 서명하지 않는다 |
| `publish.lookup_missing`·`publish.lookup_version` | H-01이 가리키는 조회 패키지가 계획에도 레지스트리에도 없다·버전이 다르다 | 소스 목록을 확인한다 |
| `publish.version_exists` | 같은 이름(id@version)에 다른 내용이 이미 게시됐다(불변 경로) | 버전을 올린다(엔진 세션) |
| `registry.portal_blocked` | fixture·wetax 포털 | 게시하지 않는다(ADR-022·039) |
| `ceremony.confirm_mismatch` | `--confirm`이 문서와 다르다 | 명령을 화면에서 다시 복사한다 |
| `ceremony.quorum_short`·`ceremony.wrong_document`·`ceremony.duplicate_signer` | 서명이 모자라다·다른 문서 서명·같은 키 두 번 | 빠진 `sign`을 돌린다. 문서를 고쳤다면 prepare부터 새 폴더로 |
| `publish.index_changed` | 준비한 뒤 운영 인덱스가 바뀌었다 | prepare부터 새 폴더로 |
| `publish.trust_changed` | 핀 파일이 준비 때와 다르다 | 같은 `--trust`를 쓴다 |
| `registry.unauthorized` | 토큰이 틀렸다 | 아무것도 올라가지 않았다. 토큰을 다시 넣는다 |
| `registry.schema_invalid`(폐기 목록·status에서) | 운영이 첫 게시 도장 전 판이다 | 팀장에게 배포를 확인한다 |
| `publish.readback_failed`·`publish.log_invalid` | 올린 것과 공개된 것이 다르거나 로그 증명이 맞지 않는다 | **멈추고 바로 팀장에게.** 다시 올리지 않는다 |
| 6단계 중간에 네트워크 오류 | 일부만 올라갔다 | 같은 폴더로 push를 다시 한다. 폐기 목록·status·패키지는 같은 내용이면 다시 받는다. 인덱스가 이미 올라갔으면 `publish.index_changed`가 나온다. 그때는 공개 경로로 확인하고 팀장에게 알린다 |
