# 레지스트리 샘플 묶음(고정 시드, 시험 전용)

클라우드 레지스트리(`services/registry`)와 엔진의 상호 검증용 샘플이다. 서명 바이트 규약은 [SIGNING.md](../../../../sovereign-ax/design/schemas/SIGNING.md)를 따른다. **키는 공개된 시험 시드라 실제 운영에 쓰면 안 된다.**

- 키: Ed25519 개인키 시드 = 32바이트를 아래 값으로 채운 것. 공개키는 `trust.json`(역할 → keyId → 표준 base64 32바이트, `services/registry` TrustRoot 모양).
  - root-1/2/3 = `0x11`/`0x12`/`0x13`, package-1/2/3 = `0x21`/`0x22`/`0x23`, policy-1/2/3 = `0x31`/`0x32`/`0x33`, emergency-1 = `0x41`, timestamp-1 = `0x51`, release-1 = `0x61`(릴리스 역할, 앱 업데이트 서명. 엔진 TrustRoots에는 없고 `trust.json`에만 있다). keyEpoch = 1.
- 기준 시각: `2026-11-05T06:00:00Z`. 이 시각에 모든 문서가 유효하다(발행 `2026-11-05T00:00:00Z`).
- 파일:
  - `packages/*.sxp`: H-01 `hometax.invoice.issue@2.1.0`, 조회 패키지 2개(`@1.0.0`), 핫픽스 `hometax.invoice.issue.hotfix@1.3.0`(keyEpoch 1, monotonic 3). 데이터 패키지 `payroll.rate-tables@2026.11.1`(SIGNING.md §6 `kind: "data"`, 본문 `sax.rate-tables/v1` 비과세 표 하나, 값은 시험용). 패키지·핫픽스·데이터 기술자 서명은 package-1·2.
  - `registry/stable/index.json`·`registry/hotfix/index.json`: package-1·2 서명, 항목의 `sxpDigest`·`size` = 파일 바이트. stable 인덱스에 데이터 항목(`kind: "data"`, `portal` 없음)이 함께 있다.
  - `policy/current.json`: policy-1·2 + timestamp-1.
  - `registry/status.json`(policy-1·2, monotonic 10)과 그 위의 `registry/status-emergency.json`(emergency-1 한 개, monotonic 11, hometax 하향·킬 추가).
  - `registry/revoked_keys.json`: root-1·2 + timestamp-1. 핀에 없는 `package-0` 하나만 폐기한다.
- 엔진 확인: `poc/tests/core-registry-samples.test.ts`(파일 = 생성 결과 바이트 비교, 로더·데이터 로더(급여 `validatePackage`)·정책·status·폐기 목록 수용).
- 다시 만들기(생성기 `poc/tests/registry-samples.ts`): `cd poc && SAX_WRITE_REGISTRY_SAMPLES=1 node --test --conditions=development tests/core-registry-samples.test.ts`. 골든 픽스처(`tests/fixtures/core`)가 바뀌면 다시 만들어야 한다.
