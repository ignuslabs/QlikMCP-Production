# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/package/preparePackage.mjs scripts/package/cleanDist.mjs ./scripts/package/
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /workspace
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV PORT=8000
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node config/connections.example.json ./config/connections.example.json
COPY --chown=node:node test/fixtures ./test/fixtures
USER node
EXPOSE 8000
CMD ["node", "dist/agentcore/runtime.js"]
