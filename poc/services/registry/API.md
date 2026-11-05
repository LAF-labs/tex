# 레지스트리 API(D14 M4-7)

정적 파일 서버 + 게시 관문. 서버는 **서명하지 않는다**: 모든 산출물은 CI 밖 하드웨어 서명 의식에서 서명된 채로 들어오고, 게시 관문은 클라이언트와 같은 규칙([`src/verify.ts`](src/verify.ts))으로 검증한 뒤에만 정적 경로에 놓는다. 클라이언트는 받은 뒤 같은 검증을 **다시** 한다(서버를 믿지 않는다, ADR-013).

근거: D09 §8, ADR-013·022·023·028, D03 §3.1·§7.1, `packages/*/schemas/manifest|policy|hotfix.schema.json`.

## 서명 규칙(공통)

- 서명 입력: `utf8(JCS(내용))`, **맥락 문자열 없음**(manifest·policy·hotfix 스키마와 같은 규칙). 내용 = 산출물에서 아래 "서명 밖 필드"를 뺀 객체.
- 서명 항목: `{"keyId": "<핀 keyId>", "alg": "ed25519", "sig": "<base64url 86자>"}`.
- 정족수: 서로 다른 **핀 고정 키**의 유효 서명 수. 같은 keyId 두 번·핀 밖 키·다른 역할 키·폐기 목록의 키는 세지 않는다. 서명 배열은 최대 3개.
- 단조 값 `monotonic`: 산출물 종류(채널)마다 따로 센다. 저장값보다 커야 하고 저장값 + 1000 이하(버전 인플레이션 잠금 방지). `keyEpoch`는 핀과 같아야 한다.
- 신선도 재발행: `monotonic`이 같고 내용(서명 밖 필드 제외)이 같으면 새 `issuedAt`·`expiresAt`·서명으로 다시 올릴 수 있다. 내용이 다르면 `registry.version_jump_rejected`.
- 타임스탬프(정책·status·폐기 목록): 타임스탬프 키 1개가 `JCS({contentDigest: hex(sha256(JCS(내용))), monotonic, issuedAt, expiresAt})`에 서명한 `timestamp` 필드.
- 시각: `issuedAt`이 현재 + 5분보다 미래면 `registry.issued_in_future`, 유효 기간이 상한을 넘으면 `request.param_rejected`, 만료면 종류별 stale 코드.

| 산출물 | 내용 서명 | 서명 밖 필드 | 유효 기간 상한 | 만료 코드 |
|---|---|---|---|---|
| 인덱스 `registry/{channel}/index.json` | 패키지 키 2-of-3 | `signatures` | 14일 | `registry.expired` |
| 정책 `policy/{ver}.json`·`current.json` | 정책 키 2-of-3 **또는** 긴급 키 1 | `signatures`·`timestamp`·`issuedAt`·`expiresAt` | 72시간 | `registry.expired` |
| status `registry/status.json` | 정책 키 2-of-3 **또는** 긴급 키 1(엄격하게 보수적일 때만) | 위와 같음 | 48시간 | `registry.status_stale` |
| 폐기 목록 `registry/revoked_keys.json` | 루트 키 2-of-3(이전 폐기 목록으로 걸러서) | 위와 같음 | 24시간 | `registry.revocation_stale` |
| 릴리스 `releases/{channel}/latest.json` | 릴리스 키 1 | `signature` | 14일 | `registry.expired` |

채널: `stable`·`beta`·`hotfix`. 다른 이름은 `registry.not_found`.

## 공개 GET

| 경로 | Cache-Control | 비고 |
|---|---|---|
| `/registry/{channel}/index.json` | `public, max-age=60` | 15분 폴링 + ETag(ADR-023) |
| `/registry/status.json` | `public, max-age=60` | |
| `/registry/revoked_keys.json` | `public, max-age=60` | |
| `/policy/current.json` | `public, max-age=60` | 최신 정책. `{ver}.json`과 바이트가 같다 |
| `/policy/{ver}.json` | `public, max-age=60` | `ver` = `YYYY.MM[.n]`. 신선도 재발행(같은 내용, 새 `issuedAt`·서명)으로 바뀌므로 불변 캐시가 아니다 |
| `/packages/{id}@{x.y.z}.sxp` | `public, max-age=31536000, immutable` | `application/octet-stream` |
| `/releases/{channel}/latest.json` | `public, max-age=60` | 서명된 릴리스 매니페스트(클라이언트 main이 검증) |
| `/releases/{channel}/latest.yml` | `public, max-age=60` | electron-updater용. 검증된 `latest.json`에서만 만든다 |
| `/healthz` | | `{"ok":true}` |

