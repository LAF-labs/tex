# 레지스트리 서명 의식 절차서 (keyEpoch 1)

근거:
- D09 §8.2(역할 분리·1인 1키·하드웨어 쿼럼)·§8.4(폐기·keyEpoch)·§8.5(긴급 키)
- [SIGNING.md](../../../sovereign-ax/design/schemas/SIGNING.md) §1~§4(서명 바이트)
- ADR-013·023·028
- 팀장 결정 2026-11-06: YubiKey 5 PIV Ed25519, 보유자 3명 + 릴리스 1명, 슬롯 82·83·84, PIN·터치 ALWAYS

도구: `services/registry/src/ceremony/cli.ts`(아래 `ceremony`).

```bash
node --conditions=development services/registry/src/ceremony/cli.ts <명령> …
```

**개인키와 PIN은 이 도구를 지나가지 않는다.**
- 개인키는 YubiKey 안에서 만들고 밖으로 나오지 않는다.
- 도구는 장치에 "이 바이트에 서명하라"만 보낸다.
- PIN은 `pkcs11-tool`이 터미널에서 직접 묻는다.
- 터치는 장치가 요구한다.

시험: `tests/registry-ceremony.test.ts`(소프트웨어 가짜 장치).

## 1. 역할과 키

| keyId | 역할 | 보관 | 정족수 | 서명하는 것 |
|---|---|---|---|---|
| `root-1`·`root-2`·`root-3` | 오프라인 루트 | 보유자 A·B·C의 YubiKey 슬롯 **84** | 2-of-3 | 루트 메타데이터, 폐기 목록 `revoked_keys.json` 본문, 릴리스 `rootChange`(핀·keyEpoch 변경) |
| `package-1`·`-2`·`-3` | 패키지 | 보유자 A·B·C의 슬롯 **82** | 2-of-3 | 인덱스 `registry/{channel}/index.json`, `.sxp` 안 manifest·hotfix·데이터 기술자 |
| `policy-1`·`-2`·`-3` | 정책 | 보유자 A·B·C의 슬롯 **83** | 2-of-3 | 정책, `registry/status.json` |
| `emergency-1` | 1인 긴급(당직) | 보유자 A(당직)의 슬롯 **86** *(제안, §10)* | 1 | 엄격하게 보수적인 정책·status 변경만(D03 §7.1). 72시간 뒤 자동 만료 |
| `release-1` | 앱 릴리스 | 릴리스 보유자 R(비운영자)의 YubiKey 슬롯 **85** *(제안, §10)* | 1 | `releases/{channel}/latest.json` |
| `timestamp-1` | 타임스탬프(온라인) | 레지스트리 서버 HSM *(결정 필요, §10)* | 1 | 정책·status·폐기 목록의 신선도 재서명(자동) |

- **1인 1키**: 한 사람이 같은 역할 키를 둘 갖지 않는다. 보유자 A·B·C는 역할마다 1개씩 갖는다. 그래서 장치 하나를 잃어도 남은 둘로 2-of-3이 된다(§8).
- **릴리스 보유자는 운영 키(root·package·policy)를 갖지 않는다**(ADR-028). 도구가 이를 검사한다.
- 레지스트리 호스팅·CDN·미러의 쓰기 권한자는 서명 키를 갖지 않는다(D09 §8.2).
- 남는 위험: 루트 키가 일상용 패키지·정책 키와 같은 YubiKey에 있다(팀장 결정). 루트는 연 1회만 쓰지만, 장치 하나를 빼앗기면 세 역할을 한꺼번에 잃는다. 대신 PIN·터치 ALWAYS가 원격 오용을 막는다.

## 2. 준비물

- YubiKey 5 시리즈, **펌웨어 5.7 이상**(PIV Ed25519). 확인: `ykman info`.
- 각 보유자 PC
  - `ykman` 5.4 이상
  - Yubico PIV Tool 2.5 이상(`libykcs11`)
  - OpenSC `pkcs11-tool` 0.25 이상(`--mechanism EDDSA`)
  - Node 24와 이 저장소(태그 고정 커밋)
- Yubico PIV 증명 루트·중간 인증서 PEM. Yubico 공식 페이지에서 받고, **두 사람이 지문(SHA-256)을 따로 확인**해 의식 기록에 적는다.
- 의식 기록부(§9): 참석자, 장치 일련번호, 확인 코드, 산출물 SHA-256.
- 루트 서명(§5)을 하는 PC는 그 시간 동안 네트워크를 끊는다.

