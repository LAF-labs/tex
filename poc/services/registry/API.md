# 레지스트리 API(D14 M4-7)

정적 파일 서버 + 게시 관문. 서버는 **서명하지 않는다**: 모든 산출물은 CI 밖 하드웨어 서명 의식에서 서명된 채로 들어오고, 게시 관문은 엔진과 같은 규칙으로 검증한 뒤에만 정적 경로에 놓는다. 클라이언트는 받은 뒤 같은 검증을 **다시** 한다(서버를 믿지 않는다, ADR-013).

**정본**: 서명 바이트·문서 모양·수용 규칙은 엔진 트랙의 [`design/schemas/SIGNING.md`](../../../sovereign-ax/design/schemas/SIGNING.md)와 엔진 로더(`packages/engine/src/core/registry.ts`·`loader.ts`·`sxp.ts`)다. 이 문서는 그것을 게시 관문 쪽에서 옮긴 것이고, 어긋나면 SIGNING.md가 맞다. 스키마: [`status.schema.json`](../../../sovereign-ax/design/schemas/status.schema.json)·[`revoked_keys.schema.json`](../../../sovereign-ax/design/schemas/revoked_keys.schema.json)·[`policy.schema.json`](../../../sovereign-ax/design/schemas/policy.schema.json)·[`manifest.schema.json`](../../../sovereign-ax/design/schemas/manifest.schema.json)·[`hotfix.schema.json`](../../../sovereign-ax/design/schemas/hotfix.schema.json)(엔진 사본 `packages/engine/schemas`). 관문은 엔진의 `schemaViolations`·`decodeSxp`·`statusIsConservative`·`isStrictlyConservative`를 그대로 쓴다. 상호 검증: 엔진 고정 시드 샘플 묶음(`tests/fixtures/registry`, SIGNING.md §10.3)을 관문이 전부 받고, 관문이 게시한 파일을 엔진 수용 함수·로더가 되읽는다(`tests/services-registry.test.ts`).

근거: D09 §8, ADR-013·022·023·028, D03 §3.1·§7.1.

## 서명 규칙(SIGNING.md §1~§7 요약)

- 서명 입력: `utf8(JCS(내용))`(RFC 8785, 소수 허용), **맥락 문자열 없음**. 서명 항목 `{"keyId", "alg": "ed25519", "sig": "<base64url 86자>"}`.
- 정족수: 그 역할의 **핀 고정 키** 가운데 서로 다른 keyId의 유효 서명 수. 같은 keyId 두 번·핀 밖 키·다른 역할 키·`alg` ≠ ed25519는 세지 않는다. 폐기된 키의 유효 서명은 세지 않고 이벤트 `registry.key_revoked`를 남긴다(모자라면 `registry.signature_insufficient`).
- `keyEpoch`는 핀과 같아야 한다(`registry.key_epoch_mismatch`). 같은 keyEpoch 안에서 `monotonic`은 늘기만 하고 +1000 이하(`registry.version_rollback`·`registry.version_jump_rejected`). 같은 `monotonic`은 **내용 다이제스트가 같을 때만**(신선도 재서명).
- 타임스탬프(정책·status·폐기 목록): 타임스탬프 키 1개가 `JCS({contentDigest, monotonic, issuedAt, expiresAt})`에 서명한 `timestamp`(`registry.timestamp_invalid`). `contentDigest` = SHA-256(내용 서명 바이트).
- 시각: `issuedAt`이 현재 + 5분보다 미래면 `*.issued_in_future`, 유효 기간이 상한을 넘으면 `*_validity_too_long`, 도착 시 만료면 `*.expired_on_arrival`.

