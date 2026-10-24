FROM node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bsdutils lib32gcc-s1 lib32stdc++6 libstdc++6 libglu1-mesa libxcursor1 libxrandr2 libxi6 && rm -rf /var/lib/apt/lists/*
# Valve's HTTPS installer bootstraps and updates SteamCMD at first build.
# No Steam credentials, game saves or installed game binaries are in this image.
RUN mkdir -p /opt/steamcmd /data && curl -fL --retry 3 https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz -o /tmp/steamcmd.tgz && tar -xzf /tmp/steamcmd.tgz -C /opt/steamcmd && rm /tmp/steamcmd.tgz && chown -R node:node /opt/steamcmd /data
USER node
RUN /opt/steamcmd/steamcmd.sh +quit && chmod -R a+rX /opt/steamcmd
COPY lib/game-profiles.js runtimes/game-runner.js /opt/vgp/
WORKDIR /data
ENTRYPOINT ["node", "/opt/vgp/game-runner.js", "unturned"]
