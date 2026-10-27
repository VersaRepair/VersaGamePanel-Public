FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS node
FROM ubuntu:noble@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
ARG VCS_REF=development
LABEL org.opencontainers.image.title="VersaGamePanel private Minecraft Java runtime" org.opencontainers.image.version="0.2.0-dev.2" org.opencontainers.image.revision=$VCS_REF
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openjdk-21-jre-headless && rm -f /etc/ssl/certs/java/cacerts && update-ca-certificates --fresh && rm -rf /var/lib/apt/lists/* && mkdir -p /data /home/vgp && chown -R 1000:1000 /data /home/vgp
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY runtimes/minecraft-java.js /opt/vgp/minecraft-java.js
ENV HOME=/home/vgp
USER 1000:1000
WORKDIR /data
ENTRYPOINT []
CMD ["node", "/opt/vgp/minecraft-java.js"]
