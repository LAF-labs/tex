# Windows 시험: CI는 GitHub 호스트, 실물 확인은 노트북에서 손으로(D14 M1-1, ADR-035 결정 1 (나), RETRO B-07)

> **경고: 이 저장소(공개)에 self-hosted 러너를 붙이지 않는다.**
> 공개 저장소에서는 누구나 fork PR을 열 수 있다. self-hosted 러너가 붙어 있으면 그 PR의 코드가 노트북에서 그대로 실행된다.
> 그러면 노트북의 공동인증서(NPKI), 브라우저 로그인, 파일이 노출될 수 있다. GitHub도 공개 저장소에 self-hosted 러너를 쓰지 말라고 권고한다.
> 예전에 이 문서의 절차로 러너를 붙였다면 **지금 뗀다**:
> 1. 저장소 **Settings → Actions → Runners**에서 러너를 고르고 **Remove**를 누른다.
> 2. 노트북에서 `C:\actions-runner\config.cmd remove --token <화면의 토큰>`을 실행한다.
> 3. `actions.runner.*` 서비스가 남아 있지 않은지 확인한다(`Get-Service actions.runner.*`).
> 4. 저장소 변수 `SAX_WINDOWS_RUNNER`는 더 쓰지 않으니 지운다(**Settings → Secrets and variables → Actions → Variables**).

## 1. CI가 하는 것(사람 손 불필요)

`.github/workflows/ci.yml` `windows` 잡은 GitHub 호스트 러너(`windows-latest`)에서 PR·main push·수동 실행마다 돈다(공개 저장소라 무료).
하는 일: pnpm 고정 설치·build·lint·`pnpm test`·보안 스위트·작업 트리 점검. Windows 경로·ACL(`localdata`)·DPAPI 래퍼·junction 시험이 여기서 돈다.

CI에 넣지 않는 것: 실물 공동인증서, 실계정, 실 홈택스·정부24 접속, 실제 Windows Hello 프롬프트, TPM 결박(호스트 러너에는 사람도 Hello도 없다). 이것들은 §3 절차로 사람이 확인한다.

보안 설정은 다음과 같다(ci.yml·promotion.yml 공통).
- `permissions: contents: read`만 준다. checkout은 `persist-credentials: false`라 토큰이 작업 폴더에 남지 않는다.
- `pull_request_target`은 쓰지 않는다. 그래서 fork PR 코드는 읽기 전용 토큰으로만 돈다.
- 워크플로는 `secrets.*`를 읽지 않는다. 어차피 fork에서 온 PR에는 GitHub이 저장소 비밀을 넘기지 않는다.
- 권장 저장소 설정(사용자 몫): **Settings → Actions → General → Fork pull request workflows from outside collaborators**를 "Require approval for first-time contributors" 이상으로 둔다. 처음 기여하는 사람의 PR은 승인한 뒤에야 돈다.

## 2. 노트북 준비(한 번, 손으로 확인할 때만)

| 도구 | 설치(관리자 PowerShell, winget) |
|---|---|
| Git for Windows | `winget install --id Git.Git -e` |
| Node 26.13(`poc/.nvmrc`) | `winget install --id OpenJS.NodeJS -e --version 26.13.0`(없으면 nvm-windows) |
| pnpm 12.11.2(`poc/package.json` `packageManager`) | `corepack enable` 뒤 `corepack prepare pnpm@12.11.2 --activate` |
| Google Chrome | `winget install --id Google.Chrome -e` |
| Visual Studio Build Tools 2022(C++) + Python 3(`better-sqlite3-multiple-ciphers` 빌드용) | `winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` 와 `winget install --id Python.Python.3.12 -e` |

긴 경로: `git config --global core.longpaths true`. Windows 긴 경로 정책(LongPathsEnabled)은 시스템 설정이라 필요할 때 사용자가 직접 켠다.

## 3. 실물 확인 절차(사람이 앉아서, 노트북 본인 계정)

신뢰하는 커밋만 받는다. main 또는 직접 검토한 브랜치에 한한다. fork PR 코드를 이 계정에서 돌리지 않는다.

```powershell
git clone https://github.com/LAF-labs/tex.git; cd tex\poc
git checkout <검토한 커밋>
pnpm install --frozen-lockfile; pnpm build; pnpm test   # CI와 같은 시험이 이 PC(실제 TPM·Hello 있는 PC)에서 녹색인지
```

| 확인 | 어떻게 | 기대 |
|---|---|---|
| 공동인증서 찾기(NPKI) | `pnpm start:hometax` → 금고가 인증서 목록을 보여 줄 때 실제 인증서(LocalLow\NPKI 등)가 보이는지 | 주체·발급자·유효기간 4칸만 보인다. 개인키 파일 내용이나 암호는 화면·로그에 없다 |
| Windows Hello·TPM 결박 | 같은 앱에서 유휴 잠금 뒤 다시 열기 | Hello 프롬프트에 작업명·포털명이 뜨고, 취소하면 닫힌 채다. Hello 없는 PC는 Windows 잠금·해제로만 열린다 |
| 실제 홈택스(PoC-3, ADR-025) | `pnpm start:hometax`(poc/README) | 앱이 PoC 상한을 지킨다(하루 실행 20, 실발급 1, PoC 전체 실발급 3). 모르는 화면은 "멈춤·확인 필요"로 끝난다. 승인 없는 비가역 실행이 없다 |

규칙:
- 측정 결과는 기본 위치 `reports/raw/.local/`(git 제외)에 남긴다. 실물 결과를 커밋하지 않는다. `SAX_MEASURE_COMMIT`을 켜지 않는다.
- 스크린숏·로그를 공유할 때는 인증서 이름(실명)·사업자번호를 가린다.
- 정부24는 후처리만 한다. 캡차는 사람이 직접 푼다(자동 해결·탐지 회피 금지).
