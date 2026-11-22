#!/bin/bash
# The engine's logic tests (on the PC with Swift for Linux; the Mac works too): playback and seek
# state, the feed's geometry, the playback policy, where a variant change continues, the
# recordings library, the PC's two addresses; then the provider pattern and the registry tooling.
# A deployment's own tests run these too (its registry's scripts/test.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=../Kit/Linux/swift-env.sh
source Kit/Linux/swift-env.sh
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/engine-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
build_linux_shims "$test_dir"
shims=(${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"})
compile state-machine-tests "${shims[@]}" -parse-as-library App/VideoPlaybackState.swift App/ChasingSeek.swift App/ViewerInteractionState.swift Tests/StateMachineTests.swift
compile feed-layout-tests "${shims[@]}" -parse-as-library App/VideoFeedLayout.swift Tests/VideoFeedLayoutTests.swift
compile viewer-playback-tests "${shims[@]}" -parse-as-library App/ViewerPlaybackPolicy.swift Tests/ViewerPlaybackPolicyTests.swift
compile variant-position-tests "${shims[@]}" -parse-as-library App/VariantPosition.swift Tests/VariantPositionTests.swift
compile recording-library-tests "${shims[@]}" -parse-as-library App/ProviderTraits.swift App/LocalLibrary.swift Tests/RecordingLibraryTests.swift
compile pc-reach-tests "${shims[@]}" -parse-as-library App/PCReach.swift Tests/PCReachTests.swift
finish_compiles
for name in state-machine-tests feed-layout-tests viewer-playback-tests variant-position-tests recording-library-tests pc-reach-tests; do
  "$test_dir/$name"
done
if ! PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s Tests -p 'test_*.py' > "$test_dir/python.log" 2>&1; then
  cat "$test_dir/python.log"; exit 1
fi
echo "PASS: the engine names no provider; registries generate, declare and build from it (Tests/test_*.py)"
