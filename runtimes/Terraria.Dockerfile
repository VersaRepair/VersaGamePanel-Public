FROM node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip libicu76 libstdc++6 && rm -rf /var/lib/apt/lists/*
RUN curl -fL --retry 3 https://terraria.org/api/download/pc-dedicated-server/terraria-server-1458.zip -o /tmp/terraria.zip && echo 'f513a4ac9789d34af766291ae217c9cd7d9472e13782a0e2b17512f70d7a8334  /tmp/terraria.zip' | sha256sum -c - && unzip -q /tmp/terraria.zip -d /tmp/terraria && mv /tmp/terraria/1458/Linux /opt/terraria && chmod +x /opt/terraria/TerrariaServer.bin.x86_64 && rm -rf /tmp/terraria /tmp/terraria.zip && mkdir /data && chown node:node /data
COPY lib/game-profiles.js runtimes/game-runner.js /opt/vgp/
USER node
WORKDIR /data
ENTRYPOINT ["node", "/opt/vgp/game-runner.js", "terraria"]
