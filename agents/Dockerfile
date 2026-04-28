# syntax=docker/dockerfile:1.7

# ─── build ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Install deps first so layer cache survives source-only edits.
COPY package.json ./
# The 0G Storage SDK pins ethers exactly; relax that for our app surface.
RUN npm install --legacy-peer-deps --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# ─── runtime ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Non-root for safety.
RUN addgroup -S agent && adduser -S agent -G agent

ENV NODE_ENV=production \
    LOG_LEVEL=info

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

USER agent
ENTRYPOINT ["node", "--enable-source-maps", "dist/agent.js"]
