# syntax=docker/dockerfile:1
# Build context is the repo root (see docker-compose.yml).

FROM rust:1.79-slim AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential pkg-config ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY node-agent/Cargo.toml ./Cargo.toml
COPY node-agent/src ./src
RUN cargo build --release

# Source the docker CLI (the executor drives the host Docker daemon via the
# mounted socket). Production targets containerd/rootless via the Executor trait.
FROM docker:27-cli AS dockercli

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /src/target/release/asterpanel-agent /usr/local/bin/asterpanel-agent
EXPOSE 7443
ENTRYPOINT ["/usr/local/bin/asterpanel-agent"]
