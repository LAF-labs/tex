# 푸시 디스패처 이미지. 빌드 컨텍스트는 poc/ (docker build -f services/push/Dockerfile .)
# PUSH_TOKEN_KEY·APNs·FCM 자격 증명은 이미지에 없다. 실행 시 KMS가 환경 변수로 주입한다(ENV.md). 이 저장소에서는 빌드·배포하지 않는다(Phase 1).
FROM node:26-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY services/shared services/shared
COPY services/push services/push
# 루트(sax-poc)는 typescript·@types/node 때문에 함께 설치한다. 설치 스크립트는 돌리지 않는다(ADR-028).
RUN pnpm install --frozen-lockfile --ignore-scripts --filter sax-poc --filter "@sax/svc-push..." \
  && pnpm exec tsc -b services/push

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
USER node
EXPOSE 8084
CMD ["node", "services/push/dist/main.js"]
