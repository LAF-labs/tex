# 레지스트리 서명 의식 절차서 — 단독 모드 (keyEpoch 1)

근거:
- ADR-037(Phase 1 단독 보유, 설계 세션 작성 중)
- D09 §8.2(역할·정족수)·§8.4(폐기·keyEpoch)·§8.5(긴급 키)
- [SIGNING.md](../../../sovereign-ax/design/schemas/SIGNING.md) §1~§4(서명 바이트)
- ADR-013·023·028
- 팀장 결정 2026-11-06: 물리 키 없음, Phase 1은 사용자 혼자 보유. macOS 키체인 + Touch ID, 역할마다 Ed25519 키 3개, 생체 인증 필수, 디스크 평문 금지, 암호로 잠근 오프라인 백업 1개. YubiKey PIV는 승격 때 쓴다(인터페이스만).
- 팀장 결정 2026-11-06(타임스탬프): 타임스탬프 키는 서버 온라인 키다(ADR-037 결정 (3), D09 §8.2). 운영 env `REGISTRY_LOG_SIGNING_KEY`와 같은 키다. 맥 키체인에 두지 않는다. 신선도 재서명은 서버 Cron이 자동으로 한다.

도구:
- CLI `services/registry/src/ceremony/cli.ts`(아래 `ceremony`)

  ```bash
  node --conditions=development services/registry/src/ceremony/cli.ts <명령> …
  ```

- macOS 도우미 `services/registry/src/ceremony/macos/sax-keychain.swift`
- 시험 `tests/registry-ceremony.test.ts`(가짜 키체인 백엔드, macOS에서는 도우미를 빌드해 시험 벡터를 대조)

## 1. 무엇을 지키나

- **시드 평문은 디스크·키체인 어디에도 없다.**
  - Ed25519 시드는 도우미 프로세스 안에서 만든다.
  - 곧바로 이 맥의 Secure Enclave P-256 키 W로 감싼다(부록 A). 로그인 키체인에는 감싼 블롭만 둔다.
- **풀 때마다 Touch ID.**
  - W의 접근 제어는 `privateKeyUsage + biometryCurrentSet`이다. W는 Secure Enclave 밖으로 나오지 않는다.
  - 지문을 새로 등록하면 W를 쓸 수 없게 된다(biometryCurrentSet). 그때는 백업으로 되살린다(§7).
- **서명은 도우미 메모리 안에서 한다.**
  - Touch ID → 풀기 → CryptoKit Ed25519 서명 → 시드 버퍼를 0으로 덮기
  - Node에는 서명만 간다. Touch ID 창에는 keyId와 확인 코드가 뜬다.
- 타임스탬프 키(`timestamp-1`)만은 서버 온라인 키다. 시드가 서버 비밀값(env)에 있다(§2). 이 키는 신선도만 서명하고 내용을 바꾸지 못한다.
- **예외는 백업 내보내기·들여오기뿐이다.** 그때만 시드가 Node 메모리를 지나간다. Node는 바로 scrypt + ChaCha20-Poly1305로 잠그거나(내보내기) 도우미에 넘겨 다시 감싸고(들여오기), 버퍼를 0으로 덮는다.
- **정족수는 그대로 2-of-3이다.** 모으는 도구는 서로 다른 핀 키 2개 이상인지 본다. 단독 모드에서 2-of-3은 **키 분리일 뿐 사람 분리가 아니다**. 한 사람·한 맥이 모든 키를 갖는다(ADR-037이 받아들인 남는 위험). 루트 메타데이터의 `mode: "solo"`가 이를 공개한다.

남는 위험(단독 모드):
- 맥이 잠금 해제된 채로 악성코드가 돌면, 사용자가 Touch ID를 누르는 순간 다른 문서에 서명할 수 있다. 막는 것은 Touch ID 창의 확인 코드다. 창의 코드가 `prepare`가 보인 코드와 같은지 보고 누른다.
- 사람 쿼럼이 없다. 사용자 계정이 털리면 모든 역할이 함께 위험하다. 그래서 보유자가 늘면 바로 승격한다(§8).
- 시드가 CryptoKit 내부 사본에 잠깐 있다. Swift·Node 모두 우리가 쥔 버퍼만 0으로 덮을 수 있다(최선 노력).

