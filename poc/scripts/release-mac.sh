#!/usr/bin/env bash
# macOS 고객 배포판(B6): main 커밋 → 빌드 → 공증(앱·dmg) → 스테이플 → Gatekeeper 확인까지 한 번에. 게시는 하지 않는다(publish-update.sh).
# 실행(대표 Mac): bash poc/scripts/release-mac.sh <판 x.y.z> [main 커밋, 기본 origin/main]
# 전제(처음 한 번):
#   - 키체인에 "Developer ID Application: … (JA55KTZH34)" 신원이 하나 있다.
#   - notarytool 키체인 프로필 sax-notary가 있다. 없으면 이 스크립트가 store-credentials 명령 두 가지를 보여 주고 멈춘다.
# 결과: ~/sax-publish/mac-<판>/out 아래 dmg(고객 설치용), zip(자동 업데이트용), report.json, verify.txt.
# 다른 Mac에서 열리는지는 내려받은 사본처럼 격리 속성(quarantine)을 붙인 사본으로 spctl이 판정한다(시스템 설정은 바꾸지 않는다).
set -euo pipefail

VERSION=${1:-}
REF=${2:-origin/main}
PROFILE=${SAX_NOTARY_PROFILE:-sax-notary}
TEAM=JA55KTZH34
[[ $VERSION =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]] || { echo "사용법: bash poc/scripts/release-mac.sh <판 x.y.z> [main 커밋]" >&2; exit 2; }
REPO=$(cd "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
WORK=$HOME/sax-publish/mac-$VERSION
OUT=$WORK/out
say() { printf '%s\n' "$*"; }
die() { printf '멈춤: %s\n' "$*" >&2; exit 1; }

# ⓪ 서명 신원·공증 자격(값은 보지 않는다, 이름·성공 여부만)
n=$(security find-identity -v -p codesigning | grep -c "\"Developer ID Application: .*($TEAM)\"" || true)
[ "$n" = 1 ] || die "키체인에 Developer ID Application ($TEAM) 신원이 ${n}개다(1개여야 한다)"
if ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  cat >&2 <<EOF
멈춤: 공증 자격(키체인 프로필 $PROFILE)이 없거나 맞지 않는다. 아래 둘 중 하나를 터미널에서 한 번 실행한다(비밀값은 프롬프트로만 넣는다).

  (가) Apple ID + 앱 암호(appleid.apple.com > 로그인 및 보안 > 앱 암호에서 새로 만든 것):
      xcrun notarytool store-credentials $PROFILE --apple-id "<Apple ID 이메일>" --team-id $TEAM

  (나) App Store Connect API 키(사용자 및 액세스 > 통합 > App Store Connect API > 팀 키, 역할 Developer 이상, .p8은 한 번만 받는다):
      xcrun notarytool store-credentials $PROFILE --key "<AuthKey_XXXXXXXXXX.p8 경로>" --key-id "<키 ID>" --issuer "<Issuer ID>"

  확인: xcrun notarytool history --keychain-profile $PROFILE  (목록이 나오면 된다. 비어 있어도 된다)
EOF
  exit 2
fi
say "[⓪] 서명 신원 1개(팀 $TEAM), 공증 프로필 $PROFILE 확인"

# ① 원본: origin/main 안의 커밋을 분리 체크아웃으로(빌드가 dirty:false가 되게)
git -C "$REPO" fetch -q origin main
SHA=$(git -C "$REPO" rev-parse --verify "$REF^{commit}") || die "커밋을 찾지 못했다: $REF"
git -C "$REPO" merge-base --is-ancestor "$SHA" origin/main || die "${SHA:0:8}은 origin/main에 없는 커밋이다"
SRC=$WORK/src
if [ -d "$SRC" ]; then
  [ "$(git -C "$SRC" rev-parse HEAD)" = "$SHA" ] || die "$SRC가 다른 커밋이다. 폴더를 지우거나(git -C $REPO worktree remove $SRC) 판을 올린다"
else
  mkdir -p "$WORK"
  git -C "$REPO" worktree add -q --detach "$SRC" "$SHA"
fi
[ -e "$OUT" ] && die "$OUT이 이미 있다. 같은 판을 다시 만들려면 그 폴더를 옮기거나 지운다"
say "[①] 원본 ${SHA:0:8} → $SRC"

# ② 빌드·공증·스테이플(scripts/package-win.mjs --mac: 앱은 electron-builder가, dmg는 notarytool이 공증한다)
cd "$SRC/poc"
pnpm install --frozen-lockfile
rm -f apps/desktop/tsconfig.tsbuildinfo
SAX_NOTARY_PROFILE=$PROFILE SAX_APP_VERSION=$VERSION node scripts/package-win.mjs --mac --out "$OUT"
DIST=$OUT/dist
DMG=$(ls "$DIST"/*.dmg)
ZIP=$(ls "$DIST"/*.zip)

# ③ 따로 확인(보고서만 믿지 않는다): 산출물을 다시 열어 본다
V=$OUT/verify.txt
: > "$V"
log() { printf '%s\n' "$*" | tee -a "$V"; }
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const b = r.buildInfo, m = r.mac ?? {};
const bad = [];
if (b.version !== process.argv[2]) bad.push("version");
if (b.dirty !== false) bad.push("dirty");
if (b.testBuild !== false) bad.push("testBuild");
if (b.devOnlyIncluded.length) bad.push("devOnlyIncluded");
if (b.signing !== "developer_id" || m.teamId !== process.argv[3]) bad.push("signing");
if (m.notarized !== true || m.stapled !== true || m.spctl !== "accepted") bad.push("notarization");
if (bad.length) { console.error("report.json 확인 실패: " + bad.join(", ")); process.exit(1); }
console.log(`report.json: ${b.version} ${b.commit.slice(0, 8)} dirty=false testBuild=false 공증 ${m.dmgNotarization} spctl ${m.spctl} (${m.source})`);
' "$OUT/report.json" "$VERSION" "$TEAM" | tee -a "$V"
xcrun stapler validate "$DMG" >/dev/null && log "dmg 스테이플: 있음"
spctl --assess --type open --context context:primary-signature -vv "$DMG" 2>&1 | tee -a "$V" | grep -q accepted || die "spctl이 dmg를 받지 않는다(verify.txt)"
T=$(mktemp -d "${TMPDIR:-/tmp}/sax-release-check.XXXXXX")
trap 'hdiutil detach "$T/mnt" >/dev/null 2>&1 || true; rm -rf "$T"' EXIT
mkdir -p "$T/mnt" "$T/from-dmg" "$T/from-zip"
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$T/mnt" "$DMG" >/dev/null
ditto "$T/mnt/SovereignAX.app" "$T/from-dmg/SovereignAX.app"
hdiutil detach "$T/mnt" >/dev/null
ditto -x -k "$ZIP" "$T/from-zip"
Q="0083;$(printf '%x' "$(date +%s)");Safari;"
for from in from-dmg from-zip; do
  app=$T/$from/SovereignAX.app
  xattr -w com.apple.quarantine "$Q" "$app"
  xcrun stapler validate "$app" >/dev/null || die "$from 앱에 공증 티켓이 없다"
  team=$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')
  [ "$team" = "$TEAM" ] || die "$from 앱 팀 ID가 $team이다"
  a=$(spctl --assess --type execute -vv "$app" 2>&1 || true)
  printf '%s\n' "$a" >> "$V"
  grep -q 'accepted' <<<"$a" && grep -q 'source=Notarized Developer ID' <<<"$a" || die "$from 앱(격리 속성 사본)을 Gatekeeper가 받지 않는다(verify.txt)"
  log "$from 앱(격리 속성 사본): 스테이플 있음, 팀 $TEAM, spctl accepted(Notarized Developer ID)"
done

say ""
say "끝. 다른 Mac에서 열리는 공증 판이다."
say "  고객 설치: $DMG"
say "  sha256:    $(shasum -a 256 "$DMG" | cut -d' ' -f1)"
say "  업데이트:  $ZIP"
say "  확인 기록: $V"
say "다음(운영 피드 게시, Touch ID 1번): bash $SRC/poc/scripts/publish-update.sh $OUT"
