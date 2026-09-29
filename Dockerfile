# ---------------------------------------------------------------------------
# E-Voting Kiosk — production image
#
# Pure-JS dependencies (express, mysql2, bcryptjs, socket.io, multer, ...) so
# no build toolchain is required. The native USB card-reader library
# (@pokusew/pcsclite) is an OPTIONAL dependency and is intentionally skipped:
# containers can't reach a USB PC/SC reader, and the app runs fine without it
# (use DEMO_MODE=1 to simulate a card). For real card readers, deploy on bare
# metal with install.sh instead.
# ---------------------------------------------------------------------------
FROM node:20-alpine

# wget (in busybox) is used by the compose healthcheck.
# tzdata gives Alpine the zoneinfo database so TZ=Asia/Bangkok resolves
# (without it the container silently falls back to UTC).
RUN apk add --no-cache tzdata

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# App source
COPY . .

# Uploaded candidate photos and database backups live here; declared as
# volumes so they persist across redeploys
RUN mkdir -p public/img/uploads backups
VOLUME ["/app/public/img/uploads", "/app/backups"]

ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Asia/Bangkok

EXPOSE 3000

# Run as the built-in non-root "node" user
RUN chown -R node:node /app
USER node

CMD ["node", "server.js"]