## 2. 키와 역할(keyEpoch 1, 한 세대 12개 = 맥 키체인 11 + 서버 1)

| keyId | 역할 | 정족수 | 서명하는 것 |
|---|---|---|---|
| `root-1`~`root-3` | 오프라인 루트 | 2-of-3 | 루트 메타데이터, 폐기 목록 본문, 릴리스 `rootChange`(핀·keyEpoch 변경) |
| `package-1`~`package-3` | 패키지 | 2-of-3 | 인덱스, `.sxp` 안 manifest·hotfix·데이터 기술자 |
| `policy-1`~`policy-3` | 정책 | 2-of-3 | 정책, `registry/status.json` |
| `emergency-1` | 1인 긴급 | 1 | 엄격하게 보수적인 정책·status 변경만(D03 §7.1), 72시간 자동 만료 |
| `release-1` | 앱 릴리스 | 1 | `releases/{channel}/latest.json` |
| `timestamp-1` | 타임스탬프(서버 온라인 키) | 1 | 폐기 목록 24시간·status·정책 48시간 신선도 재서명, 투명성 로그 헤드(서버 Cron이 자동) |

- 타임스탬프 말고 11개는 한 맥의 키체인에 있다(`backend: "macos-se"`).
- **`timestamp-1`은 서버 비밀값이다**(`backend: "server-env"`). 운영 env `REGISTRY_LOG_SIGNING_KEY`(Ed25519 시드 hex 64자)와 같은 키다.
  - 시드는 키체인 도구가 아니라 서버 env(배포 비밀 저장소)에 직접 넣는다.
  - 의식 때는 `timestamp-pubkey`로 **공개키만** 뽑아 TRUST_ROOT_JSON `keys.timestamp`에 넣는다(§4).
  - 도구는 타임스탬프 키를 키체인에 만들지 않는다(`keygen`이 거부한다). 다른 역할 키를 서버에 두는 기록도 거부한다.
- 사람이 매일 Touch ID로 재서명하는 방식은 쓰지 않는다. 하루만 놓쳐도 업데이트가 멈추기 때문이다.

## 3. 준비

- Apple 실리콘(또는 T2) 맥, macOS 14 이상, Touch ID 등록
- Xcode 명령줄 도구(`swiftc`)와 이 저장소(태그 고정 커밋)

도우미를 빌드한다. ad-hoc 서명으로 충분하다(실증: 서명 안 된·ad-hoc CLI에서 Secure Enclave 키 생성·키체인 저장이 된다).

```bash
mkdir -p ~/.sax/bin && swiftc -O services/registry/src/ceremony/macos/sax-keychain.swift -o ~/.sax/bin/sax-keychain && codesign -s - -f ~/.sax/bin/sax-keychain
```

W를 만들고 자체 시험을 한다. Touch ID 창이 한 번 뜬다. 자체 시험은 키체인에 아무것도 남기지 않는다.

```bash
~/.sax/bin/sax-keychain init
```

```bash
~/.sax/bin/sax-keychain selftest
```

- `{"ok":true}`면 Secure Enclave 풀기·서명이 이 맥에서 된다.
- 시험 벡터도 대조한다. 출력이 부록 A의 벡터와 같아야 한다.

  ```bash
  ~/.sax/bin/sax-keychain vector
  ```

## 4. 키 만들기와 오프라인 백업

```bash
node --conditions=development services/registry/src/ceremony/cli.ts keygen-all --holder "단독 보유자" --out-dir ceremony/keyepoch-1/keys
```

- 11개를 만든다(Touch ID 없음: 감쌀 때는 W 공개키만 쓴다). 공개키 기록 JSON이 나온다(비밀 없음).

타임스탬프 키의 공개키는 서버 시드에서 뽑는다. 시드는 출력·파일에 남지 않는다. 이 명령은 시드를 볼 수 있는 곳(배포 비밀 저장소를 여는 셸)에서만 돌린다. 시드를 새로 만들 때는 그 저장소에서 만들고, 이 맥에 두지 않는다.

