#!/usr/bin/env bash
# 게이트웨이 생성 호출을 Anthropic으로(ADR-056). 대표 맥 터미널에서 한 번 돌린다:
#   bash ~/Documents/tex/poc/services/deploy/set-anthropic-key.sh
# 키는 화면에 보이지 않게 받아 Vercel Production env로만 넣는다(파일·기록·채팅에 남기지 않는다).
# 되돌리기: bash set-anthropic-key.sh --off  (GATEWAY__GW_RESPOND_PROVIDER를 지운다. 키는 남겨 둔다)
# 반영은 다음 게이트웨이 배포 때다(이 스크립트는 배포하지 않는다).
set -euo pipefail

TEX_DIR="${SAX_TEX_DIR:-$HOME/Documents/tex}"
command -v vercel >/dev/null || { echo "vercel CLI가 없어요. 먼저: npm i -g vercel && vercel login"; exit 1; }
cd "$TEX_DIR" 2>/dev/null || { echo "tex 저장소를 못 찾았어요: $TEX_DIR (SAX_TEX_DIR=경로 로 알려 주세요)"; exit 1; }
[ -f .vercel/project.json ] || vercel link --yes --project tex >/dev/null

if [ "${1:-}" = "--off" ]; then
  vercel env rm GATEWAY__GW_RESPOND_PROVIDER production --yes >/dev/null 2>&1 || true
  echo "끝났어요. 다음 게이트웨이 배포부터 다시 OpenRouter로 갑니다."
  exit 0
fi

read -rsp "Anthropic API 키(sk-ant-...)를 붙여 넣고 Enter: " KEY
echo
case "$KEY" in sk-ant-*) ;; *) echo "sk-ant-로 시작하는 키가 아니에요. 아무것도 바꾸지 않았어요."; exit 1 ;; esac

# 키가 실제로 되는지 먼저 본다(모델 목록 조회, 과금 없음). 키는 명령줄 인자가 아니라 파일 설명자로 넘긴다
code=$(curl -s -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/models -H @<(printf 'x-api-key: %s\n' "$KEY") -H 'anthropic-version: 2026-10-21')
[ "$code" = 200 ] || { echo "키 확인 실패(HTTP $code). 아무것도 바꾸지 않았어요."; exit 1; }

put() { # 이름 값: 있으면 지우고 다시 넣는다. 값은 표준 입력으로만 넘긴다
  vercel env rm "$1" production --yes >/dev/null 2>&1 || true
  printf '%s' "$2" | vercel env add "$1" production >/dev/null
}
put GATEWAY__ANTHROPIC_API_KEY "$KEY"
unset KEY
put GATEWAY__GW_RESPOND_PROVIDER anthropic
echo "끝났어요. 다음 게이트웨이 배포부터 대화가 Claude(claude-haiku-5-5)로 갑니다. 판정(jev)은 그대로 OpenRouter예요."
