#!/usr/bin/env bash
# 운영 업데이트 피드에 새 판 올리기(B6). release-mac.sh가 만든 공증 판을 설치된 앱이 받게 한다.
# 순서: ⓪ 점검 → ① 매니페스트 초안 → ② release-1 서명(Touch ID 1번) → ③ zip을 레지스트리 버킷에 → ④ 게시 관문 PUT(운영자 토큰 1번)
#       → ⑤ 앱과 같은 코드로 확인(check-update-feed.ts: 서명·기간·투명성 로그 포함 증명·zip 바이트).
# 실행(서명 의식 키체인이 있는 대표 Mac): bash poc/scripts/publish-update.sh ~/sax-publish/mac-<판>/out [--rollout 100] [--refresh]
#   --refresh  같은 판·같은 파일을 새 기간(14일)으로 다시 서명해 올린다. zip은 다시 올리지 않는다. 만료 전에 한 번씩.
# 비밀값은 출력·파일·인자에 남기지 않는다: 운영자 토큰은 화면에 안 보이게 묻고 node 자식 환경으로만 넘긴다.
set -euo pipefail

OUT=${1:-}
shift || true
ROLLOUT=100
REFRESH=0
while [ $# -gt 0 ]; do
  case $1 in
    --rollout) ROLLOUT=$2; shift 2 ;;
    --refresh) REFRESH=1; shift ;;
    *) echo "모르는 인자: $1" >&2; exit 2 ;;
  esac
done
[ -f "$OUT/report.json" ] || { echo "사용법: bash poc/scripts/publish-update.sh <release-mac.sh 결과 out 폴더> [--rollout N] [--refresh]" >&2; exit 2; }
[[ $ROLLOUT =~ ^([0-9]|[1-9][0-9]|100)$ ]] || { echo "--rollout은 0~100" >&2; exit 2; }
ORIGIN=https://tax.laf-co.com
BUCKET=sax-registry
POC=$(cd "$(dirname "$0")/.." && pwd)
MAIN=$(cd "$(git -C "$POC" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
DEPLOY=$MAIN/poc/services/deploy
TRUST=services/registry/ceremony/keyepoch-1/trust-root.json
CLI="node --conditions=development services/registry/src/ceremony/cli.ts"
say() { printf '%s\n' "$*"; }
die() { printf '멈춤: %s\n' "$*" >&2; exit 1; }
cd "$POC"

# ⓪ 점검: 공증된 제품 판인가, 운영 피드의 지금 판보다 높은가(--refresh면 같은가)
command -v supabase >/dev/null || die "supabase CLI가 없다"
[ -f "$DEPLOY/supabase/.temp/project-ref" ] || die "연결된 Supabase 프로젝트가 없다($DEPLOY/supabase/.temp)"
[ -x "$HOME/.sax/bin/sax-keychain" ] || die "서명 도우미가 없다(~/.sax/bin/sax-keychain, 서명 의식 한 맥에서 실행한다)"
# 값은 정규식으로 거른 것만 셸 변수로 넘긴다(셸 글자 없음)
VARS=$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const b = r.buildInfo, m = r.mac ?? {}, u = r.update ?? {};
const bad = [];
if (b.dirty !== false || b.testBuild !== false || b.devOnlyIncluded.length) bad.push("제품 빌드 아님(dirty·testBuild·devOnly)");
if (b.signing !== "developer_id" || m.notarized !== true || m.spctl !== "accepted") bad.push("공증 판 아님");
const v = { VERSION: [b.version, /^\d{1,6}\.\d{1,6}\.\d{1,6}$/], CHANNEL: [b.channel, /^(stable|beta)$/], ZIP_NAME: [u.file, /^[A-Za-z0-9._-]{1,128}\.zip$/], ZIP_SIZE: [String(u.size), /^\d{1,10}$/], ZIP_SHA512: [u.sha512, /^[A-Za-z0-9+\/]{86}==$/] };
for (const [k, [x, re]] of Object.entries(v)) if (!re.test(String(x))) bad.push(k);
if (bad.length) { console.error("멈춤: " + bad.join(", ")); process.exit(1); }
console.log(Object.entries(v).map(([k, [x]]) => `${k}=${x}`).join("\n"));
' "$OUT/report.json") || exit 1
eval "$VARS"
ZIP=$OUT/dist/$ZIP_NAME
[ "$(stat -f %z "$ZIP")" = "$ZIP_SIZE" ] || die "zip 크기가 report.json과 다르다"
[ "$(openssl dgst -sha512 -binary "$ZIP" | base64)" = "$ZIP_SHA512" ] || die "zip sha512가 report.json과 다르다"
CUR=$(curl -fsS "$ORIGIN/releases/$CHANNEL/latest.json" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("")}})' || true)
if [ "$REFRESH" = 1 ]; then
  [ "$CUR" = "$VERSION" ] || die "--refresh는 운영 피드의 지금 판($CUR)과 같은 판이어야 한다"
elif [ -n "$CUR" ]; then
  node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number));const d=a[0]-b[0]||a[1]-b[1]||a[2]-b[2];process.exit(d>0?0:1)' "$VERSION" "$CUR" || die "운영 피드에 이미 $CUR가 있다. 더 높은 판만 올린다(내리기는 앞으로 가는 새 판으로)"
fi
W=$(dirname "$OUT")/release-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$W"
say "[⓪] $VERSION(채널 $CHANNEL, 지금 피드 ${CUR:-없음}) zip $ZIP_NAME $(( ZIP_SIZE / 1048576 ))MB, 작업 폴더 $W"

