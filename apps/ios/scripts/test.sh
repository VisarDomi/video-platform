#!/bin/bash
# The apps' native tests on the Mac: the registry, Video Vault's scrapers and list rules, and
# Tango's list rules (with NativeKit's core, network and HTML modules).
set -euo pipefail
cd "$(dirname "$0")/.."
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/video-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
xcrun swiftc -j 2 -parse-as-library Tests/RegistryTests.swift -o "$test_dir/registry-tests"
"$test_dir/registry-tests"
xcrun swiftc -j 2 -parse-as-library Bunkr/LocalLibrary.swift Tests/LocalLibraryTests.swift -o "$test_dir/local-library-tests"
"$test_dir/local-library-tests"
xcrun swiftc -j 2 -parse-as-library Bunkr/LocalLibrary.swift Tests/LocalRenameClientTests.swift -o "$test_dir/local-rename-tests"
"$test_dir/local-rename-tests"
xcrun swiftc -j 2 -parse-as-library VideoApp/ViewerPlaybackPolicy.swift Tests/ViewerPlaybackPolicyTests.swift -o "$test_dir/viewer-playback-tests"
"$test_dir/viewer-playback-tests"
xcrun swiftc -j 2 -parse-as-library VideoApp/VideoTerminalState.swift Tests/VideoTerminalStateTests.swift -o "$test_dir/terminal-tests"
"$test_dir/terminal-tests"
xcrun swiftc -j 2 -parse-as-library VideoApp/VideoFeedLayout.swift Tests/VideoFeedLayoutTests.swift -o "$test_dir/feed-layout-tests"
"$test_dir/feed-layout-tests"
for module in KitCore KitNet KitHTML; do
  deps=()
  [[ $module == KitNet ]] && deps=(-I "$test_dir" -L "$test_dir" -lKitCore)
  [[ $module == KitHTML ]] && deps=(-lxml2)
  xcrun swiftc -j 2 -parse-as-library -emit-library -emit-module -module-name $module Kit/Sources/$module/*.swift ${deps[@]+"${deps[@]}"} \
    -emit-module-path "$test_dir/$module.swiftmodule" -o "$test_dir/lib$module.dylib" -Xlinker -install_name -Xlinker @rpath/lib$module.dylib
done
xcrun swiftc -j 2 -parse-as-library -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -lKitHTML -Xlinker -rpath -Xlinker "$test_dir" \
  VideoApp/Vault.swift Tests/VaultTests.swift -o "$test_dir/vault-tests"
"$test_dir/vault-tests"
xcrun swiftc -j 2 -parse-as-library -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -Xlinker -rpath -Xlinker "$test_dir" \
  VideoApp/Tango.swift Tests/TangoTests.swift -o "$test_dir/tango-tests"
"$test_dir/tango-tests"
xcrun swiftc -j 2 -parse-as-library -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -Xlinker -rpath -Xlinker "$test_dir" \
  VideoApp/Tango.swift Tests/TangoSessionTests.swift -o "$test_dir/tango-session-tests"
"$test_dir/tango-session-tests"
xcrun swiftc -j 2 -parse-as-library -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -Xlinker -rpath -Xlinker "$test_dir" \
  VideoApp/Tango.swift VideoApp/TangoPCLogin.swift Tests/TangoPCLoginTests.swift -o "$test_dir/tango-pc-tests"
"$test_dir/tango-pc-tests"
