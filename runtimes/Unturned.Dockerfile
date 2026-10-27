FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS node
FROM ubuntu:noble@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bsdutils lib32gcc-s1 lib32stdc++6 libstdc++6 libglu1-mesa libxcursor1 libxrandr2 libxi6 && rm -rf /var/lib/apt/lists/* && mkdir -p /home/vgp && chown 1000:1000 /home/vgp
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# Valve's HTTPS installer bootstraps and updates SteamCMD at first build.
# No Steam credentials, game saves or installed game binaries are in this image.
RUN mkdir -p /opt/steamcmd /data && curl -fL --retry 3 https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz -o /tmp/steamcmd.tgz && tar -xzf /tmp/steamcmd.tgz -C /opt/steamcmd && rm /tmp/steamcmd.tgz && chown -R 1000:1000 /opt/steamcmd /data
ENV HOME=/home/vgp
USER 1000:1000
RUN /opt/steamcmd/steamcmd.sh +quit && chmod -R a+rX /opt/steamcmd
COPY lib/game-profiles.js runtimes/game-runner.js /opt/vgp/
WORKDIR /data
ENTRYPOINT ["node", "/opt/vgp/game-runner.js", "unturned"]