모든 파일 응답에 `ETag: "<sha256 앞 32 hex>"`. `If-None-Match`가 같으면 `304`(본문 없음). 없는 파일 `404 {"error":"registry.not_found"}`. 요청 본문·쿼리·쿠키는 쓰지 않는다.

## 게시 PUT(운영자)

모두 `Authorization: Admin <REGISTRY_ADMIN_TOKEN>`(없거나 틀리면 `401 registry.unauthorized`). 게시는 인스턴스 안에서 하나씩 처리한다(읽기 → 검증 → 쓰기 사이에 다른 게시가 끼지 않게). 파일 쓰기는 쓰기마다 다른 임시 파일 → 원자적 rename. 토큰은 호스팅 쓰기 권한일 뿐이고, 서명 검증을 통과하지 못한 산출물은 토큰이 있어도 올라가지 않는다(D09 §8.2 역할 분리).

| 경로 | 본문 | 성공 | 검증 |
|---|---|---|---|
| `PUT /admin/v1/packages/{id}@{x.y.z}.sxp` | `{"data":"<base64 .sxp>"}`(≤ 24MB 본문) | `201 {"packageDigest","size"}` | 같은 이름에 다른 바이트면 `registry.content_digest_mismatch`(불변 경로). 같은 바이트는 멱등 |
| `PUT /admin/v1/index/{channel}` | 인덱스(≤ 512KB) | `200 {"monotonic"}` | 위 공통 + 항목 검사 + **가리키는 패키지가 먼저 올라와 있고** 바이트가 `packageDigest`·`size`와 같아야 함(없으면 `registry.not_found`, 다르면 `registry.content_digest_mismatch`) |
| `PUT /admin/v1/policy` | 서명된 정책 | `200 {"monotonic","emergency"}` | `{ver}.json`이 이미 있으면 같은 `monotonic`(신선도 재발행)만 |
| `PUT /admin/v1/status` | status | `200 {"monotonic","emergency"}` | 긴급 키 서명본은 아래 "엄격하게 보수적"만 |
| `PUT /admin/v1/revoked-keys` | 폐기 목록 | `200 {"monotonic"}` | 이전 목록의 키가 빠지면 `registry.version_jump_rejected`(폐기는 되돌릴 수 없다) |
| `PUT /admin/v1/releases/{channel}` | 릴리스 매니페스트 | `200 {"version"}` | 저장된 version보다 커야 함(다운그레이드·같은 버전 `registry.version_jump_rejected`). `latest.yml`을 먼저, `latest.json`을 마지막에 쓴다(json이 게시 기준이라 중간 실패 뒤 같은 버전 재시도 가능) |

## 형식

### 인덱스

```json
{
  "channel": "stable", "monotonic": 12, "keyEpoch": 1,
  "issuedAt": "2026-11-10T00:00:00.000Z", "expiresAt": "2026-11-17T00:00:00.000Z",
  "entries": [
    { "id": "hometax_cert_issue", "version": "1.0.0", "kind": "playbook", "portal": "hometax",
      "packageDigest": "<sha256 hex 64>", "size": 18342, "rolloutPercent": 10, "minAppVersion": "1.2.0" }
  ],
  "signatures": [ { "keyId": "package-1", "alg": "ed25519", "sig": "…" }, { "keyId": "package-2", "alg": "ed25519", "sig": "…" } ]
}
```

