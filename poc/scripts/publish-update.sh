#!/usr/bin/env bash
# 운영 업데이트 피드에 새 판 올리기(B6). release-mac.sh가 만든 공증 판을 설치된 앱이 받게 한다. 판마다 한 번 실행한다.
# 순서: ⓪ 점검 → ① zip과 dmg(처음 설치, https://tax.laf-co.com/download/mac이 가리킨다)를 Vercel Blob에 공개로 올림 → ② 매니페스트(판·zip 주소·sha512) 초안에 release-1 서명(Touch ID 1번)
#       → ③ 게시 관문 PUT(운영자 토큰 1번). 기간·타임스탬프는 서버가 붙이고, 그 뒤 재서명 cron이 7일마다 다시 붙인다(사람 손 없음)
#       → ④ 앱과 같은 코드로 확인(check-update-feed.ts: 서명·서버 도장·투명성 로그 포함 증명·zip 바이트).
# 실행(서명 의식 키체인이 있는 대표 Mac): bash poc/scripts/publish-update.sh ~/sax-publish/mac-<판>/out [--rollout 100]
# 처음 한 번은 Blob 저장소(sax-releases, 공개)를 만들어 프로젝트 tex의 development 환경에 잇는다. 쓰기 토큰은 그 환경에서 한 줄만 꺼내
# 작업 폴더 .env.local(0600)에 두고 끝나면 지운다. 운영자 토큰은 화면에 안 보이게 묻고 node 자식 환경으로만 넘긴다.
# 묶음 실행(~/sax-publish/ceremony.sh)은 SAX_ADMIN_TOKEN 환경 변수로 넘긴다. 받자마자 셸 변수로 옮기고 환경에서 지워 vercel 등 자식에 가지 않게 한다.
set -euo pipefail
TOKEN=${SAX_ADMIN_TOKEN:-}
unset SAX_ADMIN_TOKEN

OUT=${1:-}
shift || true
ROLLOUT=100
while [ $# -gt 0 ]; do
  case $1 in
    --rollout) ROLLOUT=$2; shift 2 ;;
    *) echo "모르는 인자: $1" >&2; exit 2 ;;
  esac
done
[ -f "$OUT/report.json" ] || { echo "사용법: bash poc/scripts/publish-update.sh <release-mac.sh 결과 out 폴더> [--rollout N]" >&2; exit 2; }
[[ $ROLLOUT =~ ^([0-9]|[1-9][0-9]|100)$ ]] || { echo "--rollout은 0~100" >&2; exit 2; }
ORIGIN=https://tax.laf-co.com
STORE=sax-releases
VERCEL_PROJECT='{"projectId":"prj_11vAAkrHHiuFAOGY4VoGC1DQ7TNR","orgId":"team_UWlDQKZlAWYrSqYCOnKy39Yx"}'
POC=$(cd "$(dirname "$0")/.." && pwd)
TRUST=services/registry/ceremony/keyepoch-1/trust-root.json
CLI="node --conditions=development services/registry/src/ceremony/cli.ts"
say() { printf '%s\n' "$*"; }
die() { printf '멈춤: %s\n' "$*" >&2; exit 1; }
cd "$POC"

