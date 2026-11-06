# 레지스트리 이미지. 빌드 컨텍스트는 poc/ (docker build -f services/registry/Dockerfile .)
# 이미지에는 공개키(TRUST_ROOT_JSON, 실행 시 주입)만 들어간다. 서명 개인 키는 이미지·CI·저장소 어디에도 없다(ADR-013·028).
# 이 저장소에서는 빌드·배포하지 않는다(Phase 1). 운영에서는 CDN(정적 파일) 앞단 + 이 서비스는 게시 관문으로만 쓴다.
FROM node:26-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY services/shared services/shared
COPY services/registry services/registry
# 관문은 엔진 코어(스키마·.sxp·보수성 판정)를 그대로 쓴다. 엔진의 tsc 참조 패키지도 함께(미검증: 이 저장소에서 Docker를 빌드하지 않았다)
COPY packages packages
# 설치 스크립트는 돌리지 않는다(ADR-028).
RUN pnpm install --frozen-lockfile --ignore-scripts --filter sax-poc --filter "@sax/svc-registry..." \
  && pnpm exec tsc -b services/registry

FROM node:26-slim
ENV NODE_ENV=production REGISTRY_DIR=/data
WORKDIR /app
COPY --from=build /app ./
USER node
VOLUME ["/data"]
EXPOSE 8082
CMD ["node", "services/registry/dist/main.js"]