```bash
REGISTRY_LOG_SIGNING_KEY=… node --conditions=development services/registry/src/ceremony/cli.ts timestamp-pubkey --out ceremony/keyepoch-1/keys/timestamp-1.json
```

**같은 날** 백업 1개를 만든다. Touch ID 한 번과 암호 두 번을 묻는다.

```bash
node --conditions=development services/registry/src/ceremony/cli.ts backup-export --out /Volumes/SAX-BACKUP/keyepoch-1.sax
```

- 암호는 20자 이상, 단어 5개 이상을 권한다. 이 암호는 어디에도 저장하지 않는다. 종이에 적어 봉인한다면 백업 매체와 다른 장소에 둔다.
- 파일은 `SAX-ceremony-backup-v1`이다(부록 B, scrypt N=2^17·r=8·p=1 + ChaCha20-Poly1305). 0600, 덮어쓰기 거부.
- 오프라인 매체(USB 2개, 서로 다른 장소)에 옮긴다. 이 맥에 남은 임시 사본은 지운다.
- 핀을 만든 뒤(§5) 백업이 열리고 핀과 같은지 확인한다(들여오지 않는다).

  ```bash
  node --conditions=development services/registry/src/ceremony/cli.ts backup-verify --in /Volumes/SAX-BACKUP/keyepoch-1.sax --trust ceremony/keyepoch-1/trust-root.json
  ```

## 5. TRUST_ROOT_JSON → 루트 2-of-3 → 핀 PR

```bash
node --conditions=development services/registry/src/ceremony/cli.ts trust --mode solo --key-epoch 1 --out-trust ceremony/keyepoch-1/trust-root.json --out-metadata ceremony/keyepoch-1/root-metadata.json ceremony/keyepoch-1/keys/*.json
```

- `trust-root.json`은 `{keyEpoch, keys: {역할: {keyId: base64}}}`이다(엔진 `TrustPin`·`@sax/updater` `TrustRoot`·`tests/fixtures/registry/trust.json` 모양).
- `root-metadata.json`(`sax.trust-root/v1`)은 핀 + keyId → 보유자 역할 표 + `mode: "solo"`다.

서명은 문서마다 세 단계다.
1. `prepare`가 확인 코드(SHA-256 앞 128비트, 4자씩 8묶음)를 보인다.

   ```bash
   node --conditions=development services/registry/src/ceremony/cli.ts prepare --kind trust_root ceremony/keyepoch-1/root-metadata.json
   ```

2. `sign`에 그 코드를 **눈으로 맞춰 다시 입력**한다. 도구가 다시 계산한 값과 다르면 도우미를 부르지 않는다. Touch ID 창에도 같은 코드가 뜬다.

   ```bash
   node --conditions=development services/registry/src/ceremony/cli.ts sign --kind trust_root --key-id root-1 --confirm <확인 코드> --trust ceremony/keyepoch-1/trust-root.json --out ceremony/keyepoch-1/sig/meta-root-1.json ceremony/keyepoch-1/root-metadata.json
   ```

   같은 명령을 `--key-id root-2`로 한 번 더 한다.

3. 모은다. **서로 다른 핀 키 2개 이상**이어야 한다. 같은 키 두 번, 다른 역할, 다른 문서, 서명 뒤 바뀐 문서, 4개 이상은 거부한다. 그 뒤 게시 관문과 같은 규칙으로 확인한다.

   ```bash
   node --conditions=development services/registry/src/ceremony/cli.ts collect --kind trust_root --trust ceremony/keyepoch-1/trust-root.json --out ceremony/keyepoch-1/root-metadata.signed.json ceremony/keyepoch-1/root-metadata.json ceremony/keyepoch-1/sig/meta-root-1.json ceremony/keyepoch-1/sig/meta-root-2.json
   ```

   ```bash
   node --conditions=development services/registry/src/ceremony/cli.ts check --kind trust_root --trust ceremony/keyepoch-1/trust-root.json ceremony/keyepoch-1/root-metadata.signed.json
   ```

