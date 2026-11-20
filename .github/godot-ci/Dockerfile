# Runtime dependencies only. The official editor executable is fetched and
# SHA-256 verified by GitHub Actions before building this local CI image.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libx11-6 libxcursor1 libxinerama1 libxi6 \
    libxrandr2 libxrender1 libasound2t64 libfontconfig1 libfreetype6 \
    libgl1 libvulkan1 libpulse0 libudev1 \
    && rm -rf /var/lib/apt/lists/*
COPY godot /usr/local/bin/godot
RUN chmod 0755 /usr/local/bin/godot
