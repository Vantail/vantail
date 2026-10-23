FROM rust:1-bookworm

# The same libraries the CI workflow installs, plus the virtual desktop its
# Linux integration step uses: Xvfb so a window can be opened without a
# display attached, openbox to manage it, and GNOME Keyring for secrets.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
      librsvg2-dev libudev-dev libxdo-dev \
      xvfb xauth dbus dbus-x11 openbox gnome-keyring curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Debian ships Node 18; the workspace needs 22.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g pnpm@10 \
    && rm -rf /var/lib/apt/lists/*

RUN rustup component add clippy rustfmt
WORKDIR /work