같은 자리에서 **폐기 목록 첫 판**(`monotonic` 1)을 만든다.
- 스키마상 항목이 1개 이상이어야 하므로 쓰지 않을 `package-0` 하나를 넣는다.
- 루트 2개로 서명하고 모은다(`--kind revoked_keys`).
- 타임스탬프는 서버가 붙인다. 루트 2개로 서명한 목록을 레지스트리에 올리면 서버 Cron이 `timestamp-1`로 신선도 서명을 붙여 게시한다(클라우드 레지스트리 배포 PR).
- 서버가 돌려준 `timestamp` 서명 기록을 손으로 붙여 확인할 때는 `timestamp` 명령을 쓴다.
- `check`가 통과해야 한다.

핀 PR:
- `packages/engine/src/registry-pin.ts`의 `REGISTRY_TRUST_PIN`을 `trust-root.json` 값으로 바꾼다. 데스크톱 업데이터는 `db.query.registry.pins`로 같은 값을 받는다.
- `root-metadata.signed.json`을 저장소 `services/registry/ceremony/keyepoch-1/`에 커밋해 공개한다.
- PR 본문에 적는 것
  - 날짜
  - `trust-root.json` SHA-256
  - 루트 메타데이터 확인 코드
  - `check` 결과
  - `backup-verify` 결과
- 시험 키(`tests/fixtures/registry`)는 핀에 넣지 않는다.

## 6. 일상 서명

| 문서 | `--kind` | 키 | 타임스탬프 |
|---|---|---|---|
| 인덱스·manifest·hotfix·데이터 기술자 | `index`·`manifest`·`hotfix`·`data_descriptor` | 패키지 2개 | 없음(≤ 14일) |
| 정책·status 내용 변경 | `policy`·`status` | 정책 2개, 또는 긴급 1개(엄격하게 보수적일 때만) | 서버가 붙인다(48시간마다 자동 재서명) |
| 폐기 목록 | `revoked_keys` | 루트 2개 | 서버가 붙인다(24시간마다 자동 재서명) |
| 앱 릴리스 | `release` | `release-1` | 없음(≤ 14일) |
| 핀·keyEpoch 변경 릴리스 | `root_change` → `release` | 루트 2개 → `release-1` | 없음 |

- **신선도 재서명은 서버 Cron이 자동으로 한다**: 폐기 목록 24시간, status·정책 48시간, 투명성 로그 헤드. 구현은 클라우드 세션의 레지스트리 배포 PR이다. 사람은 하지 않는다.
- **내용이 바뀌는 서명**(위 표의 키 열)은 지금처럼 사람이 이 맥에서 Touch ID로 한다.
- CI는 서명 대상 문서만 만든다. 서명은 이 맥에서 사람이 한다.

## 7. 맥·키를 잃었을 때

| 상황 | 할 일 |
|---|---|
| 지문을 새로 등록함(W 사용 불가), 맥 교체·초기화 | 새 맥에서 §3(빌드·`init`·`selftest`) → `backup-import --in <백업> --trust trust-root.json`. 공개키가 같은지 도구가 대조한다. 핀은 그대로다 |
| 맥 분실·도난(잠긴 상태) | 감싼 블롭은 그 맥의 Secure Enclave와 지문 없이는 풀 수 없다. 백업으로 새 맥에 되살린다. 분실 맥이 잠금 해제된 채였다면 유출로 본다(아래) |
| 키 유출이 의심됨(맥이 털림, 잠금 해제 상태로 분실) | 이 세대의 모든 키를 의심한다. 백업으로 깨끗한 새 맥에 되살려 **새 세대로 바로 옮긴다**(§8의 keyEpoch+1). 유출된 세대의 키로는 세대 변경(`rootChange`) 말고는 새로 서명하지 않는다. 폐기 목록에 의심 키를 넣는다. 공격자도 같은 키를 갖고 있을 수 있으니 앱 업데이트로 핀을 빨리 바꾼다 |
| 백업 암호를 잊음 | 백업은 열 수 없다. 키체인 키가 살아 있으면 바로 새 백업을 만든다(§4) |
| 타임스탬프 키(서버 env) 유출 | 루트 2개가 `timestamp-1`을 폐기 목록에 넣는다. 그 목록이 그 키로 찍는 마지막 문서다. 새 타임스탬프 키는 keyEpoch+1 앱 업데이트로만 들어온다(D09 §8.4). 그때까지 클라이언트는 stale로 보수적으로 멈춘다 |
| 맥과 백업을 둘 다 잃음 | 루트 2-of-3이 없어 `rootChange`를 서명할 수 없다. 앱 안 갱신으로 핀을 바꾸지 못한다. 새 설치본을 공식 경로로 다시 받게 하는 수동 복구뿐이다. 그래서 백업을 두 곳에 둔다 |

