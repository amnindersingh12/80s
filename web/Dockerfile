# syntax=docker/dockerfile:1
# 80s web player: API server + built web UI in one image.
#   docker build -t 80s-web .            (context = web/)
#   docker run --env-file .env -p 8787:8787 80s-web

# ---- build: install everything, compile client (Vite) + server (tsc) ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY shared shared
COPY server server
COPY client client
RUN npm run build

# ---- runtime: production deps for the server only, no sources/toolchain ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev -w server --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
USER node
EXPOSE 8787
# /api/health is never behind APP_ACCESS_KEY, so this works with the gate on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
