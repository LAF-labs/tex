# @sax/updater

앱 업데이트 앞단 검증(D14 M4-9, ADR-028 결정 1~3, D09 §8.2~§8.4, D11 §4 자동 업데이트 행). 순수 TS: 네트워크·Electron·자식 프로세스가 없고 `node:crypto`·`node:fs`만 쓴다(`tests/updater-verify.test.ts`가 import를 검사한다). 받기·설치는 electron-updater가 하고, **이 패키지가 통과시킨 값만** electron-updater에 넘긴다.

계약: 레지스트리 `GET /releases/{channel}/latest.json`(services/registry API.md "릴리스 매니페스트", 클라우드 PR #56). 서명 바이트는 SIGNING.md §1·§3(JCS, 맥락 문자열 없음, base64url 서명, 핀 키만 센다, 폐기 키는 세지 않는다).

## 검증 규칙(`verifyRelease`)

순서: 모양 → 폐기 목록 신선도 → 채널 → 서명 → 시각 → 단조 버전. 하나라도 실패하면 던진다(fail-closed).

| 규칙 | 실패 코드 |
|---|---|
| 모양: 알려진 필드만, `version` = `x.y.z`, 파일 1~8개(`url` 파일 이름만·중복 없음, sha512 base64 88자, 1B~1GiB), `rolloutPercent` 0~100, 시각 ISO UTC | `update.manifest_invalid` |
| 엔진이 받아 둔 폐기 목록이 24시간 안이다(D09 §8.4: 새 로드 보류) | `registry.revocation_stale` |
| 매니페스트 `channel` = 구독 채널 | `update.channel_mismatch` |
| 릴리스 키 1개(핀 `release` 역할) 서명, 내용 = 매니페스트 − `signature` | `registry.signature_insufficient` / `registry.key_revoked` |
| 뿌리 변경 릴리스(`rootChange` 있음)는 루트 2-of-3, 내용 = 매니페스트 − `signature`, `rootChange` − `signatures`. `keyEpoch` 변경이면 새 세대 > 지금, 아니면 = 지금 | `update.root_change_unsigned` / `registry.key_revoked` |
| `releaseDate` ≤ 지금 + 5분 | `registry.issued_in_future` |
| `expiresAt` − `releaseDate` ≤ 14일, `expiresAt` > `releaseDate` | `update.validity_too_long` |
| `expiresAt` > 지금 | `registry.expired` |
| 이 채널에서 본 최고 버전보다 낮지 않다. 같은 버전이면 파일 목록 다이제스트가 같다(신선도 재발행만) | `registry.version_rollback` |

## 판정(`decideUpdate`)

- 검증 실패 → `hold`(설치본 유지, "업데이트를 확인하지 못했습니다"). `security: true`면 보안 이벤트(`SECURITY_CODES`).
- 설치본보다 높지 않다 → `none: up_to_date`(다운그레이드 금지).
- 투명성 로그·미러 확인(ADR-028 결정 2): `transparency`가 `verified`가 아니면 `hold`(`update.transparency_unverified`, 헤드 불일치는 `registry.head_mismatch`). 기본 `requireTransparency: true`. **레지스트리에 로그가 아직 없어 지금은 모든 업데이트가 보류된다** — 로그가 서기 전 베타 동안 끌지는 팀장 결정(PR 본문).
- 롤아웃: `bucket = u32be(sha256("SAX-rollout-v1\0" ‖ "sax-desktop@<version>" ‖ "\0" ‖ deviceId)[0..4]) mod 100`, `bucket < rolloutPercent`일 때만 `download`(API.md 공식, id 자리에 앱 버전).
- 상태(`UpdaterState`): `highestSeen`(검증 통과한 최고 버전·파일 다이제스트)과 `lastSuccessAt`. 실패는 상태를 바꾸지 않는다. 로그 미확인은 확인 성공이 아니라 `lastSuccessAt`을 올리지 않는다. `needsStaleNotice`: 14일 동안 성공이 없으면 알림(D11 §4).

## 롤백 규칙

1. **클라이언트는 내려가지 않는다.** 설치본보다 낮거나 같은 버전은 설치하지 않고, 본 적 있는 최고 버전보다 낮은 매니페스트는 롤백 공격으로 거부한다(동결·되감기). 저장값은 낮아지지 않는다.
2. **문제 릴리스를 되돌릴 때는 앞으로 간다.** 이전 코드로 버전을 올린 새 릴리스(예: 1.2.0이 나쁘면 1.1.0 내용으로 1.2.1)를 같은 절차(로그 선기록·릴리스 키 서명)로 낸다. 레지스트리도 같은 버전·낮은 버전 게시를 거부한다(API.md `PUT /admin/v1/releases`).
3. **확산 멈춤**은 `rolloutPercent`를 낮춘 같은 버전·같은 파일의 재발행으로 한다(신선도 재발행과 같은 규칙이라 받아들여진다). 이미 설치한 기기는 2번으로만 고친다.
4. **설치 실패**(다운로드 해시·크기 불일치, 피드 불일치, 설치 중단)는 설치본을 그대로 둔다. 받은 파일은 지우고 다음 확인 주기에 처음부터 다시 받는다.
5. **동결 공격**(낡은 유효 매니페스트만 계속 보여 줌)은 14일 만료와 14일 미확인 알림이 드러낸다.
6. 앱 데이터(DB·보관함)는 버전 사이에서 앞으로만 마이그레이션한다(D07). 앱 롤백이 없으므로 내려가는 마이그레이션은 두지 않는다.

## 배선 순서

main(데스크톱 트랙)이 이 순서로 부른다. 모두 `app.isPackaged`일 때만.

1. 조회 주기에(D09 §8.1과 같이 15분·기동·절전 복귀) `latest.json`을 egress로 받는다. 엔진에서 폐기 목록(`keyIds`·신선도), 투명성 확인 결과를 받는다.
2. `decideUpdate(...)` → 상태 저장 → `download`가 아니면 끝.
3. electron-updater `checkForUpdates()`(`autoDownload = false`)의 `updateInfo`를 `matchFeed(release, info)`로 대조. 다르면 받지 않는다(`update.feed_mismatch`, 보안 이벤트).
4. `downloadUpdate()` → `update-downloaded`의 `downloadedFile`을 `verifyDownloadedFile(path, decision.file)`로 확인. 실패면 파일을 지우고 끝.
5. `installGate({runActive, commitZone, daemonRunning})`가 `install: true`일 때만 `quitAndInstall()`. 아니면 다음 유휴 때 5부터.

## 라이브러리 선정

- **electron-updater(6.8.x, ≥ 6.3.0-alpha.6)를 설치기로 쓴다.** NSIS 사용자별 설치의 교체·재시작·제거 프로그램 처리, 다운로드 재시도, Authenticode 서명 주체 DN 검사(`verifyUpdateCodeSignature`, 2차 방어)를 직접 만들지 않는다. D11 §4가 이미 이 라이브러리를 전제로 한다(CVE-2024-39698 하한).
- **신뢰 판단은 electron-updater에 맡기지 않는다.** electron-updater는 `latest.yml`(서명 없음)을 믿는다. 우리 매니페스트는 Ed25519 서명·만료·단조 버전·채널·뿌리 변경 2-of-3을 갖고, 이 패키지가 그것을 본 뒤에만 electron-updater가 같은 값(버전·sha512)을 받는지 대조한다. 받은 파일도 설치 직전에 다시 해시한다.
- 대안 기각: Squirrel.Windows(사용자별 설치는 되지만 electron-builder 기본이 아니고 자체 RELEASES 형식이라 서명 매니페스트를 한 번 더 감싸야 한다), 직접 구현(NSIS 교체·재시작을 다시 만드는 비용, 2주 범위 밖), electron-updater 단독(N-10: 서명 없는 `latest.yml` 하나에 신뢰가 걸린다).

## D16 제안 코드(문서 트랙에 요청)

`registry.*`는 D16·엔진 정본 코드를 그대로 쓴다. 아래 `update.*`는 새 코드다.

| 코드 | 뜻 | 보안 이벤트 |
|---|---|---|
| `update.manifest_invalid` | 릴리스 매니페스트 모양 오류 | 아니오 |
| `update.channel_mismatch` | 매니페스트 채널 ≠ 구독 채널 | 아니오 |
| `update.validity_too_long` | 유효 기간 14일 초과 | 아니오 |
| `update.root_change_unsigned` | 뿌리 변경 릴리스에 루트 2-of-3 없음 | 예 |
| `update.transparency_unverified` | 로그 포함 증명·미러 확인 못 함 | 아니오 |
| `update.feed_mismatch` | electron-updater가 읽은 latest.yml ≠ 검증한 매니페스트 | 예 |
| `update.size_mismatch` / `update.digest_mismatch` | 받은 설치본 크기 / sha512 불일치 | 아니오 / 예 |

## 클라우드에 제안하는 계약 변경(팀장 경유)

- `latest.json` 선택 필드 `rootChange: {keyEpoch, changes: ["keyEpoch"|"allowlist"|"ceiling"], signatures: [루트 서명 ≤ 3]}`(ADR-028 결정 3). 게시 관문은 지금도 모르는 필드를 내용으로 서명 검증하므로 깨지지 않는다. 관문도 2-of-3을 확인하면 좋다.
- 클라이언트는 **모르는 필드를 거부**한다. `latest.json`에 필드를 더하려면 이 패키지를 먼저 바꾼다.
- 핀 `release` 역할 키는 아직 `tests/fixtures/registry/trust.json`(엔진 #52)에 없다. 시험은 같은 시드 규칙으로 `release-1 = 0x61`을 쓴다.
