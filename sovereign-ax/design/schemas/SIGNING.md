# 서명 바이트 규약 v1

> 2026-11-06 팀장 결정(#120): §8에 서버 서명 계정 클레임 `SAX-acct-claim-v1`(이메일 전체, `exp = iat + 10분`, account 서비스 전용 키, 앱 고정)을 더했다. 이 문서를 바꿀 때 필요한 ADR은 ADR-016 개정 메모다.
> 정본. 레지스트리 서명 도구·게시 관문(D09 §8, 클라우드 트랙 `services/registry`, M4-7), 엔진(`poc/packages/engine/src/core/registry.ts`·`loader.ts`·`datapkg.ts`·`sxp.ts`·`canon.ts`), 금고·폰·클라우드의 기기·AIK 서명(§8)이 같은 바이트를 쓴다. 팀장 확정 2026-11-05(엔진 PR #52, 레지스트리 대조 결정 포함). 이 문서는 "무엇을 어떤 바이트로 서명하는가"만 정한다. 키·역할·쿼럼·발행 절차는 D09 §8, 수용 규칙은 D03 §3.1·§7.1, 기기 키 계층은 D08 §2.1·§3에 있다. 바꾸려면 ADR이 필요하다.

## 1. 공통

- **서명 알고리즘**: Ed25519(RFC 8032, 순수 Ed25519, 사전 해시 없음).
- **정규화**: JSON 서명 입력은 값을 **JCS(RFC 8785)** 로 직렬화한 UTF-8 바이트다. 키는 UTF-16 코드 단위 순, 공백 없음, 숫자는 ECMAScript 직렬화(**소수 허용**, 예: 정책 `slowFactor: 1.5`), 문자열은 RFC 8785 이스케이프. 정수만 받는 구현은 레지스트리 정책에 쓸 수 없다.
- **다이제스트**: SHA-256, 소문자 16진수 64자.
- **"문서 − 필드"**: 최상위 필드만 뺀 객체를 JCS로 직렬화한 것. 빼는 필드가 없어도 오류가 아니다.
- **레지스트리 산출물(§2~§7)**: 맥락 문자열 없음. 서명 객체는 `{keyId, alg: "ed25519", sig}`이고 `sig`는 64바이트 서명의 **base64url(패딩 없음, 86자)**. 문서 종류는 (1) 역할별로 다른 키, (2) 스키마(`additionalProperties: false`라 한 종류의 본문이 다른 종류로 통과하지 않음), (3) 타임스탬프 본문의 `contentDigest`로 구분한다.
- **기기·AIK 서명(§8)**: 맥락 문자열을 앞에 붙이고 **표준 base64(패딩 있음)** 로 싣는다. 두 체계는 키가 겹치지 않는다(레지스트리 키는 우리 HSM·스마트카드, 기기·AIK 키는 사용자 기기).

## 2. 레지스트리 문서별 서명 대상

| 문서 | 내용 서명 바이트 | 서명 키(쿼럼) | 신선도 |
|---|---|---|---|
| `manifest.json`(패키지, `.sxp` 안) | JCS(manifest − `signatures`) | 패키지 키 2-of-3 | 인덱스(14일) |
| `hotfix.json`(`.sxp` 안) | JCS(hotfix − `signatures`) | 패키지 키 2-of-3 | 문서 안 `issuedAt`·`expiresAt`(≤ 14일, 서명 대상에 포함) |
| 데이터 기술자(`.sxp` kind:data 안, §6) | JCS(descriptor − `signatures`). 본문은 `bodyDigest` = SHA-256(본문 원시 바이트)로 묶는다 | 패키지 키 2-of-3 | 인덱스(14일) |
| `registry/{channel}/index.json` | JCS(index − `signatures`·`issuedAt`·`expiresAt`·`timestamp`) | 패키지 키 2-of-3 | `timestamp`(≤ 14일, 48시간마다 재서명, [ADR-043](../adr/ADR-043-index-freshness-timestamp.md)) |
| `policy/{ver}.json`·`current.json` | JCS(policy − `signatures`·`issuedAt`·`expiresAt`·`timestamp`) | 정책 키 2-of-3, 또는 1인 긴급 키(엄격하게 보수적일 때만) | `timestamp`(≤ 72시간, 48시간마다 재서명) |
| `registry/status.json` | JCS(status − `signatures`·`issuedAt`·`expiresAt`·`timestamp`) | 정책 키 2-of-3, 또는 1인 긴급 키(하향·킬스위치 추가만) | `timestamp`(≤ 48시간, 48시간마다 재서명) |
| `registry/revoked_keys.json` | JCS(list − `signatures`·`issuedAt`·`expiresAt`·`timestamp`) | 오프라인 루트 키 2-of-3 | `timestamp`(≤ 24시간) |

- status 모양: `{monotonic, keyEpoch, issuedAt, expiresAt, portalModeCeiling: {portal: mode}, killPlaybooks: [id], signatures, timestamp}`([status.schema.json](status.schema.json)). 없는 포털 = 추가 상한 없음.
- 폐기 목록 모양: `{monotonic, keyEpoch, issuedAt, expiresAt, revoked: [{keyId, role, revokedAt}], signatures, timestamp}`([revoked_keys.schema.json](revoked_keys.schema.json)), `revoked` ≤ 64, keyId 중복 없음.
- 정책·status·폐기 목록·인덱스의 **내용 다이제스트** `contentDigest` = SHA-256(위 "내용 서명 바이트")다. 내용이 바뀌면 `monotonic`을 올린다.
- 인덱스 모양: `{channel, monotonic, keyEpoch, issuedAt, expiresAt, entries: [{id, version, kind, portal?, sxpDigest, size, rolloutPercent, minAppVersion?}], signatures, timestamp}`. 인덱스는 2026-11-09까지 `JCS(index − signatures)`에 서명하고 타임스탬프가 없었다. ADR-043부터 옛 형식은 받지 않는다(게시된 적이 없다).
- 긴급 status는 직전 status가 없어도(첫 설치) "상한 없음·킬 없음" 대비 엄격하게 보수적이면 받는다.

## 3. 쿼럼 세기와 폐기

- 앱에 핀 고정된 그 역할의 키 가운데 **서로 다른 keyId**의 유효 서명만 센다. 같은 키 두 번은 1개다. 다른 역할의 키, 모르는 keyId, `alg`가 `ed25519`가 아닌 항목은 세지 않는다(오류도 아니다). 서명 배열은 최대 3개.
- 폐기는 **모든 역할**(루트·패키지·정책·타임스탬프·긴급·릴리스)에 적용한다. 폐기 목록에 있는 keyId의 서명은 세지 않고 `registry.key_revoked`를 남긴다.
  - 폐기 목록 자체의 **루트 서명**은 지금 받아 둔 **이전** 폐기 목록으로 걸러 센다(루트 키도 폐기될 수 있다). 그 목록의 **타임스탬프 서명**은 새 목록으로 거른다.
  - 그 밖의 문서는 지금 받아 둔 폐기 목록으로 거른다(타임스탬프 키 포함).
- 아티팩트의 `keyEpoch`는 앱에 핀 고정된 세대와 같아야 한다(`registry.key_epoch_mismatch`).

## 4. 타임스탬프(신선도) 서명

- 서명 바이트 = JCS(`{contentDigest, monotonic, issuedAt, expiresAt}`). 네 필드 모두 그 문서의 값이다.
- 서명 키 = 온라인 타임스탬프 키 1개(HSM, 자동). 문서의 `timestamp` 필드에 `{keyId, alg, sig}`로 싣는다.
- 내용이 그대로면 `monotonic`을 바꾸지 않고 `issuedAt`·`expiresAt`·`timestamp`만 새로 발행한다(재서명). 같은 `monotonic`은 **내용 다이제스트가 같을 때만** 받는다. 1인 긴급 status의 72시간 만료는 그 내용이 처음 발행된 시각부터 세며 재서명으로 늘어나지 않는다.

## 5. 다이제스트 결속

| 이름 | 정의 | 쓰는 곳 |
|---|---|---|
| `sxpDigest` | `.sxp` 파일 바이트의 SHA-256 | 인덱스 항목(`size`와 함께) |
| `contentDigests.{playbook,selectors,strings}` | 패키지 안 **원시 파일 바이트**의 SHA-256(정규화하지 않음) | manifest 안, 로더 2단계 |
| manifest 다이제스트 | SHA-256(JCS(manifest − `signatures`)) | 조회 패키지의 `lookupsUsed[].digest`, `hotfix.appliesTo.packageDigest` |
| 핫픽스 다이제스트 | SHA-256(JCS(hotfix − `signatures`)) | `packageDigest`, 설치된 핫픽스 재로드 판정 |
| `packageDigest`(B-08) | SHA-256(JCS(`{manifest, hotfix, lookups, policyVersion, profileVersion}`)) — `manifest`·`hotfix`는 위 다이제스트(핫픽스가 없으면 `null`), `lookups`는 조회 패키지 manifest 다이제스트 배열(`lookupsUsed` 순서) | 실행 기록·Paused 재개 비교 |

`packageDigest`라는 이름은 B-08 결속값과 `hotfix.appliesTo.packageDigest`(= manifest 다이제스트)에만 쓴다. 인덱스의 파일 다이제스트는 `sxpDigest`다.

## 6. `.sxp` 컨테이너 v1

레지스트리 경로 `/packages/{id}@{version}.sxp`의 바이트 형식이다. 컨테이너 자체는 서명하지 않는다. 인덱스의 `sxpDigest`가 바이트를, 안의 manifest·hotfix·데이터 기술자 서명(2-of-3)이 내용을 묶는다.

- 바이트 = utf8(JCS(객체)), 최대 16MB. 파서는 **정규형만** 받는다(재직렬화가 같지 않으면 `sxp.not_canonical`). 같은 내용이 다른 바이트(다른 `sxpDigest`)로 나오지 않게 하려는 것이다.
- 패키지(`kind`가 `playbook`·`lookup`인 manifest): `{"format": "sxp/1", "kind": "package", "manifest": b64, "playbook": b64, "selectors": b64, "strings": b64}`. 각 값은 원시 파일 바이트의 표준 base64(패딩 있음, RFC 4648 §4)다. 키는 정확히 이 여섯 개다.
- **핫픽스도 `.sxp`다**: `{"format": "sxp/1", "kind": "hotfix", "hotfix": b64}`, 값은 hotfix 문서 바이트(JCS 권장)의 표준 base64다. 인덱스는 `hotfix` 채널, 항목 `kind: "hotfix"`, `id` = `<appliesTo.id>.hotfix`, `version` = `<keyEpoch>.<monotonic>.0`이다. semver 순서가 (keyEpoch, monotonic) 순서와 같고, 핫픽스마다 불변 경로가 다르다. 패키지 id는 `.hotfix`로 끝날 수 없다.
- **데이터 패키지**(인덱스 `kind: "data"`, D14 M6-10. 급여 시행일 표처럼 플레이북이 아닌 서명 데이터): `{"format": "sxp/1", "kind": "data", "descriptor": b64, "body": b64}`. 키는 정확히 이 네 개다.
  - `descriptor`는 기술자 문서 바이트(JCS 권장)의 표준 base64다. 모양은 `{id, version, schema, bodyDigest, keyEpoch, issuedAt, signatures}`([data_descriptor.schema.json](data_descriptor.schema.json))이고, 서명은 패키지 키 2-of-3, 대상은 JCS(descriptor − `signatures`)다(§2).
  - `body`는 본문 원시 바이트의 표준 base64다. `bodyDigest` = SHA-256(원시 바이트)다. 본문은 UTF-8 JSON이고 모양은 `schema`가 가리키는 스키마가 정한다(예: `sax.rate-tables/v1` = `poc/packages/payroll/schema/rate-table-package.schema.json`, 의미 규칙은 D07 `rate_tables`·D09 §8.4). 본문의 `schema`·`packageVersion`은 기술자의 `schema`·`version`과 같아야 한다.
  - 인덱스 항목은 `{id, version, kind: "data", sxpDigest, size, rolloutPercent}`이고 `portal`이 없다. `id` = 기술자 `id`, `version` = 기술자 `version`이다. 데이터 id도 `.hotfix`로 끝날 수 없다.
  - 엔진 수용 순서(`loadDataPackage`): 기술자 스키마 → JCS 가능 → `.hotfix` id 금지 → `keyEpoch` = 핀 → `issuedAt`이 미래가 아님(허용 오차 5분, 핫픽스·status와 같다) → 패키지 키 2-of-3(폐기 반영) → 보류(hold) 중이면 설치본과 같은 기술자만 → `bodyDigest` → 앱이 그 `schema` 이름으로 등록한 검증기(**없으면 거부**, fail-closed) → 본문 `schema`·`packageVersion` 대조 → 같은 id의 버전 내림 금지(같은 버전은 기술자 다이제스트가 같을 때만 재로드).
  - 수용 오류 코드: `loader.manifest_unparsable`(기술자)·`loader.schema_invalid`(기술자·본문, 규칙 DATA-1·DATA-2)·`registry.key_epoch_mismatch`·`registry.issued_in_future`·`registry.signature_insufficient`·`registry.update_held`·`loader.content_digest_mismatch`·`loader.data_schema_unknown`(새 코드)·`loader.content_unparsable`·`registry.version_rollback`. 폐기 키가 섞이면 이벤트 `registry.key_revoked`.
- 오류 코드: `sxp.too_large`·`sxp.malformed`·`sxp.not_canonical`·`sxp.unknown_format`(`format` ≠ `sxp/1`).

## 7. 버전

- 같은 `keyEpoch` 안에서 `monotonic`은 늘기만 하고 한 번에 +1000을 넘지 않는다(`registry.version_rollback`·`registry.version_jump_rejected`).
- 폐기 목록은 이전 목록의 상위 집합이어야 한다(`registry.revoked_shrunk`).
- 패키지 manifest에는 `monotonic`이 없어 semver로 내림만 막는다. 인덱스 `monotonic`은 채널마다 따로 센다.

## 8. 기기·AIK 서명 입력

폰·금고·클라우드가 따른다(D08 §2.1 맥락 표, D05 §5.1, `poc/services/shared/CONTRACT.md` §1·§3).

- **키 이름**: `Sx`(X25519 Noise 정적키), `Vx`(Ed25519 서명키), `Kx`(X25519 비밀 봉인 키: 데스크톱 `Kv`, 모바일 `Km`), `Px`(모바일 SE/StrongBox P-256 비가역 승인 키). `x` = `d`(데스크톱)·`m`(모바일). AIK = 계정 신원 키(Ed25519).
- **기기 키(`Vd`·`Vm`, 통칭 `Vx`) 서명 입력** = `purpose ‖ msg`(D05 §5.1). `purpose`는 D08 §2.1 맥락 문자열의 UTF-8 바이트이고, **구분 바이트가 없다**. `msg`는 그 맥락이 정한 바이트이며 JSON 객체면 utf8(JCS(객체))다. 금고는 `purpose`를 허용 목록(`vault.vdPurposes`)으로 고정 비교한다.
- **AIK 서명 객체의 정규형** = `utf8(ctx) ‖ JCS(JSON)`: 맥락 문자열(`SAX-devlist-v1`·`SAX-revoke-v1`·`SAX-cert-v1`·`SAX-aik-rotate-v1`·`SAX-kek-v1`·`SAX-acct-op-v1`) 뒤에 대상 객체의 JCS 바이트를 붙인다. 구분 바이트가 없다.
- **인코딩**: 서명(64바이트)·공개키(32바이트)는 **표준 base64(패딩 있음)**. 토큰·DPoP의 바깥 형식만 base64url(패딩 없음)이다(CONTRACT.md §2·§3).
- 이 객체들의 값은 정수·문자열·불리언뿐이다(시각은 UTC 밀리초 정수, DPoP `iat`만 초). §1의 JCS 규칙과 같다.
- **서버 서명 계정 클레임**(팀장 결정 2026-11-06, ADR-016 개정): `SAX-acct-claim-v1`의 서명 입력은 `utf8("SAX-acct-claim-v1") ‖ JCS({account_id, email, aik_pub, iat, exp})`다. 구분 바이트는 없다. `email`은 가리지 않은 전체 문자열, `aik_pub`는 표준 base64, `iat`·`exp`는 UTC 밀리초 정수이고 `exp = iat + 600000`이다. 서명 키는 account 서비스의 전용 Ed25519 키다. 레지스트리 키·토큰 키(`SAX-token-v1`)와 섞지 않는다. 공개키는 앱에 고정하고, 교체는 레지스트리 핀 키 규칙(`keyEpoch`, ADR-028 결정 3)을 따른다. 폰은 서명·`exp`·`aik_pub == PAIR_OK.AIK_pub`를 검증한다(D08 §4.2 7단계).
- `Px`(P-256) 서명의 바이트 형식은 D08 §6.1이 정한다. 이 절은 Ed25519 키(`Vx`·AIK·계정 클레임 서버 키)만 다룬다.

## 9. 범위 밖

- 투명성 로그 트리 헤드: 해시는 RFC 9162(잎 `0x00`, 노드 `0x01` 접두)이고 엔진의 `merkleRoot`·`verifyConsistency`가 그 형식이다. 트리 헤드 서명 바이트는 D09 §8과 같이 정한다.
- 릴리스 매니페스트(`releases/{channel}/latest.json`)는 `services/registry` API.md가 정한다.
- 게이트 토큰(실행 안 HMAC·결정적 CBOR)은 레지스트리 서명이 아니다(D03 §3).

## 10. 시험 벡터와 샘플

### 10.1 레지스트리 status

시드 32바이트 `0x07`×32인 Ed25519 키(공개키 `ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c`)로 아래 status에 서명한다. `poc/tests/core-signing.test.ts`가 이 절의 값을 그대로 확인한다.

```json
{"monotonic": 12, "keyEpoch": 1, "issuedAt": "2026-11-05T09:00:00+09:00", "expiresAt": "2026-11-07T09:00:00+09:00",
 "portalModeCeiling": {"hometax": "assisted"}, "killPlaybooks": ["hometax.invoice.cancel"]}
```

- 내용 서명 바이트: `{"keyEpoch":1,"killPlaybooks":["hometax.invoice.cancel"],"monotonic":12,"portalModeCeiling":{"hometax":"assisted"}}`
- `contentDigest`: `3f95477f12f9d94d2c939c24f952a1455c7c5fab54cff87b7c5c87a7efdb0c3f`
- 내용 서명: `J-a3R1E-ApuD_kRTnNOUliWZAvTMRZNHspOoSCwQcjQIbtqQN73-R9FTHktrAfzaMQtHfQ1nDm0i8bNcckT7Aw`
- 타임스탬프 서명 바이트: `{"contentDigest":"3f95477f12f9d94d2c939c24f952a1455c7c5fab54cff87b7c5c87a7efdb0c3f","expiresAt":"2026-11-07T09:00:00+09:00","issuedAt":"2026-11-05T09:00:00+09:00","monotonic":12}`
- 타임스탬프 서명: `qdPdQs3dFaYwy_bgdXmtTvJDJo0QWgmdGAXZxc0Vjyrt_SAtzFbrpUc2x8SSF2Ueyt7r4LVhzHu9WSqeQMrwAw`

### 10.2 AIK 서명(§8)

같은 키를 AIK로 쓰고, 맥락 `SAX-devlist-v1`로 기기 목록 항목 `{device_id: "dev-desktop-1", role: "desktop", Sx: base64(0x09×32), Vx: base64(0x0a×32), registered_at: 1762300800000, list_version: 1}`에 서명한다.

- AIK 대상 JCS: `{"Sx":"CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=","Vx":"CgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo=","device_id":"dev-desktop-1","list_version":1,"registered_at":1762300800000,"role":"desktop"}`
- AIK 서명 입력: utf8(`SAX-devlist-v1`) ‖ 위 바이트(구분 바이트 없음)
- AIK 서명: `RgGhJJJEIu/YjYRPZqAkgKAU0zTfSmqvz4ubzpTDj3rAVUQb42DbYbSMLidmDKFYdkCnwkS5sRULRYOmRAd0Dw==`

### 10.3 레지스트리 샘플 묶음

`poc/tests/fixtures/registry/`에 고정 시드 키로 서명한 상호 검증용 샘플이 있다. 엔진은 `poc/tests/core-registry-samples.test.ts`로 이 파일을 모두 받고, 클라우드 레지스트리는 같은 파일로 자기 검증기를 돌린다. 키·기준 시각·다시 만드는 법은 그 폴더의 README.md에 있다.
