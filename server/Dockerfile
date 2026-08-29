FROM rust:1.88-bookworm AS builder

ARG APP_VERSION=0.2.1
WORKDIR /app
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && printf 'fn main() {}\n' > src/main.rs && cargo build --release

COPY server/src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim

ARG APP_VERSION=0.2.1
LABEL org.opencontainers.image.title="Enter Server" \
      org.opencontainers.image.version="$APP_VERSION" \
      org.opencontainers.image.source="https://github.com/Astonikum/EnterMessenger"

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system enter \
    && adduser --system --ingroup enter enter \
    && mkdir -p /data \
    && chown enter:enter /data

COPY --from=builder /app/target/release/enter-server /usr/local/bin/enter-server

ENV ENTER_BIND_ADDRESS=0.0.0.0 \
    ENTER_PORT=50121 \
    ENTER_SERVER_URL=http://127.0.0.1:50121 \
    ENTER_SERVER_NAME=Enter \
    ENTER_MEDIA_MAX_MB=200 \
    ENTER_DATABASE_URL=sqlite:///data/enter.sqlite3

USER enter
WORKDIR /data
VOLUME ["/data"]
EXPOSE 50121

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD curl --fail --silent http://127.0.0.1:50121/health >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/enter-server"]
