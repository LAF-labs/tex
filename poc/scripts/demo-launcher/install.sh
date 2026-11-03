#!/bin/bash
# 시연 실행기 .app을 만든다(AppleScript 애플릿, 로컬 임시 서명. 정식 서명·패키징 아님). 앱은 이 체크아웃의 run-demo.sh 경로를 품는다.
# 쓰기: bash scripts/demo-launcher/install.sh [놓을 폴더, 기본 ~/Applications]
# 레포가 ~/Documents 아래면 처음 켤 때 macOS가 "문서 폴더 접근"을 묻는다. 허용해야 켜진다(셸 스크립트만 든 앱은 묻지도 않고 막힌다).
# 다시 만들면 다시 묻는다. 체크아웃을 옮기거나 지우면 다시 만든다. 지우기: 만든 .app을 휴지통으로.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
POC="$(cd "$HERE/../.." && pwd)"
DEST="${1:-$HOME/Applications}"
APP="$DEST/소버린 AX 데모.app"
RUN="$HERE/run-demo.sh"
case "$RUN" in *\"*|*\\*) echo "경로에 따옴표·역슬래시가 있으면 만들 수 없어요: $RUN" >&2; exit 1 ;; esac

mkdir -p "$DEST"
rm -rf "$APP"
# run-demo.sh는 뒤에서 띄우고 애플릿은 바로 끝난다. 창은 Electron이 연다. 스크립트가 없어졌으면 알린다.
/usr/bin/osacompile -o "$APP" <<OSA
on run
  set runner to "$RUN"
  try
    do shell script "test -f " & quoted form of runner
  on error
    display alert "소버린 AX 데모" message "실행 스크립트를 열지 못했어요. 문서 폴더 접근을 거부했다면 시스템 설정 > 개인정보 보호 및 보안 > 파일 및 폴더에서 이 앱을 켜 주세요. 체크아웃을 옮겼다면 install.sh를 다시 실행해 주세요." as critical
    return
  end try
  do shell script "/bin/bash " & quoted form of runner & " >/dev/null 2>&1 &"
end run
OSA

ICON="$POC/node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns"
[ -f "$ICON" ] && cp "$ICON" "$APP/Contents/Resources/applet.icns"
/usr/bin/codesign -s - --force "$APP"

echo "만들었어요: $APP"
echo "Dock에 올리기: Finder에서 이 앱을 Dock으로 끌어다 놓으세요. 처음 켤 때 '문서 폴더 접근'을 허용해 주세요."
