FROM node:24.16.0-bookworm-slim AS build
WORKDIR /work
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/api-contracts/package.json packages/api-contracts/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html apps/web/
COPY apps/web/src apps/web/src
ARG GEOPS_WEB_BASE=/
ENV GEOPS_WEB_BASE=${GEOPS_WEB_BASE}
ARG MDM_ENABLED=false
ENV VITE_MDM_ENABLED=${MDM_ENABLED}
RUN npm run build --workspace @geops/web

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY infrastructure/nginx/geops-web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /work/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
