# syntax=docker/dockerfile:1

# Build Stage: Abhängigkeiten installieren und Tailwind CSS erzeugen.
# Das volle node Image enthält python3, make und g++, die node-gyp für better-sqlite3
# braucht (Konfiguration bzw. Kompilierung auf Plattformen ohne mitgeliefertes Binary).
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend ./frontend
COPY public ./public
RUN npm run build:css && npm prune --omit=dev

# Runtime Stage: nur Laufzeitdateien, keine Build Werkzeuge
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    TZ=Europe/Berlin
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY package.json ./
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/data \
 && chown node:node /app/data

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