| 산출물 | 내용 서명 바이트 | 서명 키 | 신선도 | 기간 초과 코드 |
|---|---|---|---|---|
| `.sxp` 안 `manifest.json` | JCS(manifest − `signatures`) | 패키지 키 2-of-3 | 인덱스 | — |
| `.sxp` 안 `hotfix.json` | JCS(hotfix − `signatures`) | 패키지 키 2-of-3 | 문서 안 `issuedAt`·`expiresAt` ≤ 14일 | `hotfix.validity_too_long`(만료 `hotfix.expired`) |
| 인덱스 `registry/{channel}/index.json` | JCS(index − `signatures`) | 패키지 키 2-of-3 | 문서 안 `issuedAt`·`expiresAt` ≤ 14일(**타임스탬프 없음**) | `registry.index_validity_too_long` |
| 정책 `policy/{ver}.json`·`current.json` | JCS(policy − `signatures`·`issuedAt`·`expiresAt`·`timestamp`) | 정책 키 2-of-3 또는 긴급 키 1 | `timestamp` ≤ 72시간 | `policy.validity_too_long` |
| status `registry/status.json` | 위와 같은 규칙 | 정책 키 2-of-3 또는 긴급 키 1 | `timestamp` ≤ 48시간 | `registry.status_validity_too_long` |
| 폐기 목록 `registry/revoked_keys.json` | 위와 같은 규칙 | 루트 키 2-of-3 | `timestamp` ≤ 24시간 | `registry.revoked_validity_too_long` |
| 릴리스 `releases/{channel}/latest.json` | JCS(manifest − `signature`) | 릴리스 키 1 | 문서 안 ≤ 14일 | `registry.release_validity_too_long` |

채널: `stable`·`beta`·`hotfix`. 다른 이름은 `registry.not_found`.

## 공개 GET

| 경로 | Cache-Control | 비고 |
|---|---|---|
| `/registry/{channel}/index.json` | `public, max-age=60` | 15분 폴링 + ETag(ADR-023) |
| `/registry/status.json` | `public, max-age=60` | |
| `/registry/revoked_keys.json` | `public, max-age=60` | |
| `/policy/current.json` | `public, max-age=60` | 최신 정책. `{ver}.json`과 바이트가 같다 |
| `/policy/{ver}.json` | `public, max-age=60` | `ver` = `YYYY.MM[.n]`. 신선도 재발행(같은 내용, 새 `issuedAt`·서명)으로 바뀌므로 불변 캐시가 아니다 |
| `/packages/{id}@{x.y.z}.sxp` | `public, max-age=31536000, immutable` | `application/octet-stream`. `id`는 manifest 패턴 `^[a-z0-9]+(\.[a-z0-9_]+)+$`(예 `hometax.invoice.issue@2.1.0.sxp`, 핫픽스 `hometax.invoice.issue.hotfix@1.3.0.sxp`) |
| `/releases/{channel}/latest.json` | `public, max-age=60` | 서명된 릴리스 매니페스트(클라이언트 main이 검증) |
| `/releases/{channel}/latest.yml` | `public, max-age=60` | electron-updater용. 검증된 `latest.json`에서만 만든다 |
| `/healthz` | | `{"ok":true}` |

모든 파일 응답에 `ETag: "<sha256 앞 32 hex>"`. `If-None-Match`가 같으면 `304`(본문 없음). 없는 파일 `404 {"error":"registry.not_found"}`. 요청 본문·쿼리·쿠키는 쓰지 않는다.

## 게시 PUT(운영자)

모두 `Authorization: Admin <REGISTRY_ADMIN_TOKEN>`(없거나 틀리면 `401 registry.unauthorized`). 게시는 인스턴스 안에서 하나씩 처리한다(읽기 → 검증 → 쓰기 사이에 다른 게시가 끼지 않게). 파일 쓰기는 쓰기마다 다른 임시 파일 → 원자적 rename. 토큰은 호스팅 쓰기 권한일 뿐이고, 서명 검증을 통과하지 못한 산출물은 토큰이 있어도 올라가지 않는다(D09 §8.2 역할 분리).

| 경로 | 본문 | 성공 | 검증 |
|---|---|---|---|
| `PUT /admin/v1/packages/{id}@{x.y.z}.sxp` | `{"data":"<base64 .sxp>"}`(≤ 24MB 본문) | `201 {"sxpDigest","size","kind"}` | `.sxp` v1 정규형(`sxp.*`), 안의 manifest·hotfix 스키마(`registry.schema_invalid`)·패키지 키 2-of-3·`contentDigests` = 원시 파일 바이트(`registry.content_digest_mismatch`), 파일 이름 = manifest id·version(핫픽스는 `<appliesTo.id>.hotfix@<keyEpoch>.<monotonic>.0`), 위택스 거부. 같은 이름에 다른 바이트면 `registry.content_digest_mismatch`(불변 경로), 같은 바이트는 멱등 |
| `PUT /admin/v1/index/{channel}` | 인덱스(≤ 512KB) | `200 {"monotonic"}` | 위 공통 + 항목 검사 + **가리키는 `.sxp`가 먼저 올라와 있고** 바이트가 `sxpDigest`·`size`와 같고(없으면 `registry.not_found`, 다르면 `registry.content_digest_mismatch`) 안의 종류·포털이 항목과 같아야 함 |
| `PUT /admin/v1/policy` | 서명된 정책 | `200 {"monotonic","emergency"}` | `{ver}.json`이 이미 있으면 같은 `monotonic`(신선도 재서명)만(`registry.version_rollback`) |
| `PUT /admin/v1/status` | status | `200 {"monotonic","emergency"}` | 긴급 키 단독본은 아래 "엄격하게 보수적"만 |
| `PUT /admin/v1/revoked-keys` | 폐기 목록 | `200 {"monotonic"}` | 이전 목록의 키가 빠지면 `registry.revoked_shrunk`(폐기는 되돌릴 수 없다) |
| `PUT /admin/v1/releases/{channel}` | 릴리스 매니페스트 | `200 {"version"}` | 저장된 version보다 커야 함(`registry.version_rollback`). `latest.yml`을 먼저, `latest.json`을 마지막에 쓴다(json이 게시 기준이라 중간 실패 뒤 같은 버전 재시도 가능) |

