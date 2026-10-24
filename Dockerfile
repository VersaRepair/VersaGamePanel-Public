FROM node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
ARG VCS_REF=development
LABEL org.opencontainers.image.title="VersaGamePanel tester alpha" \
      org.opencontainers.image.source="https://github.com/VersaRepair/VersaGamePanel-Public" \
      org.opencontainers.image.revision=$VCS_REF
RUN apt-get update && apt-get install -y --no-install-recommends docker-cli ca-certificates zip unzip tar util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-fund && npm cache clean --force && rm -rf /usr/local/lib/node_modules/npm && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY runtimes/ ./runtimes/
COPY deploy/container/ ./deploy/container/
RUN chmod 755 deploy/container/entrypoint.sh && mkdir /data && chown node:node /data
ENV NODE_ENV=production GAMEPANEL_DATA_DIR=/data HOST=0.0.0.0 PORT=8788
VOLUME ["/data"]
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "/app/deploy/container/healthcheck.js"]
# Root is used only for socket-group setup; the entrypoint drops UID/GID/capabilities.
ENTRYPOINT ["/app/deploy/container/entrypoint.sh"]