- `entries` ≤ 500, `id@version` 중복 금지, `kind` ∈ `playbook|lookup|hotfix|data`(`data` = 급여 시행일 표 같은 데이터 패키지, 겹침 검사는 엔진 M6-10), `size` 1B~16MB, `rolloutPercent` 0~100.
- `portal: "wetax"`는 `registry.portal_blocked`(허락 회신 전, D09 §8.6·ADR-022 결정 2).
- 인덱스 다이제스트 확인은 바이트 무결성까지다. 패키지 안의 manifest 2-of-3·의존성 버전 검사는 클라이언트가 한다(D03 §3.1).
- **롤아웃**: 서버는 기기를 모른다. 클라이언트가 `bucket = u32be(sha256("SAX-rollout-v1\0" ‖ id ‖ "\0" ‖ deviceId)[0..4]) mod 100`을 계산해 `bucket < rolloutPercent`일 때만 받는다(1 → 10 → 100).

### 정책

`packages/policy/schemas/policy.schema.json` 내용 + `version`(`YYYY.MM[.n]`)·`monotonic`·`keyEpoch`·`issuedAt`·`expiresAt`·`signatures`·`timestamp`. 레지스트리는 서명·신선도·버전만 본다. 긴급 키(1개) 서명본은 `emergency: true`로 응답하고, 필드별 "엄격하게 보수적" 판정(D03 §7.1)은 엔진이 한다.

### status

```json
{ "monotonic": 3, "keyEpoch": 1, "issuedAt": "…", "expiresAt": "…",
  "portalModeCeiling": { "hometax": "assisted", "gov24": "assisted", "iros": "postprocess" },
  "killPlaybooks": ["hometax_cert_issue"], "signatures": [ … ], "timestamp": { … } }
```

- 상한 순서 `postprocess < assisted < auto`. 없는 포털 = 상한 없음.
- **긴급 키 1개**는 직전 status보다 엄격하게 보수적일 때만: 모든 포털 상한 ≤ 이전(상한을 빼면 완화로 본다), `killPlaybooks` ⊇ 이전, 하나 이상 엄격, 다른 필드 없음. 아니면 `registry.not_conservative`. 상향·킬 해제는 정책 키 2-of-3만.

### 폐기 목록

```json
{ "monotonic": 2, "keyEpoch": 1, "issuedAt": "…", "expiresAt": "…",
  "revoked": [ { "keyId": "package-1", "role": "package", "revokedAt": "…" } ],
  "signatures": [ 루트 2개 ], "timestamp": { … } }
```

`revoked` ≤ 64. 루트 서명과 타임스탬프 서명은 **이전** 폐기 목록으로 걸러 센다(루트·타임스탬프 키도 폐기될 수 있다). 타임스탬프 키를 폐기하는 목록은 그 키로 마지막으로 찍을 수 있고, 그 뒤에는 정책·status·폐기 목록 모두 그 키로 신선해질 수 없다(`registry.key_revoked`). 타임스탬프 키는 하나뿐이라 새 keyEpoch(앱 업데이트)까지 클라이언트는 stale로 보수적으로 멈춘다. 클라이언트는 24시간 안의 목록이 없으면 새 패키지·정책 로드를 보류한다(`registry.revocation_stale`).

### 릴리스 매니페스트 → latest.yml

```json
{ "channel": "stable", "version": "1.2.0", "releaseDate": "…", "expiresAt": "…", "rolloutPercent": 10,
  "files": [ { "url": "tex-Setup-1.2.0.exe", "sha512": "<base64 88자>", "size": 123456 } ],
  "signature": { "keyId": "release-1", "alg": "ed25519", "sig": "…" } }
```

`files` 1~8개, `url`은 `^[A-Za-z0-9._-]{1,128}$`(경로·개행 없음, YAML 주입 없음). `latest.yml`은 이 매니페스트에서 `version`·`files`·`path`·`sha512`·`releaseDate`만 옮긴다. 클라이언트 main은 `latest.json` 서명·만료·다운그레이드를 직접 검증한 뒤에만 electron-updater에 sha512를 넘긴다(ADR-028).

## 오류 코드

`registry.signature_insufficient`·`registry.key_revoked`·`registry.version_jump_rejected`·`registry.issued_in_future`·`registry.expired`·`registry.status_stale`·`registry.revocation_stale`·`registry.not_conservative`·`registry.portal_blocked`·`registry.content_digest_mismatch`(422), `registry.not_found`(404), `registry.unauthorized`(401), `request.param_rejected`(400). 본문은 `{"error": "<코드>"}`만이고 입력을 되풀이하지 않는다.
