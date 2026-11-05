# 서명 바이트 규약 v1

> 정본. 레지스트리 서명 도구(D09 §8, 클라우드 트랙 M4-7)와 엔진(`poc/packages/engine/src/core/registry.ts`·`loader.ts`·`canon.ts`)이 같은 바이트를 쓴다. 팀장 확정 2026-11-05, 엔진 PR #52. 이 문서는 "무엇을 어떤 바이트로 서명하는가"만 정한다. 키·역할·쿼럼·발행 절차는 D09 §8, 수용 규칙은 D03 §3.1·§7.1에 있다. 바꾸려면 ADR이 필요하다.

## 1. 공통

- **서명 알고리즘**: Ed25519(RFC 8032, 순수 Ed25519, 사전 해시 없음). 서명 객체는 `{keyId, alg: "ed25519", sig}`이고 `sig`는 64바이트 서명의 base64url(패딩 없음, 86자)이다.
- **정규화**: 서명 입력은 JSON 값을 **JCS(RFC 8785)** 로 직렬화한 UTF-8 바이트다. 키는 UTF-16 코드 단위 순, 공백 없음, 숫자는 ECMAScript 직렬화(소수 허용, 예: `1.5`), 문자열은 RFC 8785 이스케이프.
- **맥락 문자열 없음**: 서명 입력 앞에 접두사나 도메인 문자열을 붙이지 않는다. 문서 종류는 (1) 역할별로 다른 키(패키지·정책·루트·타임스탬프·긴급), (2) 스키마(`additionalProperties: false`라 한 종류의 본문이 다른 종류로 통과하지 않음), (3) 타임스탬프 본문의 `contentDigest`로 구분한다.
- **다이제스트**: SHA-256, 소문자 16진수 64자.
- **"문서 − 필드"**: 최상위 필드만 뺀 객체를 JCS로 직렬화한 것. 빼는 필드가 없어도 오류가 아니다.

## 2. 문서별 서명 대상

| 문서 | 내용 서명 바이트 | 서명 키(쿼럼) | 신선도 |
|---|---|---|---|
| `manifest.json`(패키지) | JCS(manifest − `signatures`) | 패키지 키 2-of-3 | 인덱스(14일) |
| `hotfix.json` | JCS(hotfix − `signatures`) | 패키지 키 2-of-3 | 문서 안 `issuedAt`·`expiresAt`(≤ 14일, 서명 대상에 포함) |
| `policy/{ver}.json`·`current.json` | JCS(policy − `signatures`·`issuedAt`·`expiresAt`·`timestamp`) | 정책 키 2-of-3, 또는 1인 긴급 키(엄격하게 보수적일 때만) | `timestamp`(≤ 72시간, 48시간마다 재서명) |
| `registry/status.json` | JCS(status − `signatures`·`issuedAt`·`expiresAt`·`timestamp`) | 정책 키 2-of-3, 또는 1인 긴급 키(하향·킬스위치 추가만) | `timestamp`(≤ 48시간, 48시간마다 재서명) |
| `registry/revoked_keys.json` | JCS(list − `signatures`·`issuedAt`·`expiresAt`·`timestamp`) | 오프라인 루트 키 2-of-3 | `timestamp`(≤ 24시간) |

정책·status·폐기 목록의 **내용 다이제스트** `contentDigest` = SHA-256(위 "내용 서명 바이트")다. 내용이 바뀌면 `monotonic`을 올린다.

## 3. 쿼럼 세기

- 앱에 핀 고정된 그 역할의 키 가운데 **서로 다른 keyId**의 유효 서명만 센다. 같은 키 두 번은 1개다. 다른 역할의 키, 모르는 keyId, `alg`가 `ed25519`가 아닌 항목은 세지 않는다(오류도 아니다).
- 폐기 목록(`revoked_keys.json`)에 있는 keyId의 서명은 세지 않고 `registry.key_revoked`를 남긴다. 폐기 목록 자체의 루트 서명에는 이 규칙을 적용하지 않는다(루트 키 교체는 앱 업데이트).
- 아티팩트의 `keyEpoch`는 앱에 핀 고정된 세대와 같아야 한다(`registry.key_epoch_mismatch`).

## 4. 타임스탬프(신선도) 서명