## 3. 장치 초기화와 키 생성(보유자 각자, 자기 장치로)

공장 기본값(PIN 123456, PUK 12345678, 기본 관리 키)을 먼저 바꾼다.

```bash
ykman piv access change-pin
```

```bash
ykman piv access change-puk
```

```bash
ykman piv access change-management-key --generate --protect
```

슬롯마다 키를 장치 안에서 만든다(보유자 A·B·C는 82·83·84, A는 86도, 릴리스 보유자는 85만):

```bash
ykman piv keys generate --algorithm ED25519 --pin-policy ALWAYS --touch-policy ALWAYS 84 root-pub.pem
```

```bash
ykman piv certificates generate --subject "CN=SAX root-1" 84 root-pub.pem
```

- 두 번째 명령은 자체 서명 인증서를 넣는다. `libykcs11`이 그 슬롯의 개인키 객체를 보이게 하려는 것이다(실측 필요, §10).
- **키를 가져오지(import) 않는다.** 증명 검사(§4)가 장치 안에서 생성된 키만 받는다.
- PIN·PUK는 보유자만 안다. 적어 둔다면 장치와 다른 곳에 봉인한다. PIN 3회·PUK 3회를 틀리면 장치를 초기화해야 하고, 그러면 키를 잃는다(§8).

## 4. 공개키 수집과 증명 검사

보유자가 자기 장치를 꽂고 슬롯마다 실행한다.

```bash
node --conditions=development services/registry/src/ceremony/cli.ts pubkey --role root --key-id root-1 --holder "보유자 A" --module /usr/local/lib/libykcs11.dylib --serial 30000001 --yubico-root yubico-piv-root.pem --yubico-intermediate yubico-piv-attest-b1.pem --out keys/root-1.json
```

- 도구가 확인하는 것
  - 슬롯 공개키(`ykman piv keys export`)
  - 증명서 사슬: 슬롯 증명 ← 장치 f9 ← (Yubico 중간) ← Yubico 루트. 유효 기간도 본다.
  - 증명서 공개키 = export한 공개키
  - **PIN 정책 always·터치 정책 always**(Yubico 확장 1.3.6.1.4.1.41482.3.8). 아니면 `ceremony.policy_not_always`로 멈춘다.
  - 일련번호·펌웨어를 기록에 남긴다.
- keyId 번호는 보유자 순서다(A=1, B=2, C=3). 역할 이름은 실명이 아니라 역할로 적는다(예 "보유자 A(운영·당직)").
- 타임스탬프 키는 서버 HSM의 공개키 PEM으로 기록한다(증명 없음, `attested: false`).

```bash
node --conditions=development services/registry/src/ceremony/cli.ts pubkey --role timestamp --key-id timestamp-1 --holder "레지스트리 서버 HSM" --pubkey-pem ts-pub.pem --out keys/timestamp-1.json
```

## 5. TRUST_ROOT_JSON·루트 메타데이터 → 루트 2-of-3

진행자가 공개키 기록 12개로 핀과 메타데이터를 만든다.

```bash
node --conditions=development services/registry/src/ceremony/cli.ts trust --key-epoch 1 --out-trust trust-root.json --out-metadata root-metadata.json keys/*.json
```

- `trust-root.json`(TRUST_ROOT_JSON)은 `{keyEpoch: 1, keys: {역할: {keyId: base64 공개키}}}`이다. 엔진 `TrustPin`·`@sax/updater` `TrustRoot`·`tests/fixtures/registry/trust.json`과 같은 모양이다.
- `root-metadata.json`(`sax.trust-root/v1`)은 핀 키 + **keyId → 보유자 역할 표**(슬롯·장치 일련번호·증명 여부)다. 공개한다(D09 §8.2).
- 도구가 검사하는 것
  - 역할별 키 수: root·package·policy 3, emergency·timestamp·release 1
  - keyId·공개키 중복이 없다
  - root·package·policy는 보유자 3명이 서로 다르다
  - 릴리스 보유자는 운영 키를 갖지 않는다
  - 타임스탬프 키 말고는 장치 증명이 있다
- 보유자 각자가 같은 `keys/*.json`으로 `trust`를 다시 돌려 `trust-root.json`의 SHA-256이 같은지 확인한다.

루트 메타데이터에 루트 2-of-3 서명을 한다. 서명할 때마다 아래 순서를 따른다.
1. 진행자가 `prepare`로 확인 코드를 만들어 소리 내어 읽는다.

   ```bash
   node --conditions=development services/registry/src/ceremony/cli.ts prepare --kind trust_root root-metadata.json
   ```

