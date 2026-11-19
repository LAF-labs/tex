#!/usr/bin/env bash
# 맥북(macOS)·Linux에서 GitHub CI의 옛 macOS·Linux 잡과 같은 검사를 돈다. GitHub에서는 Windows만 돈다(2026-11-19).
# 사용(저장소 어디서든): bash poc/scripts/check-local.sh
# Linux에서 화면이 없으면 xvfb-run으로 감싼다(CI와 같음). 한글 글꼴(fonts-noto-cjk)이 있어야 OCR 시험이 통과한다.
set -euo pipefail
cd "$(dirname "$0")/.."
export CI_OUT="${CI_OUT:-$(mktemp -d)/ci-out}" SAX_MEASURE_DIR="${SAX_MEASURE_DIR:-${CI_OUT}/measure}"
export SAX_TEST_CONCURRENCY="${SAX_TEST_CONCURRENCY:-3}"
mkdir -p "$CI_OUT"
X=()
if [ "$(uname)" = Linux ] && [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null; then X=(xvfb-run -a); export ELECTRON_DISABLE_SANDBOX=1; fi
step() { echo "── $*"; }
step 설치; pnpm install --frozen-lockfile
step 빌드; pnpm build
step 린트; pnpm lint
step 시험; ${X[@]+"${X[@]}"} pnpm test 2>&1 | tee "$CI_OUT/test.log"
step 보안 스위트; ${X[@]+"${X[@]}"} pnpm test:security 2>&1 | tee "$CI_OUT/test-security.log"
step 작업 트리 깨끗함; node scripts/ci-clean-tree.mjs
echo "통과. 로그: $CI_OUT"
