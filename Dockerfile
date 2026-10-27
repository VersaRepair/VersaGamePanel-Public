FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
ARG VCS_REF=development
LABEL org.opencontainers.image.title="VersaGamePanel private developer candidate" \
      org.opencontainers.image.version="0.2.0-dev.2" \
      org.opencontainers.image.source="https://github.com/VersaRepair/VersaGamePanel" \
      org.opencontainers.image.revision=$VCS_REF
RUN apk upgrade --no-cache && apk add --no-cache docker-cli ca-certificates zip unzip tar util-linux
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-fund && npm cache clean --force && rm -rf /usr/local/lib/node_modules/npm && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY server.js ./
COPY lib/ ./lib/
# Development previews include the dormant, local-only agent prototype.
# The production panel entrypoint is unchanged; this does not enable remote agents.
COPY agent/ ./agent/
COPY public/ ./public/
COPY runtimes/ ./runtimes/
COPY deploy/container/ ./deploy/container/
RUN sed -i 's/\r$//' deploy/container/entrypoint.sh && chmod 755 deploy/container/entrypoint.sh && chmod -R a+rX public && mkdir /data && chown node:node /data
ENV NODE_ENV=production GAMEPANEL_DATA_DIR=/data HOST=0.0.0.0 PORT=8788
VOLUME ["/data"]
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "/app/deploy/container/healthcheck.js"]
# Secure deployments default to non-root. The legacy trusted-admin Compose file
# explicitly opts into its older root-only socket/volume initialization path.
USER node
ENTRYPOINT ["/app/deploy/container/entrypoint.sh"]
