FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS node
FROM ubuntu:noble@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip libicu74 libstdc++6 && rm -rf /var/lib/apt/lists/* && mkdir -p /home/vgp && chown 1000:1000 /home/vgp
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN curl -fL --retry 3 https://terraria.org/api/download/pc-dedicated-server/terraria-server-1458.zip -o /tmp/terraria.zip && echo 'f513a4ac9789d34af766291ae217c9cd7d9472e13782a0e2b17512f70d7a8334  /tmp/terraria.zip' | sha256sum -c - && unzip -q /tmp/terraria.zip -d /tmp/terraria && mv /tmp/terraria/1458/Linux /opt/terraria && chmod +x /opt/terraria/TerrariaServer.bin.x86_64 && rm -rf /tmp/terraria /tmp/terraria.zip && mkdir /data && chown 1000:1000 /data
COPY lib/game-profiles.js runtimes/game-runner.js /opt/vgp/
ENV HOME=/home/vgp
USER 1000:1000
WORKDIR /data
ENTRYPOINT ["node", "/opt/vgp/game-runner.js", "terraria"]