2. 보유자는 **자기 PC에서 같은 문서로** 서명한다. 도구가 다시 계산한 확인 코드와 입력한 값이 다르면 장치에 넘기지 않는다. 핀과 장치 공개키가 다르면(남의 장치·다른 슬롯) 멈춘다.

   ```bash
   node --conditions=development services/registry/src/ceremony/cli.ts sign --kind trust_root --role root --key-id root-1 --confirm abcd-…-…(확인 코드) --trust trust-root.json --module /usr/local/lib/libykcs11.dylib --serial 30000001 --out sig/root-1.json root-metadata.json
   ```

3. 진행자가 모은다. 서로 다른 핀 키가 2개 이상이어야 한다. 같은 키 두 번, 다른 역할 키, 다른 문서 서명, 서명 뒤 바뀐 문서, 4개 이상은 거부한다.

   ```bash
   node --conditions=development services/registry/src/ceremony/cli.ts collect --kind trust_root --trust trust-root.json --out root-metadata.signed.json root-metadata.json sig/root-1.json sig/root-3.json
   ```

   ```bash
   node --conditions=development services/registry/src/ceremony/cli.ts check --kind trust_root --trust trust-root.json root-metadata.signed.json
   ```

같은 자리에서 **폐기 목록 첫 판**(`monotonic` 1, 루트 2-of-3)도 만든다. 서명은 위와 같은 순서이고 `--kind revoked_keys`다. 그 뒤 타임스탬프 키로 `timestamp`를 붙이고 `check`로 게시 관문 규칙을 통과하는지 본다. 이것이 없으면 클라이언트는 24시간 신선도를 얻지 못하고 새 패키지를 보류한다.

## 6. 핀 반영 PR(REGISTRY_TRUST_PIN)

- `packages/engine/src/registry-pin.ts`의 `REGISTRY_TRUST_PIN`을 `trust-root.json` 내용으로 바꾼다. 데스크톱 업데이터의 `TrustRoot`도 같은 값을 쓴다(엔진 `db.query.registry.pins`).
- `root-metadata.signed.json`을 공개한다(저장소 `services/registry/ceremony/keyepoch-1/`, 레지스트리 정적 경로는 클라우드 트랙이 정한다).
- PR 본문에 적는 것
  - 의식 날짜·참석 역할
  - 장치 일련번호
  - `trust-root.json` SHA-256
  - 루트 메타데이터 확인 코드
  - `check` 결과
- 리뷰어 2명이 각자 `check --kind trust_root`를 돌린다.
- 시험 키(`tests/fixtures/registry`)는 핀에 넣지 않는다.

## 7. 일상 서명

| 문서 | `--kind` | 누가 | 타임스탬프 |
|---|---|---|---|
| 인덱스·manifest·hotfix·데이터 기술자 | `index`·`manifest`·`hotfix`·`data_descriptor` | 패키지 키 2명 | 없음(인덱스 ≤ 14일) |
| 정책·status 내용 변경 | `policy`·`status` | 정책 키 2명, 또는 긴급 키 1명(엄격하게 보수적일 때만) | 서버가 붙인다 |
| 폐기 목록 변경 | `revoked_keys` | 루트 키 2명 | 서버가 붙인다(24시간마다 재서명) |
| 앱 릴리스 | `release` | 릴리스 보유자 | 없음(≤ 14일) |
| 핀·keyEpoch 변경 릴리스 | `root_change`(먼저) → `release` | 루트 키 2명 → 릴리스 보유자 | 없음 |

- CI는 서명 대상 문서만 만든다. 서명 권한은 없다(D09 §8.2). 2-of-3을 채우지 못하면 핫픽스를 멈춘다. CI 서명으로 대체하지 않는다.
- 긴급 키를 쓰면 다른 보유자에게 바로 알린다. 72시간 안에 정책 키 2-of-3으로 다시 서명하거나, 만료로 되돌아가게 둔다(D09 §8.5).

## 8. 분실·도난·폐기

폐기는 되돌릴 수 없다. 폐기 목록은 늘기만 한다(`registry.revoked_shrunk`). 폐기된 키의 서명은 클라이언트가 세지 않는다.

