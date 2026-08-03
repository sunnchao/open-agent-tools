# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:20.20.2-alpine3.23@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

FROM ${NODE_IMAGE} AS builder
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/mcp-contracts/package.json packages/mcp-contracts/tsconfig.json packages/mcp-contracts/
COPY runtimes/nodejs/runner/package.json runtimes/nodejs/runner/tsconfig.json runtimes/nodejs/runner/
RUN pnpm install --frozen-lockfile --filter @open-agent-tools/mcp-nodejs-runner...

COPY packages/mcp-contracts/src packages/mcp-contracts/src
COPY runtimes/nodejs/runner/src runtimes/nodejs/runner/src
RUN pnpm --filter @open-agent-tools/mcp-nodejs-runner build
RUN pnpm --filter @open-agent-tools/mcp-nodejs-runner deploy --prod --legacy /opt/runner

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /opt/runner /opt/runner
RUN apk upgrade --no-cache libcrypto3 libssl3 \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
USER node
ENTRYPOINT ["node", "/opt/runner/dist/cli.js"]
