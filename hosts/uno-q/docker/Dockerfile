# Build environment for the qonu Buildroot distro.
# Native arm64 on Apple Silicon; builds a cross toolchain for the Cortex-A53 target.
FROM debian:trixie-slim

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      bc bison build-essential bzip2 ca-certificates cpio file flex g++ gcc \
      git gzip libelf-dev libncurses-dev libssl-dev locales make patch perl \
      python3 python3-dev python3-setuptools rsync sed tar unzip wget which \
      xz-utils zstd ccache openssh-client \
    && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Buildroot should not run as root.
RUN useradd -m -u 1000 builder && mkdir -p /work && chown builder:builder /work
USER builder
WORKDIR /work

# Rust for the qonu link: STM32U585 firmware (thumbv8m.main-none-eabihf) and the
# board-side daemon (aarch64 Linux, linked with Buildroot's toolchain and glibc).
ARG RUST_VERSION=1.99.1
ENV RUSTUP_HOME=/home/builder/.rustup PATH=/home/builder/.cargo/bin:$PATH
RUN cd /tmp \
    && wget -q https://static.rust-lang.org/rustup/dist/aarch64-unknown-linux-gnu/rustup-init \
            https://static.rust-lang.org/rustup/dist/aarch64-unknown-linux-gnu/rustup-init.sha256 \
    && echo "$(cut -d' ' -f1 rustup-init.sha256)  rustup-init" | sha256sum -c - \
    && chmod +x rustup-init \
    && ./rustup-init -y --no-modify-path --profile minimal \
         --default-toolchain "$RUST_VERSION" --target thumbv8m.main-none-eabihf \
         --component llvm-tools \
    && rm rustup-init rustup-init.sha256 \
    && rustc --version
