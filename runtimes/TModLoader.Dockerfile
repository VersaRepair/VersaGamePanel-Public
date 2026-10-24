FROM mcr.microsoft.com/dotnet/runtime:8.0-bookworm-slim@sha256:1b2f288e3a87cd251322f304e176327b6c00ec3bc1847f38b69a58cb7251e994 AS dotnet
FROM node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
COPY --from=dotnet /usr/share/dotnet /usr/share/dotnet
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip libicu76 libgssapi-krb5-2 libssl3t64 zlib1g libstdc++6 libatomic1 libfreetype6 libfontconfig1 libopenal1 && rm -rf /var/lib/apt/lists/*
RUN curl -fL --retry 3 https://github.com/tModLoader/tModLoader/releases/download/v2026.08.3.0/tModLoader.zip -o /tmp/tml.zip && echo '61e865f3702b12ce4a26c5a90b9de99a12c65ffc228455eb3390ce54af1eab15  /tmp/tml.zip' | sha256sum -c - && unzip -q /tmp/tml.zip -d /opt/tmodloader && rm /tmp/tml.zip && ln -s /opt/tmodloader/Libraries/Native/Linux/libSDL2-2.0.so.0 /opt/tmodloader/Libraries/Native/Linux/libSDL2.so && mkdir /data && chown -R node:node /data /opt/tmodloader
RUN ln -s /data/tmodloader/Logs /opt/tmodloader/tModLoader-Logs
ENV DOTNET_ROOT=/usr/share/dotnet DOTNET_EnableDiagnostics=0 DOTNET_CLI_TELEMETRY_OPTOUT=1 LD_LIBRARY_PATH=/opt/tmodloader/Libraries/Native/Linux
COPY lib/game-profiles.js runtimes/game-runner.js /opt/vgp/
USER node
WORKDIR /data
ENTRYPOINT ["node", "/opt/vgp/game-runner.js", "tmodloader"]
