FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS builder
RUN apk add --no-cache gcompat
WORKDIR /app

# pnpm-workspace.yaml carries the allowBuilds approvals; without it the install
# below fails exactly the way CI did.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsup.config.ts ./
COPY src ./src
COPY drizzle ./drizzle

RUN pnpm install --frozen-lockfile && \
    pnpm run build && \
    pnpm prune --prod

FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 ragenta

COPY --from=builder --chown=ragenta:nodejs /app/node_modules /app/node_modules
COPY --from=builder --chown=ragenta:nodejs /app/dist /app/dist
COPY --from=builder --chown=ragenta:nodejs /app/package.json /app/package.json
# SQL migrations, applied by `node dist/db/migrate.js` as an explicit deploy step.
COPY --from=builder --chown=ragenta:nodejs /app/drizzle /app/drizzle

USER ragenta
EXPOSE 8080

# One image, two processes. Compose overrides this for the worker service:
#   command: ["node", "/app/dist/main.worker.js"]
CMD ["node", "/app/dist/main.api.js"]