# ⓪ 점검: 공증된 제품 판인가, 운영 피드의 지금 판보다 높은가
command -v vercel >/dev/null || die "vercel CLI가 없다"
[ -x "$HOME/.sax/bin/sax-keychain" ] || die "서명 도우미가 없다(~/.sax/bin/sax-keychain, 서명 의식 한 맥에서 실행한다)"
# 값은 정규식으로 거른 것만 셸 변수로 넘긴다(셸 글자 없음)
VARS=$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const b = r.buildInfo, m = r.mac ?? {}, u = r.update ?? {};
const bad = [];
if (b.dirty !== false || b.testBuild !== false || b.devOnlyIncluded.length) bad.push("제품 빌드 아님(dirty·testBuild·devOnly)");
if (b.signing !== "developer_id" || m.notarized !== true || m.spctl !== "accepted") bad.push("공증 판 아님");
const v = { VERSION: [b.version, /^\d{1,6}\.\d{1,6}\.\d{1,6}$/], CHANNEL: [b.channel, /^(stable|beta)$/], ZIP_NAME: [u.file, /^[A-Za-z0-9._-]{1,128}\.zip$/], ZIP_SIZE: [String(u.size), /^\d{1,10}$/], ZIP_SHA512: [u.sha512, /^[A-Za-z0-9+\/]{86}==$/], DMG_NAME: [r.installer?.file, /^[A-Za-z0-9._-]{1,128}\.dmg$/], DMG_SIZE: [String(r.installer?.size), /^\d{1,10}$/] };
for (const [k, [x, re]] of Object.entries(v)) if (!re.test(String(x))) bad.push(k);
if (String(u.file).replace(/\.zip$/, ".dmg") !== r.installer?.file) bad.push("DMG_NAME(zip 이름과 확장자만 달라야 /download/mac이 찾는다)");
if (bad.length) { console.error("멈춤: " + bad.join(", ")); process.exit(1); }
console.log(Object.entries(v).map(([k, [x]]) => `${k}=${x}`).join("\n"));
' "$OUT/report.json") || exit 1
eval "$VARS"
ZIP=$OUT/dist/$ZIP_NAME
[ "$(stat -f %z "$ZIP")" = "$ZIP_SIZE" ] || die "zip 크기가 report.json과 다르다"
[ "$(openssl dgst -sha512 -binary "$ZIP" | base64)" = "$ZIP_SHA512" ] || die "zip sha512가 report.json과 다르다"
CUR=$(curl -fsS "$ORIGIN/releases/$CHANNEL/latest.json" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("")}})' || true)
if [ -n "$CUR" ]; then
  node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number));const d=a[0]-b[0]||a[1]-b[1]||a[2]-b[2];process.exit(d>0?0:1)' "$VERSION" "$CUR" || die "운영 피드에 이미 ${CUR}가 있다. 더 높은 판만 올린다(내리기는 앞으로 가는 새 판으로)"
fi
W=$(dirname "$OUT")/release-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$W/blob/.vercel"
printf '%s\n' "$VERCEL_PROJECT" > "$W/blob/.vercel/project.json"
trap 'rm -f "$W/blob/.env.local" "$W/blob/.env.pull"' EXIT
say "[⓪] $VERSION(채널 $CHANNEL, 지금 피드 ${CUR:-없음}) zip $ZIP_NAME $(( ZIP_SIZE / 1048576 ))MB, 작업 폴더 $W"

# ① zip → Vercel Blob(공개). 서명·sha512로 검증하므로 공개여도 된다(부장 결정 2026-11-13)
cd "$W/blob"
vercel whoami >/dev/null 2>&1 || die "vercel 로그인이 필요하다(vercel login)"
if vercel blob list-stores 2>&1 | grep -q 'No blob stores connected'; then
  say "    Blob 저장소 ${STORE}를 만들어 프로젝트 tex(development)에 잇는다(처음 한 번)"
  vercel blob create-store "$STORE" --access public --region icn1 --environment development --yes >/dev/null 2>&1 \
    || vercel blob create-store "$STORE" --access public --environment development --yes >/dev/null \
    || die "Blob 저장소를 만들지 못했다"
fi
( umask 077 && vercel env pull .env.pull --environment development --yes >/dev/null 2>&1 ) || die "프로젝트 환경 변수를 받지 못했다"
( umask 077 && grep '^BLOB_READ_WRITE_TOKEN=' .env.pull > .env.local ) || die "BLOB_READ_WRITE_TOKEN이 없다(저장소가 development 환경에 이어져 있는지)"
rm -f .env.pull
PATHNAME=releases/$CHANNEL/$ZIP_NAME
PUT=$(vercel blob put "$ZIP" --access public --pathname "$PATHNAME" --content-type application/zip --cache-control-max-age 31536000 --multipart true 2>&1 || true)
URL=$(grep -oE "https://[a-z0-9-]+\.public\.blob\.vercel-storage\.com/$PATHNAME" <<<"$PUT" | head -1 || true)
[ -n "$URL" ] || URL=$(vercel blob list 2>&1 | grep -oE "https://[a-z0-9-]+\.public\.blob\.vercel-storage\.com/$PATHNAME" | head -1 || true)
DMG_URL=
if [ -n "$URL" ]; then
  DPUT=$(vercel blob put "$OUT/dist/$DMG_NAME" --access public --pathname "releases/$CHANNEL/$DMG_NAME" --content-type application/x-apple-diskimage --cache-control-max-age 31536000 --multipart true 2>&1 || true)
  DMG_URL=${URL%.zip}.dmg
