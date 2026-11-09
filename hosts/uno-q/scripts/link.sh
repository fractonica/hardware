#!/bin/bash
# Builds and tests the Rust link crates inside the builder container.
#   link.sh test       protocol unit tests
#   link.sh firmware   STM32 firmware ELF  -> /work/link-target/firmware/.../qonu-fw
#   link.sh daemon     qonu-link for the board -> /work/link-target/daemon/.../qonu-link
#   link.sh mcp        qonu-mcp for the board  -> /work/link-target/mcp/.../qonu-mcp
#   link.sh dash       qonu-dash for the board -> /work/link-target/dash/.../qonu-dash
set -euo pipefail
export CARGO_HOME=/work/cargo
case "${1:-}" in
test)
	cd /src/link/proto && CARGO_TARGET_DIR=/work/link-target/proto cargo test --locked
	# Host-run tests for the board crate: link with the container's own cc.
	cd /src/link/mcp && CARGO_TARGET_DIR=/work/link-target/mcp-test cargo test --locked \
		--target aarch64-unknown-linux-gnu --config 'target.aarch64-unknown-linux-gnu.linker="cc"' ;;
firmware) cd /src/link/firmware && CARGO_TARGET_DIR=/work/link-target/firmware cargo build --release --locked ;;
daemon)
	[ -x /work/output/host/bin/aarch64-buildroot-linux-gnu-gcc ] \
		|| { echo "needs Buildroot's toolchain: run make build first" >&2; exit 1; }
	cd /src/link/daemon && CARGO_TARGET_DIR=/work/link-target/daemon cargo build --release --locked ;;
mcp)
	[ -x /work/output/host/bin/aarch64-buildroot-linux-gnu-gcc ] \
		|| { echo "needs Buildroot's toolchain: run make build first" >&2; exit 1; }
	cd /src/link/mcp && CARGO_TARGET_DIR=/work/link-target/mcp cargo build --release --locked ;;
dash)
	[ -x /work/output/host/bin/aarch64-buildroot-linux-gnu-gcc ] \
		|| { echo "needs Buildroot's toolchain: run make build first" >&2; exit 1; }
	cd /src/link/dash && CARGO_TARGET_DIR=/work/link-target/dash cargo build --release --locked ;;
*) echo "usage: $0 test|firmware|daemon|mcp|dash" >&2; exit 2 ;;
esac
