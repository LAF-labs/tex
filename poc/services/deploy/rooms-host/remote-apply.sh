#!/usr/bin/env bash
# 룸 호스트 VM에서 돈다(rooms-host-deploy.yml이 ssh 표준 입력으로 넘긴다). TAG = 배포할 커밋(12자).
# 올린 파일(/opt/sax-rooms/incoming/)을 제자리에 두고 이미지를 읽어 compose로 갈아 끼운다. 이전 이미지 둘만 남긴다.
set -euo pipefail
: "${TAG:?TAG}"
[[ "${TAG}" =~ ^[0-9a-f]{12}$ ]] || { echo "bad TAG"; exit 1; }
cd /opt/sax-rooms
test -f relay.env || { echo "relay.env 없음: README 2단계를 먼저 하세요"; exit 1; }
[ "$(stat -c %a relay.env)" = 600 ] || { echo "relay.env 권한은 600이어야 합니다"; exit 1; }
install -m 644 incoming/compose.yml compose.yml
install -m 644 incoming/Caddyfile Caddyfile
gunzip -c incoming/sax-relay.tar.gz | docker load
rm -f incoming/sax-relay.tar.gz
printf 'SAX_RELAY_TAG=%s\n' "${TAG}" > .env
docker compose up -d --remove-orphans
# 새 컨테이너가 healthy가 될 때까지(최대 60초)
for _ in $(seq 1 30); do
  st="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q relay)" 2>/dev/null || true)"
  [ "${st}" = healthy ] && break
  sleep 2
done
[ "${st:-}" = healthy ] || { docker compose logs --tail 50 relay; exit 1; }
docker image ls sax-relay --format '{{.Tag}}' | grep -v "^${TAG}$" | tail -n +3 | xargs -r -I{} docker image rm "sax-relay:{}"
echo "deployed ${TAG}"