fi
rm -f .env.local
[ -n "$URL" ] || die "Blob 업로드 주소를 얻지 못했다: $(tail -3 <<<"$PUT")"
GOT=$(curl -fsSI "$DMG_URL" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ll]ength: //p' | tail -1 || true)
[ "$GOT" = "$DMG_SIZE" ] || die "dmg $DMG_URL 크기가 ${GOT:-없음}이다(기대 $DMG_SIZE): $(tail -3 <<<"$DPUT")"
say "[①] dmg → $DMG_URL"
cd "$POC"
GOT=$(curl -fsSI "$URL" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ll]ength: //p' | tail -1)
[ "$GOT" = "$ZIP_SIZE" ] || die "$URL 크기가 ${GOT:-없음}이다(기대 $ZIP_SIZE)"
say "[①] zip → $URL"

# ② 매니페스트 초안(판·파일·주소·사람 서명 시각). 기간은 넣지 않는다(서버 도장)
node -e '
const [out, channel, version, url, size, sha512, rollout] = process.argv.slice(1);
const doc = { channel, version, releaseDate: new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"), rolloutPercent: Number(rollout), files: [{ url, sha512, size: Number(size) }] };
require("fs").writeFileSync(out, JSON.stringify(doc, null, 2) + "\n", { flag: "wx" });
' "$W/latest.draft.json" "$CHANNEL" "$VERSION" "$URL" "$ZIP_SIZE" "$ZIP_SHA512" "$ROLLOUT"
CODE=$($CLI prepare --kind release "$W/latest.draft.json" | sed -n 's/^확인 코드 \([0-9a-f-]*\).*/\1/p')
[ -n "$CODE" ] || die "확인 코드를 만들지 못했다"
say ""
say "    Touch ID 확인 코드: $CODE   (창의 코드가 이것과 같을 때만 누른다)"
say ""
$CLI sign --kind release --key-id release-1 --confirm "$CODE" --trust "$TRUST" --out "$W/release-1.sig.json" "$W/latest.draft.json"
$CLI collect --kind release --trust "$TRUST" --out "$W/latest.json" "$W/latest.draft.json" "$W/release-1.sig.json"
curl -fsS "$ORIGIN/registry/revoked_keys.json" -o "$W/revoked_keys.json"
$CLI check --kind release --trust "$TRUST" --revoked "$W/revoked_keys.json" "$W/latest.json"
say "[②] 서명 → $W/latest.json"

# ③ 게시 관문 PUT: 서버가 서명·단조 버전을 다시 보고, 기간·타임스탬프를 붙이고, 투명성 로그에 먼저 기록한다
if [ -z "$TOKEN" ]; then
  read -rsp "운영자 토큰(REGISTRY__REGISTRY_ADMIN_TOKEN 값, 화면에 안 보임): " TOKEN
  printf '\n'
fi
SAX_ADMIN_TOKEN=$TOKEN node -e '
const [origin, channel, file] = process.argv.slice(1);
const body = require("fs").readFileSync(file);
fetch(`${origin}/admin/v1/releases/${channel}`, { method: "PUT", headers: { authorization: `Admin ${process.env.SAX_ADMIN_TOKEN}`, "content-type": "application/json" }, body })
  .then(async (r) => { const t = await r.text(); console.log(`PUT /admin/v1/releases/${channel} → ${r.status} ${t.slice(0, 200)}`); process.exit(r.status === 200 ? 0 : 1); })
  .catch((e) => { console.error(e.message); process.exit(1); });
' "$ORIGIN" "$CHANNEL" "$W/latest.json"
unset TOKEN
say "[③] 게시함(기간은 서버 도장, 재서명 cron이 이어 간다)"

# ④ 설치된 앱과 같은 코드로 확인(CDN 캐시 60초라 몇 번 기다린다). --download로 zip 바이트까지 본다
for i in 1 2 3 4 5 6; do
  if node --conditions=development scripts/check-update-feed.ts --channel "$CHANNEL" --expect "$VERSION" --download | tee "$W/check.txt"; then
    say "[④] 확인 끝: 설치된 앱은 다음 확인(기동·15분마다)에 ${VERSION}을 받는다. 기록 $W/check.txt"
    [ "$CHANNEL" = beta ] && say "    처음 설치 링크: $ORIGIN/download/mac → $(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "$ORIGIN/download/mac")"
    exit 0
  fi
  say "    아직 아니다. 30초 뒤 다시 본다($i/6)"
  sleep 30
done
die "게시는 됐지만 확인이 통과하지 않았다($W/check.txt)"