## 8. 승격(보유자가 생기면): 새 보유자의 새 키, keyEpoch+1, 이전 키 폐기

1. **새 키를 새 보유자 장치에서 만든다.**
   - 보유자 A·B·C(각자 YubiKey 5 PIV, 펌웨어 5.7 이상: 82 package, 83 policy, 84 root, PIN·터치 ALWAYS)
   - 릴리스 보유자(비운영자)
   - 긴급 당직
   - 타임스탬프는 서버 HSM
   - 이전 세대 키를 옮기지 않는다(새 키만).
   - YubiKey 백엔드 구현과 증명(attestation) 검사는 이때 넣는다(`device.ts` `PivDevice` 인터페이스).
2. **새 핀**: `trust --mode quorum --key-epoch 2 …`
   - 도구가 보유자 분리(역할마다 3명), 릴리스 보유자 분리, 장치 증명을 검사한다.
3. **세대 변경 서명**: 핀 변경 릴리스의 `rootChange{keyEpoch: 2, changes: ["keyEpoch"]}`에 **이전 세대(keyEpoch 1) 루트 2개**가 단독 맥에서 서명한다(`--kind root_change`). 그다음 릴리스 키가 매니페스트에 서명한다. 앱 업데이트로 새 핀이 들어간다.
4. **이전 키 폐기**
   - 새 앱이 퍼진 뒤 keyEpoch 2의 첫 폐기 목록에 keyEpoch 1의 keyId를 모두 넣는다.
   - 혼동을 막으려고 새 세대는 keyId 번호를 이어서 쓴다(예 `root-4`~`root-6`).
   - 단독 맥의 키체인 항목은 `sax-keychain delete <keyId>`(Touch ID)로 지운다.
   - 이전 세대 백업 파일은 폐기 사실을 기록한 뒤 파쇄한다.
5. 루트 메타데이터를 `mode: "quorum"`으로 다시 공개한다.

## 9. 기록

- 서명마다 한 줄을 남긴다: 날짜·시각, `--kind`, 문서 SHA-256, 확인 코드, keyId.
- 키체인·Secure Enclave에는 사용 로그가 없다. 이 기록과 투명성 로그를 대조한다(D09 §8.2).
- 백업 매체 위치와 마지막 `backup-verify` 날짜도 남긴다.

## 10. 결정·실측이 남은 것

- **실측(사용자 손 필요)**: Secure Enclave 키 "사용"(Touch ID 프롬프트 → ECDH)은 아직 사람 손으로 확인하지 않았다. §3의 `selftest` 한 번으로 확인한다. 키 생성·재로드·키체인 저장은 실증했다(서명 안 된·ad-hoc 둘 다, M5 Pro·macOS 26.5.1).
- **타임스탬프 자동화**(결정됨, 구현은 클라우드): 서버 온라인 키(`REGISTRY_LOG_SIGNING_KEY`)로 Cron이 재서명한다. 레지스트리 배포 PR에서 넣는다. 그 전에 핀을 반영하면 첫 폐기 목록이 24시간 뒤 낡는다. 그래서 핀 PR은 Cron이 돈 뒤에 머지한다.
- **ADR-037**: 단독 보유의 남는 위험(§1)과 승격 조건(언제 보유자를 늘리나)을 ADR이 정한다. 설계 세션 작성 중이다.

