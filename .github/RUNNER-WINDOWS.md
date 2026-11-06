# Windows self-hosted 러너 붙이기(D14 M1-1, ADR-035 결정 1 (나), RETRO B-07)

`.github/workflows/ci.yml`의 `windows` 잡은 라벨 `[self-hosted, windows, sax]` 러너에서 돈다. 저장소 변수 `SAX_WINDOWS_RUNNER`가 `true`일 때만 켜진다(없으면 건너뛰어 대기열에 묶이지 않는다). 이 문서는 사용자가 Windows 노트북을 이 러너로 붙이는 절차다. 비밀·실키·실계정·실 홈택스 접속은 CI에 넣지 않는다.

## 1. 준비(한 번)

| 도구 | 왜 | 설치(관리자 PowerShell, winget) |
|---|---|---|
| Git for Windows | checkout | `winget install --id Git.Git -e` |
| PowerShell 7(`pwsh`) | 잡의 기본 셸이 `pwsh`다(Windows PowerShell 5.1 아님) | `winget install --id Microsoft.PowerShell -e` |
| Node 26.13 | `poc/.nvmrc`. `actions/setup-node`가 러너 도구 캐시에 받으므로 따로 깔지 않아도 된다. 손으로 돌려 볼 때만 | `winget install --id OpenJS.NodeJS -e --version 26.13.0`(없으면 nvm-windows) |
| pnpm 12 | `pnpm/action-setup`이 `poc/package.json` `packageManager`(12.11.2)로 받는다. 손으로 돌릴 때만 | `corepack enable` 뒤 `corepack prepare pnpm@12.11.2 --activate` |
| Google Chrome | 금고·CDP 시험이 설치 Chrome을 쓴다(`C:\Program Files\Google\Chrome\Application\chrome.exe`) | `winget install --id Google.Chrome -e` |
| Visual Studio Build Tools 2022(C++) + Python 3 | `better-sqlite3-multiple-ciphers` 미리 빌드한 판이 없으면 node-gyp가 빌드한다 | `winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` 와 `winget install --id Python.Python.3.12 -e` |

긴 경로: pnpm 저장소 경로가 길어 260자를 넘을 수 있다. `git config --system core.longpaths true`를 켠다. Windows 긴 경로 정책(LongPathsEnabled)은 시스템 설정이므로 필요할 때 사용자가 직접 켠다.

러너 전용 로컬 계정을 하나 만든다(예: `sax-runner`, 표준 사용자, 관리자 아님). 이 계정에는 공동인증서·홈택스 로그인·개인 파일을 두지 않는다(§5).

## 2. 등록 토큰 받기

GitHub 저장소 **LAF-labs/tex → Settings → Actions → Runners → New self-hosted runner** → 운영체제 **Windows**, 아키텍처 **x64**(ARM 노트북이면 ARM64). 화면에 나오는 다운로드 URL·SHA-256·`--token` 값을 그대로 쓴다. 토큰은 약 1시간 유효하고 이 문서·채팅·커밋에 붙이지 않는다.

## 3. 설치(러너 계정이 읽고 쓸 수 있는 폴더, 관리자 PowerShell)

```powershell
mkdir C:\actions-runner; cd C:\actions-runner
# 아래 두 줄의 URL·해시는 §2 화면에 나온 값으로 바꾼다
Invoke-WebRequest -Uri <화면의 다운로드 URL> -OutFile actions-runner-win.zip
if ((Get-FileHash actions-runner-win.zip -Algorithm SHA256).Hash.ToUpper() -ne '<화면의 SHA-256>'.ToUpper()) { throw '해시 불일치' }
Expand-Archive actions-runner-win.zip -DestinationPath .
.\config.cmd --url https://github.com/LAF-labs/tex --token <화면의 토큰> --name sax-win-01 --labels sax --work _work
```

- `self-hosted`·`Windows`·`X64` 라벨은 자동으로 붙고, `--labels sax`로 `sax`를 더한다. 잡의 `runs-on: [self-hosted, windows, sax]`와 맞는다(라벨은 대소문자를 가리지 않는다).
- config가 "run the runner as service? (Y/N)"를 물으면 **Y**, 이어서 서비스 계정을 물으면 §1의 `.\sax-runner`와 그 암호를 넣는다(명령줄에 암호를 적지 않으려고 대화형으로 답한다). 기본값(NT AUTHORITY\NETWORK SERVICE)은 쓰지 않는다: 사용자 프로필이 없어 DPAPI·Chrome 프로필 시험이 실제와 다르게 돈다.

## 4. 서비스 확인·관리

```powershell
Get-Service actions.runner.*            # Running이어야 한다
Restart-Service actions.runner.*        # 도구를 새로 깔았으면 PATH를 다시 읽게 재시작
```

GitHub **Settings → Actions → Runners**에 `sax-win-01`이 **Idle**로 보이면 붙은 것이다. 떼어 낼 때는 같은 화면의 **Remove**에서 토큰을 받아 `.\config.cmd remove --token <토큰>`.

## 5. 보안 주의

- 러너는 이 노트북에서 PR 코드를 그대로 실행한다. **신뢰된 PR만** 돌린다:
  - `ci.yml` `windows` 잡은 fork에서 온 PR(`head.repo != 이 저장소`)이면 돌지 않는다.
  - 저장소 **Settings → Actions → General → Fork pull request workflows**에서 "Run workflows from fork pull requests"를 끈다(비공개 저장소 설정).
  - 이 저장소를 공개로 바꾸면 self-hosted 러너를 먼저 뗀다.
- 러너 계정은 표준 사용자다. 관리자 그룹에 넣지 않는다.
- 이 계정에 실제 공동인증서(NPKI)·홈택스·정부24 로그인·브라우저 저장 암호를 두지 않는다. 시험은 가짜 포털(`tests/fixtures/server.ts`)과 시험 비밀(`testSecret`)만 쓴다.
- Windows Hello·TPM: 시험은 `MockHello`·메모리 래퍼를 쓴다. 서비스 세션에서는 Hello 프롬프트를 띄울 수 없다. 실제 Hello·TPM 결박 확인은 CI가 아니라 사람이 앉은 수동 e2e로 한다. 시험이 실제 Hello를 부르게 바뀌면 잡이 프롬프트에서 멈추니 `timeout-minutes: 60`이 끊는다(그때 시험을 고친다).
- 러너 폴더(`C:\actions-runner\_work`)는 실행마다 덮어쓴다. 측정 산출물은 `$RUNNER_TEMP`로 간다(`tests/measure-out.ts`).

## 6. 잡 켜기

러너가 Idle로 보인 뒤:

- 웹: **Settings → Secrets and variables → Actions → Variables 탭 → New repository variable**: 이름 `SAX_WINDOWS_RUNNER`, 값 `true`
- 또는 `gh variable set SAX_WINDOWS_RUNNER --body true --repo LAF-labs/tex`

끄려면 값을 `false`로 바꾸거나 변수를 지운다(잡이 건너뛰어진다). 첫 확인은 **Actions → ci → Run workflow**(main)로 한 번 돌려 본다.
