FROM node:24.16.0-bookworm-slim
WORKDIR /work
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/api-contracts/package.json packages/api-contracts/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages/api-contracts/tsconfig*.json packages/api-contracts/
COPY packages/api-contracts/src packages/api-contracts/src
COPY apps/api/tsconfig*.json apps/api/
COPY apps/api/src apps/api/src
COPY apps/api/test apps/api/test
COPY apps/api/scripts apps/api/scripts
COPY scripts/release-0015 scripts/release-0015
RUN npm run build --workspace @geops/api-contracts && npm run build --workspace @geops/api
CMD ["node", "--version"]
