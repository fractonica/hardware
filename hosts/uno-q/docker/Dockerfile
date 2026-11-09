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
