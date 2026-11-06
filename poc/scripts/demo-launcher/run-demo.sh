#!/bin/bash
# 시연 실행기(macOS). install.sh가 만든 .app이 이 파일을 부른다. 터미널에서 바로 불러도 된다.
# pnpm demo:model과 같다(fixture 모드: 가짜 H-01 페이지, 시험 구성 금고, SAX_DEMO_MODEL=openrouter). 빌드만 잠금 안에서 한다.
# 키는 이 스크립트가 읽지 않는다. main 프로세스가 poc/.env.local에서 OPENROUTER_API_KEY·OPENROUTER_MODEL만 읽는다(demo-model.ts).
# 키가 없거나 네트워크가 없으면 앱이 정규식(오프라인) 해석으로 돈다.
set -u
POC="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$HOME/Library/Logs/sax-demo.log"
mkdir -p "$(dirname "$LOG")"

alert() {
  /usr/bin/osascript -e "display alert \"소버린 AX 데모\" message \"$1\n\n기록: $LOG\" as critical" >/dev/null 2>&1
}

# Finder·Dock에서 켜면 PATH가 짧다. 로그인 셸의 PATH를 쓰고, Homebrew 기본 위치를 덧붙인다.
LOGIN_PATH="$(/bin/zsh -lc 'printf %s "$PATH"' 2>/dev/null)"
export PATH="${LOGIN_PATH:+$LOGIN_PATH:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

{
  echo "== $(date '+%Y-%m-%d %H:%M:%S') 시작 ($POC)"
  if ! command -v pnpm >/dev/null; then
    alert "pnpm을 찾지 못했어요. 터미널에서 pnpm이 되는지 확인해 주세요."
    exit 1
  fi
  cd "$POC" || exit 1
  # 처음 한 번은 의존성·Electron 바이너리가 있어야 한다(네트워크 필요). 있으면 건너뛴다.
  if [ ! -x node_modules/.bin/electron ] || [ ! -e node_modules/electron/path.txt ]; then
    echo "-- pnpm install"
    if ! pnpm install --frozen-lockfile; then
      alert "처음 설치(pnpm install)에 실패했어요. 네트워크를 확인하고 다시 눌러 주세요."
      exit 1
    fi
  fi
  /usr/bin/osascript -e 'display notification "빌드하고 창을 여는 중이에요(몇 초)." with title "소버린 AX 데모"' >/dev/null 2>&1
  # 빌드는 한 번에 하나(첫 빌드 중에 또 누르면 같은 dist에 둘이 쓰지 않게). flock은 커널이 쥐고 프로세스가 끝나면 풀리므로
  # 남은 잠금·경합 처리가 따로 없다. 앞 빌드가 끝날 때까지 기다린다. macOS 기본 perl로 건다(flock 명령이 없다).
  # 시그널로 끊긴 빌드(종료 코드 없음)도 실패로 넘긴다.
  # 창은 하나다: 이미 떠 있으면 Electron이 기존 창을 앞으로 가져오고 끝난다(shell.ts single-instance).
  if ! /usr/bin/perl -MFcntl=:flock -e 'open(my $f, ">>", shift) or die; flock($f, LOCK_EX) or die; system(@ARGV); exit($? == 0 ? 0 : (($? >> 8) || 1))' "${TMPDIR:-/tmp}/sax-demo-build.flock" pnpm build; then
    alert "빌드에 실패했어요."
    exit 1
  fi
  SAX_DEMO_MODEL=openrouter pnpm exec electron apps/desktop/dist/demo-shell.js
  code=$?
  echo "== $(date '+%H:%M:%S') 끝 (exit $code)"
  if [ "$code" -ne 0 ]; then alert "데모가 비정상으로 끝났어요(exit $code)."; fi
} >>"$LOG" 2>&1
