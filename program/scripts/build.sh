#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
rm -f target/deploy/ruin.so
NO_DNA=1 anchor build --ignore-keys
mkdir -p target/mainnet target/devnet
cp target/deploy/ruin.so target/mainnet/ruin.so
cp target/idl/ruin.json target/mainnet/ruin.json
NO_DNA=1 npm run generate
if [ -f target/deploy/ruin-keypair.json ]; then cp target/deploy/ruin-keypair.json target/devnet/ruin-keypair.json; fi
rm -f target/devnet/ruin.so
NO_DNA=1 anchor build --ignore-keys --no-idl -- --features devnet --sbf-out-dir "$(pwd)/target/devnet"
cp target/mainnet/ruin.so target/deploy/ruin.so
cp target/mainnet/ruin.json target/idl/ruin.json