## 형식

### 인덱스

```json
{
  "channel": "stable", "monotonic": 7, "keyEpoch": 1,
  "issuedAt": "2026-11-05T00:00:00Z", "expiresAt": "2026-11-19T00:00:00Z",
  "entries": [
    { "id": "hometax.invoice.issue", "version": "2.1.0", "kind": "playbook", "portal": "hometax",
      "sxpDigest": "<sha256 hex 64 = .sxp 파일 바이트>", "size": 19955, "rolloutPercent": 100, "minAppVersion": "1.2.0" }
  ],
  "signatures": [ { "keyId": "package-1", "alg": "ed25519", "sig": "…" }, { "keyId": "package-2", "alg": "ed25519", "sig": "…" } ]
}
```

- 최상위·항목 필드는 위에 적은 것만(그 밖은 `registry.schema_invalid`). `entries` ≤ 500, `id@version` 중복 금지, `id`는 manifest 패턴(점 필수), `kind` ∈ `playbook|lookup|hotfix|data`, `size` 1B~16MB, `rolloutPercent` 0~100.
- 핫픽스(SIGNING.md §6): `hotfix` 채널에만, `kind: "hotfix"`, `id` = `<appliesTo.id>.hotfix`, `version` = `<keyEpoch>.<monotonic>.0`. 다른 채널에 핫픽스 항목·`.hotfix`로 끝나는 패키지 id는 거부한다.
- 데이터 패키지(`kind: "data"`, 급여 시행일 표 M6-10): 서명 안 본문 스키마는 [`packages/payroll/schema/rate-table-package.schema.json`](../../packages/payroll/schema/rate-table-package.schema.json)(`sax.rate-tables/v1`), 서명·타임스탬프는 SIGNING.md 규약을 따른다. `.sxp` 컨테이너의 `data` 종류는 SIGNING.md §6이 아직 정하지 않아(범위 밖), 관문은 데이터 패키지 업로드를 지금은 거부한다(`sxp.malformed`). §6에 들어오면 같은 관문으로 받는다.
- `portal: "wetax"`는 `registry.portal_blocked`(허락 회신 전, D09 §8.6·ADR-022 결정 2).
- **롤아웃**: 서버는 기기를 모른다. 클라이언트가 `bucket = u32be(sha256("SAX-rollout-v1\0" ‖ id ‖ "\0" ‖ deviceId)[0..4]) mod 100`을 계산해 `bucket < rolloutPercent`일 때만 받는다(1 → 10 → 100).

### 정책

[`policy.schema.json`](../../../sovereign-ax/design/schemas/policy.schema.json) 그대로(소수 값 `slowFactor: 1.5` 포함). 긴급 키(1개) 서명본은 저장된 정책보다 엄격하게 보수적일 때만 받고(엔진 `isStrictlyConservative`, D03 §7.1, 아니면 `policy.rejected_not_conservative`) `emergency: true`로 응답한다. 저장된 정책이 없으면 긴급 키 단독본은 받지 않는다.

### status

```json
{ "monotonic": 3, "keyEpoch": 1, "issuedAt": "…", "expiresAt": "…",
  "portalModeCeiling": { "hometax": "assisted", "gov24": "assisted", "iros": "postprocess" },
  "killPlaybooks": ["hometax.invoice.cancel"], "signatures": [ … ], "timestamp": { … } }
```