## 부록 A. 감싸기 규약 `SAX-ceremony-wrap-v1`

- W: Secure Enclave P-256(KeyAgreement), 접근 제어 `privateKeyUsage + biometryCurrentSet`, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. W 블롭(Secure Enclave만 쓸 수 있는 불투명 값)은 키체인 서비스 `com.laf.sax.registry-ceremony`, 계정 `wrap-key`에 둔다.
- 감싸기(키마다)

  ```
  e      = 새 P-256 임시 키
  Z      = ECDH(e, W_pub)의 x 좌표 32B
  info   = utf8("SAX-ceremony-wrap-v1") ‖ X9.63(e_pub) 65B ‖ X9.63(W_pub) 65B ‖ utf8(keyId)
  KEK    = HKDF-SHA256(ikm = Z, salt = 빈 값, info, L = 32)
  aad    = utf8("SAX-ceremony-wrap-v1") ‖ utf8(keyId)
  ct‖tag = ChaCha20-Poly1305(KEK, nonce 12B 난수, seed 32B, aad)
  블롭   = JCS({v:1, alg:"SAX-ceremony-wrap-v1", keyId, pub: b64(Ed25519 공개키), epk: b64(e_pub), nonce: b64, ct: b64(ct‖tag 48B)})
  ```

  키체인 계정은 `key/<keyId>`다.
- 풀기: ECDH(W, e_pub)(Secure Enclave, Touch ID) → 같은 KEK → 열기 → Ed25519(seed) 공개키 = 블롭 `pub`. 다르면 거부한다.
- 맥락 문자열 `SAX-ceremony-wrap-v1`은 레지스트리·기기 서명 맥락(SIGNING.md §8)과 겹치지 않는다. 서명이 아니라 키 합의·AEAD에만 쓴다.
- **시험 벡터**: W 비밀 스칼라 = 0x11×32(Secure Enclave 대신 소프트웨어), e = 0x22×32, nonce = 0x33×12, seed = 0x07×32, keyId = `root-1`

  ```
  {"alg":"SAX-ceremony-wrap-v1","ct":"ozs0ERLB39bSVzrHX7TZJP223SkmVcvkz/zD9LFbgdhoBAlwVmPbO0gqvU2Pr8eh","epk":"BNZak5d8qj0bCBhS/1ennkZfFmBXcwS66tUF3TpIWJzzUBheiVNy32Ih6joTdVfkc/3bZ1XwW9UHw8Uz/OnJEoU=","keyId":"root-1","nonce":"MzMzMzMzMzMzMzMz","pub":"6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=","v":1}
  ```

  - `pub`은 SIGNING.md §10.2와 같은 시드 0x07×32의 공개키(`ea4a6c63…`)다.
  - Node(`wrap.ts` `wrapSeed`)와 Swift 도우미(`sax-keychain vector`)가 같은 바이트를 낸다(시험이 대조한다).

## 부록 B. 백업 형식 `SAX-ceremony-backup-v1`

```
key    = scrypt(utf8(NFC(passphrase)), salt 16B, N = 2^17, r = 8, p = 1, 32B)
header = {v:1, alg:"SAX-ceremony-backup-v1", kdf:{name:"scrypt", N, r, p, salt: b64}, nonce: b64(12B), createdAt}
aad    = utf8("SAX-ceremony-backup-v1") ‖ JCS(header)
ct‖tag = ChaCha20-Poly1305(key, nonce, JCS({keys: [{keyId, pub, seed}] keyId 순}), aad)
파일   = JCS({...header, ct: b64(ct‖tag)}) + "\n"
```

- 열 때 받는 kdf: N은 2^14~2^20인 2의 거듭제곱, r = 8, p = 1. 그 밖은 `ceremony.backup_invalid`다. 만들 때는 늘 N = 2^17이다.
- 헤더는 aad로 묶인다. createdAt 한 글자만 바꿔도 열리지 않는다(`ceremony.backup_open_failed`).
- 각 항목의 seed → Ed25519 공개키가 `pub`과 같아야 한다. 들여올 때는 핀(`--trust`)과도 대조한다.
