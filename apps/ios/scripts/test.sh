#!/bin/bash
# The apps' native tests (on the PC; the Mac works too): the registry, Video Vault's scrapers and list rules, and
# Tango's list rules (with NativeKit's core, network and HTML modules).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=../Kit/Linux/swift-env.sh
source Kit/Linux/swift-env.sh
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/video-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
build_linux_shims "$test_dir"
kit_libraries "$test_dir" "" KitCore KitNet KitHTML
# Every program compiles first (concurrently on the PC), then they run in order.
compile registry-tests ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -parse-as-library Tests/RegistryTests.swift
compile local-library-tests ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -parse-as-library Bunkr/LocalLibrary.swift Tests/LocalLibraryTests.swift
compile local-rename-tests ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -parse-as-library Bunkr/LocalLibrary.swift Tests/LocalRenameClientTests.swift
compile viewer-playback-tests ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -parse-as-library VideoApp/ViewerPlaybackPolicy.swift Tests/ViewerPlaybackPolicyTests.swift
compile state-machine-tests ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -parse-as-library VideoApp/VideoPlaybackState.swift VideoApp/DecoderLifecycle.swift VideoApp/ChasingSeek.swift VideoApp/ViewerInteractionState.swift Tests/StateMachineTests.swift
compile terminal-tests ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -parse-as-library VideoApp/VideoTerminalState.swift Tests/VideoTerminalStateTests.swift
compile feed-layout-tests ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -parse-as-library VideoApp/VideoFeedLayout.swift Tests/VideoFeedLayoutTests.swift
compile keyframe-landing-tests ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -parse-as-library ThirdParty/AetherCore/Sources/AetherEngine/Native/InlineKeyframeLanding.swift Tests/InlineKeyframeLandingTests.swift
compile vault-tests ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -parse-as-library -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -lKitHTML "${XML_FLAGS[@]}" -Xlinker -rpath -Xlinker "$test_dir" VideoApp/Vault.swift Tests/VaultTests.swift
compile tango-tests ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -parse-as-library -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -Xlinker -rpath -Xlinker "$test_dir" VideoApp/Tango.swift Tests/TangoTests.swift
compile tango-session-tests ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -parse-as-library -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -Xlinker -rpath -Xlinker "$test_dir" VideoApp/Tango.swift Tests/TangoSessionTests.swift
compile pc-reach-tests ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -parse-as-library VideoApp/PCReach.swift Tests/PCReachTests.swift
compile tango-pc-tests ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -parse-as-library -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -Xlinker -rpath -Xlinker "$test_dir" VideoApp/Tango.swift VideoApp/TangoPCLogin.swift Tests/TangoPCLoginTests.swift
finish_compiles
"$test_dir/registry-tests"
"$test_dir/local-library-tests"
"$test_dir/local-rename-tests"
"$test_dir/viewer-playback-tests"
"$test_dir/state-machine-tests"
"$test_dir/terminal-tests"
"$test_dir/feed-layout-tests"
"$test_dir/keyframe-landing-tests"
"$test_dir/vault-tests"
"$test_dir/tango-tests"
"$test_dir/tango-session-tests"
"$test_dir/tango-pc-tests"
"$test_dir/pc-reach-tests"
# The build and delivery scripts' own checks: dependency staging after a power cut, the FFmpeg ABI
# binding check, provider isolation, private inputs, probe variants and delivery validation.
if ! PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s Tests -p 'test_*.py' > "$test_dir/python.log" 2>&1; then
  cat "$test_dir/python.log"; exit 1
fi
echo "PASS: build and delivery script checks (Tests/test_*.py)"
