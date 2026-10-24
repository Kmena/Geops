FROM node:24.16.0-bookworm-slim AS build
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
COPY apps/api/mdm-oauth-core.mjs apps/api/mdm-oauth-core.d.mts apps/api/
COPY apps/api/scripts apps/api/scripts
RUN npm run build --workspace @geops/api-contracts && npm run build --workspace @geops/api
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.16.0-bookworm-slim
ARG GEOPS_API_VARIANT=unspecified
LABEL org.geops.api.variant=${GEOPS_API_VARIANT}
ENV NODE_ENV=development
WORKDIR /work
COPY --from=build /work/node_modules ./node_modules
COPY --from=build /work/package.json ./package.json
COPY --from=build /work/apps/api/package.json ./apps/api/package.json
COPY --from=build /work/apps/api/dist ./apps/api/dist
COPY --from=build /work/apps/api/mdm-oauth-core.mjs ./apps/api/mdm-oauth-core.mjs
COPY --from=build /work/packages/api-contracts/package.json ./packages/api-contracts/package.json
COPY --from=build /work/packages/api-contracts/dist ./packages/api-contracts/dist
RUN mkdir /geops-security && chown node:node /geops-security
USER node
EXPOSE 3500
CMD ["node", "apps/api/dist/main.js"]