# ① 매니페스트 초안(유효 기간 14일 상한보다 1시간 짧게)
node -e '
const [out, channel, version, url, size, sha512, rollout] = process.argv.slice(1);
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const now = Date.now();
const doc = { channel, version, releaseDate: iso(now - 60_000), expiresAt: iso(now + 14 * 864e5 - 3600_000), rolloutPercent: Number(rollout), files: [{ url, sha512, size: Number(size) }] };
require("fs").writeFileSync(out, JSON.stringify(doc, null, 2) + "\n", { flag: "wx" });
' "$W/latest.draft.json" "$CHANNEL" "$VERSION" "$ZIP_NAME" "$ZIP_SIZE" "$ZIP_SHA512" "$ROLLOUT"
CODE=$($CLI prepare --kind release "$W/latest.draft.json" | sed -n 's/^확인 코드 \([0-9a-f-]*\).*/\1/p')
[ -n "$CODE" ] || die "확인 코드를 만들지 못했다"
say "[①] 초안 $W/latest.draft.json"

# ② 서명: Touch ID 창의 확인 코드가 아래 값과 같은지 보고 누른다(CEREMONY.md §1)
say ""
say "    Touch ID 확인 코드: $CODE"
say ""
$CLI sign --kind release --key-id release-1 --confirm "$CODE" --trust "$TRUST" --out "$W/release-1.sig.json" "$W/latest.draft.json"
$CLI collect --kind release --trust "$TRUST" --out "$W/latest.json" "$W/latest.draft.json" "$W/release-1.sig.json"
curl -fsS "$ORIGIN/registry/revoked_keys.json" -o "$W/revoked_keys.json"
$CLI check --kind release --trust "$TRUST" --revoked "$W/revoked_keys.json" "$W/latest.json"
say "[②] 서명 → $W/latest.json"

# ③ zip을 버킷 releases/<채널>/에(공개 주소 $ORIGIN/releases/<채널>/<파일>은 Vercel 재작성 → 버킷). 매니페스트보다 먼저 올린다
if [ "$REFRESH" = 0 ]; then
  LIMIT=$(supabase db query --linked --workdir "$DEPLOY" "select coalesce(file_size_limit, 0) as l from storage.buckets where id = '$BUCKET'" -o json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=/"l"\s*:\s*"?(\d+)/.exec(s);console.log(m?m[1]:"")})')
  [ -n "$LIMIT" ] || die "버킷 $BUCKET 크기 상한을 읽지 못했다(supabase login·link 확인)"
  if [ "$LIMIT" != 0 ] && [ "$LIMIT" -lt "$ZIP_SIZE" ]; then
    say "    버킷 $BUCKET 파일 크기 상한 ${LIMIT}B < zip ${ZIP_SIZE}B → 512MB로 올린다"
    supabase db query --linked --workdir "$DEPLOY" "update storage.buckets set file_size_limit = 536870912 where id = '$BUCKET'" >/dev/null
  fi
  if ! supabase storage cp --linked --experimental --workdir "$DEPLOY" --content-type application/zip --cache-control "public, max-age=31536000, immutable" "$ZIP" "ss:///$BUCKET/releases/$CHANNEL/$ZIP_NAME"; then
    die "zip 업로드 실패. 크기 때문이면 Supabase 대시보드 > Project Settings > Storage > Upload file size limit을 200MB 이상으로 올린 뒤 다시 실행한다(무료 요금제 상한 50MB)"
  fi
  GOT=$(curl -fsSI "$ORIGIN/releases/$CHANNEL/$ZIP_NAME" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ll]ength: //p' | tail -1)
  [ "$GOT" = "$ZIP_SIZE" ] || die "$ORIGIN/releases/$CHANNEL/$ZIP_NAME 크기가 ${GOT:-없음}이다(기대 $ZIP_SIZE)"
  say "[③] zip 올림, 공개 주소 크기 확인"
else
  say "[③] --refresh: zip은 그대로"
fi

# ④ 게시 관문 PUT(서명·기간·단조 버전을 서버가 다시 본다, 투명성 로그에 먼저 기록)
read -rsp "운영자 토큰(REGISTRY__REGISTRY_ADMIN_TOKEN 값, 화면에 안 보임): " TOKEN
printf '\n'
SAX_ADMIN_TOKEN=$TOKEN node -e '
const [origin, channel, file] = process.argv.slice(1);
const body = require("fs").readFileSync(file);
fetch(`${origin}/admin/v1/releases/${channel}`, { method: "PUT", headers: { authorization: `Admin ${process.env.SAX_ADMIN_TOKEN}`, "content-type": "application/json" }, body })
  .then(async (r) => { const t = await r.text(); console.log(`PUT /admin/v1/releases/${channel} → ${r.status} ${t.slice(0, 200)}`); process.exit(r.status === 200 ? 0 : 1); })
  .catch((e) => { console.error(e.message); process.exit(1); });
' "$ORIGIN" "$CHANNEL" "$W/latest.json"
unset TOKEN
say "[④] 게시함"

# ⑤ 설치된 앱과 같은 코드로 확인(CDN 캐시 60초라 몇 번 기다린다). --download로 zip 바이트까지 본다
for i in 1 2 3 4 5 6; do
  if node --conditions=development scripts/check-update-feed.ts --channel "$CHANNEL" --expect "$VERSION" --download | tee "$W/check.txt"; then
    say "[⑤] 확인 끝: 설치된 앱은 다음 확인(기동·15분마다)에 $VERSION을 받는다. 기록 $W/check.txt"
    exit 0
  fi
  say "    아직 아니다. 30초 뒤 다시 본다($i/6)"
  sleep 30
done
die "게시는 됐지만 확인이 통과하지 않았다($W/check.txt)"