- 서명 바이트 = JCS(`{contentDigest, monotonic, issuedAt, expiresAt}`). 네 필드 모두 그 문서의 값이다.
- 서명 키 = 온라인 타임스탬프 키 1개(HSM, 자동). 문서의 `timestamp` 필드에 `{keyId, alg, sig}`로 싣는다.
- 내용이 그대로면 `monotonic`을 바꾸지 않고 `issuedAt`·`expiresAt`·`timestamp`만 새로 발행한다(재서명). 엔진은 같은 `monotonic`을 **내용 다이제스트가 같을 때만** 받는다. 1인 긴급 status의 72시간 만료는 그 내용이 처음 발행된 시각부터 세며 재서명으로 늘어나지 않는다.

## 5. 다이제스트 결속

| 이름 | 정의 | 쓰는 곳 |
|---|---|---|
| `contentDigests.{playbook,selectors,strings}` | 레지스트리에서 받은 **원시 파일 바이트**의 SHA-256(정규화하지 않음) | manifest 안, 로더 2단계 |
| manifest 다이제스트 | SHA-256(JCS(manifest − `signatures`)) | 조회 패키지의 `lookupsUsed[].digest`, `hotfix.appliesTo.packageDigest` |
| 핫픽스 다이제스트 | SHA-256(JCS(hotfix − `signatures`)) | `packageDigest`, 설치된 핫픽스 재로드 판정 |
| `packageDigest`(B-08) | SHA-256(JCS(`{manifest, hotfix, lookups, policyVersion, profileVersion}`)) — `manifest`·`hotfix`는 위 다이제스트(핫픽스가 없으면 `null`), `lookups`는 조회 패키지 manifest 다이제스트 배열(manifest의 `lookupsUsed` 순서) | 실행 기록·Paused 재개 비교 |

## 6. 버전

같은 `keyEpoch` 안에서 `monotonic`은 늘기만 하고 한 번에 +1000을 넘지 않는다(`registry.version_rollback`·`registry.version_jump_rejected`). 폐기 목록은 이전 목록의 상위 집합이어야 한다(`registry.revoked_shrunk`). 패키지 manifest에는 `monotonic`이 없어 semver로 내림만 막는다.

## 7. 범위 밖

- 인덱스(`registry/{channel}/index.json`) 서명 형식은 인덱스 로더와 같이 정한다(아직 없음). 위 규칙(문서 − `signatures`, 패키지 키 2-of-3)을 따를 예정이다.
- 투명성 로그 트리 헤드: 해시는 RFC 9162(잎 `0x00`, 노드 `0x01` 접두)이고 엔진의 `merkleRoot`·`verifyConsistency`가 그 형식이다. 트리 헤드 서명 바이트는 D09 §8과 같이 정한다.
- 게이트 토큰(실행 안 HMAC·결정적 CBOR)은 레지스트리 서명이 아니다(D03 §3).

## 8. 시험 벡터

시드 32바이트 `0x07`×32인 Ed25519 키(공개키 `ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c`)로 아래 status에 서명한다. `tests/core-signing.test.ts`가 이 절의 값을 그대로 확인한다.

```json
{"monotonic": 12, "keyEpoch": 1, "issuedAt": "2026-11-05T09:00:00+09:00", "expiresAt": "2026-11-07T09:00:00+09:00",
 "portals": {"hometax": {"portalModeCeiling": "assisted"}}, "killPlaybooks": ["hometax.invoice.cancel"]}
```

- 내용 서명 바이트: `{"keyEpoch":1,"killPlaybooks":["hometax.invoice.cancel"],"monotonic":12,"portals":{"hometax":{"portalModeCeiling":"assisted"}}}`
- `contentDigest`: `960fa381ff5e85c96ea19fa550056a80c59654b086c4da6817cc29968b1aedd8`
- 내용 서명: `whHR0DfMIHrCZGhswD3z4awfYcXMfmJ20j2V8dcbi0E-f6b4ssthUdvPBpQup-TWC2V3JPNY4lxxt6VOYuDeBA`
- 타임스탬프 서명 바이트: `{"contentDigest":"960fa381ff5e85c96ea19fa550056a80c59654b086c4da6817cc29968b1aedd8","expiresAt":"2026-11-07T09:00:00+09:00","issuedAt":"2026-11-05T09:00:00+09:00","monotonic":12}`
- 타임스탬프 서명: `ssiYnoIxQ3JO0LWALi6fyo8hEBJgaIpUAEPOceAX-X0GNaKJxnUNZWnuH9YLgnV2xMLG-NCjK9-3X1nxgmZfAg`
