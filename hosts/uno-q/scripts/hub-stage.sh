#!/bin/bash
# Stages the Fractonica hub for the board, inside the builder container (arm64, like the board):
# the checkout's runtime parts (from /fr, read-only) plus production node_modules for linux-arm64
# (better-sqlite3 and serialport as prebuilt binaries), into /work/hub-stage. `make hub-push`
# then copies it to /data/fractonica/hub on the board, which survives image reflashes.
#
# The hub runs from TypeScript sources with Node's type stripping, as on the Mac (spec 08 §8.12
# "Now"); the workspace packages resolve through the @fractonica/source condition.
set -euo pipefail
NODE_VERSION=24.22.0
PNPM_VERSION=11.15.1
NODE_DIR=/work/node-$NODE_VERSION
STAGE=/work/hub-stage
FR=/fr

[ -f "$FR/packages/hub/src/main.ts" ] || { echo "hub-stage: no Fractonica checkout at $FR" >&2; exit 1; }

if [ ! -x "$NODE_DIR/bin/node" ]; then
	tarball=/work/dl/node-official/node-v$NODE_VERSION-linux-arm64.tar.xz
	[ -f "$tarball" ] || { echo "hub-stage: $tarball missing: run make build first (package node-official)" >&2; exit 1; }
	mkdir -p "$NODE_DIR"
	tar -xJf "$tarball" -C "$NODE_DIR" --strip-components=1
fi
export PATH="$NODE_DIR/bin:$PATH"
export COREPACK_HOME=/work/corepack
corepack enable --install-directory "$NODE_DIR/bin" pnpm >/dev/null
corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null

rm -rf "$STAGE"
mkdir -p "$STAGE/firmware"
cd "$FR"
# What the hub reads at run time: its packages, the web apps' builds, the hardware library and the
# profiles (boards, wiring guides, parts), the schema; plus the workspace files pnpm needs.
tar -cf - --exclude=node_modules --exclude='*.tsbuildinfo' --exclude=test --exclude='web/*/src' \
	package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json \
	packages web hardware schema firmware/profiles firmware/idf-version.lock \
	| tar -xf - -C "$STAGE"
cd "$STAGE"
pnpm install --prod --frozen-lockfile --config.store-dir=/work/pnpm-store \
	--filter "@fractonica/hub..." --filter "@fractonica/cli..." --filter "@fractonica/sdk" \
	--reporter=append-only 2>&1 | grep -vE "^Progress|^\s*$" | tail -15
node -e "require('better-sqlite3'); console.log('better-sqlite3: ok')" 2>/dev/null \
	|| (cd packages/hub && node -e "require('better-sqlite3'); console.log('better-sqlite3: ok (hub)')")
echo "== staged: $(du -sh "$STAGE" | cut -f1) ($(du -sh "$STAGE/node_modules" | cut -f1) node_modules)"