| 상황 | 바로 할 일 | 그다음 |
|---|---|---|
| 보유자 한 명의 장치 분실·도난 | 남은 루트 2명이 그 보유자의 `package-N`·`policy-N`·`root-N`(A면 `emergency-1`도)을 넣은 폐기 목록을 서명해 게시한다. 엔진은 루트 서명을 **이전** 폐기 목록으로 세므로 남은 루트 둘이면 된다 | 남은 2명으로 2-of-3은 유지된다(여유 0). 새 장치로 새 키를 만들고 keyEpoch 2 핀 변경 릴리스(`root_change` 루트 2 + 릴리스)를 낸다 |
| PIN 3회 틀림 | PUK로 PIN을 다시 정한다 | 기록부에 적는다 |
| PUK까지 잠김·장치 고장 | 장치 분실과 같다(키를 꺼낼 수 없다) | 위와 같다 |
| 키 하나만 의심(예: 서명 기록과 투명성 로그가 다름) | 그 keyId를 폐기한다 | 다음 keyEpoch에 교체한다 |
| 루트 키 분실 | 남은 루트 2명이 그 `root-N`을 폐기한다 | keyEpoch 2에서 새 루트를 넣는다 |
| 두 보유자 동시 분실(정족수 상실) | 핫픽스·인덱스·정책 변경이 멈춘다. 긴급 키로 하향만 할 수 있다 | 루트 2-of-3이 없으면 `rootChange`를 서명할 수 없어 앱 안 갱신으로 핀을 바꾸지 못한다. 새 설치본을 공식 경로로 다시 받게 하는 수동 복구다. 이 위험 때문에 세 장치를 다른 장소에 둔다 |
| 릴리스 키 분실 | 루트 2명이 `release-1`을 폐기한다 | 앱 업데이트가 멈춘다. 새 릴리스 키는 핀 변경이라 위 수동 복구와 같다. 백업 릴리스 장치가 필요한지 정해야 한다(§10) |
| 타임스탬프 키 유출 | 루트 2명이 `timestamp-1`을 폐기한다 | 그 목록이 그 키로 찍는 마지막 문서다. 새 타임스탬프 키는 keyEpoch 2 앱 업데이트로만 들어온다. 그때까지 클라이언트는 stale로 보수적으로 멈춘다(D09 §8.4) |
| 긴급 키 분실·오용 | 루트 2명이 `emergency-1`을 폐기한다 | 긴급 하향은 72시간 뒤 자동으로 되돌아간다. 정책 키 2-of-3으로 정상 status를 다시 낸다 |

## 9. 기록·감사

- 의식 기록부(서명마다 한 줄): 날짜·시각, 문서 종류, `--kind`, 산출물 SHA-256, 확인 코드, 서명한 keyId, 장치 일련번호, 진행자·증인.
- YubiKey에는 사용 로그가 없다. 서명 1건마다 기록부와 투명성 로그 항목을 대조한다(D09 §8.2 사용 감사, SP-4·SP-6).
- 장치는 보유자가 따로 보관한다(서로 다른 장소). 루트 의식 때만 모인다.

## 10. 결정·실측이 남은 것

- **타임스탬프 키 보관**(결정 필요): D09는 "국내 서버 HSM, 자동"이다. 후보는 서버에 붙인 YubiHSM 2, 또는 PIN·터치 정책이 NEVER인 전용 YubiKey다. 자동 재서명이라 터치를 요구할 수 없다.
- **슬롯 85(release)·86(emergency)**: 이 절차서의 제안이다. 팀장 결정은 82·83·84뿐이다. 긴급 키를 보유자 A(당직)에 둘지 다섯 번째 사람에게 둘지 정해야 한다.
- **펌웨어 5.7 PIV Ed25519 메시지 길이**(실측 필요): Ed25519는 다이제스트가 아니라 서명 입력 전체에 서명한다. 인덱스는 최대 512KB다. ykcs11 `CKM_EDDSA`로 몇 KB까지 되는지 실제 장치로 잰다. 도구 상한은 `MAX_SIGN_BYTES` 512KB다.
- **ykcs11의 은퇴 슬롯(82~95) 키 노출**(실측 필요): 인증서가 없으면 개인키 객체가 안 보일 수 있어 §3에서 자체 서명 인증서를 넣는다. ykcs11 id는 82→05 … 86→09로 가정했다(`ykcs11KeyId`).
- **Yubico 증명 사슬**: 5.7.4 이후 장치는 중간 인증서가 하나 더 있는 새 계층이다. `--yubico-intermediate`로 넘긴다(도구는 깊이 4까지 잇는다).
- **릴리스 키 백업**: 릴리스 키를 잃으면 앱 업데이트가 멈춘다. 두 번째 릴리스 키(핀에 2개)를 둘지 정해야 한다. 지금 엔진·업데이터 핀은 release 1개다.
