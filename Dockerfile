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

# wget (in busybox) is used by the compose healthcheck
WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# App source
COPY . .

# Uploaded candidate photos live here; declared as a volume so they persist
RUN mkdir -p public/img/uploads
VOLUME ["/app/public/img/uploads"]

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# Run as the built-in non-root "node" user
RUN chown -R node:node /app
USER node

CMD ["node", "server.js"]