- 상한 순서 `postprocess < assisted < auto`. 없는 포털 = 상한 없음.
- 포털 이름은 스키마 목록(`hometax`·`gov24`·`wetax`·`sminfo`·`insure4`·`iros`·`public_api`)만.
- **긴급 키 1개**는 직전 status보다 엄격하게 보수적일 때만(엔진 `statusIsConservative`): 모든 포털 상한 ≤ 이전(상한을 빼면 완화로 본다), `killPlaybooks` ⊇ 이전, 하나 이상 엄격. 직전 status가 없으면(첫 설치) "상한 없음·킬 없음" 대비로 본다. 아니면 `policy.rejected_not_conservative`. 상향·킬 해제는 정책 키 2-of-3만. 긴급 status의 72시간 만료는 클라이언트가 내용 첫 발행 시각부터 센다.

### 폐기 목록

```json
{ "monotonic": 2, "keyEpoch": 1, "issuedAt": "…", "expiresAt": "…",
  "revoked": [ { "keyId": "package-1", "role": "package", "revokedAt": "…" } ],
  "signatures": [ 루트 2개 ], "timestamp": { … } }
```

`revoked` ≤ 64, keyId 중복 없음. **루트 서명**은 지금 받아 둔 **이전** 폐기 목록으로 걸러 센다(루트 키도 폐기될 수 있다). **타임스탬프 서명**은 **새** 목록으로 거른다(SIGNING.md §3): 타임스탬프 키를 폐기하는 목록은 그 키로 신선해질 수 없고(`registry.timestamp_invalid`), 그 뒤 클라이언트는 새 keyEpoch(앱 업데이트)까지 stale로 보수적으로 멈춘다. 새 목록은 이전 목록의 상위 집합이어야 한다(`registry.revoked_shrunk`). 클라이언트는 24시간 안의 목록이 없으면 새 패키지·정책 로드를 보류한다.

### 릴리스 매니페스트 → latest.yml

```json
{ "channel": "stable", "version": "1.2.0", "releaseDate": "…", "expiresAt": "…", "rolloutPercent": 10,
  "files": [ { "url": "tex-Setup-1.2.0.exe", "sha512": "<base64 88자>", "size": 123456 } ],
  "signature": { "keyId": "release-1", "alg": "ed25519", "sig": "…" } }
```

`files` 1~8개, `url`은 `^[A-Za-z0-9._-]{1,128}$`(경로·개행 없음, YAML 주입 없음). `latest.yml`은 이 매니페스트에서 `version`·`files`·`path`·`sha512`·`releaseDate`만 옮긴다. 클라이언트 main은 `latest.json` 서명·만료·다운그레이드를 직접 검증한 뒤에만 electron-updater에 sha512를 넘긴다(ADR-028).

## 오류 코드

엔진 로더(#52)와 같은 이름을 쓴다(D16, 서버 표에 없는 것은 `PROPOSED_D16`).

- 422: `registry.schema_invalid`·`registry.signature_insufficient`·`registry.key_epoch_mismatch`·`registry.key_epoch_rollback`·`registry.version_rollback`·`registry.version_jump_rejected`·`registry.timestamp_invalid`·`registry.issued_in_future`·`registry.expired_on_arrival`·`registry.index_validity_too_long`·`registry.status_validity_too_long`·`registry.revoked_validity_too_long`·`registry.release_validity_too_long`·`registry.revoked_shrunk`·`registry.portal_blocked`·`registry.content_digest_mismatch`·`policy.rejected_not_conservative`·`policy.validity_too_long`·`policy.issued_in_future`·`policy.expired_on_arrival`·`hotfix.validity_too_long`·`hotfix.expired`·`sxp.too_large`·`sxp.malformed`·`sxp.not_canonical`·`sxp.unknown_format`
- 404 `registry.not_found`, 401 `registry.unauthorized`, 400 `request.param_rejected`(경로 이름·본문 형식)

본문은 `{"error": "<코드>"}`만이고 입력을 되풀이하지 않는다. 이벤트(카운트만): `registry.key_revoked`, `package_staged`, `index_published`, `policy_published`·`policy_emergency`, `status_published`·`status_emergency`, `revoked_published`, `release_published`.

## 범위 밖(후속)

- 투명성 로그(RFC 9162 트리 헤드)·별도 호스트 미러: 엔진에 `merkleRoot`·`verifyConsistency`가 있다. 레지스트리 쪽 로그 추가·헤드 서명 바이트는 D09 §8과 함께 정한다.
- 데이터 패키지 `.sxp` 종류(SIGNING.md §6 추가 대기).
