#!/bin/bash
# The apps' native tests on the Mac: the registry, Video Vault's scrapers and list rules, and
# Tango's list rules (with NativeKit's core, network and HTML modules).
set -euo pipefail
cd "$(dirname "$0")/.."
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/video-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
xcrun swiftc -parse-as-library Tests/RegistryTests.swift -o "$test_dir/registry-tests"
"$test_dir/registry-tests"
for module in KitCore KitNet KitHTML; do
  deps=()
  [[ $module == KitNet ]] && deps=(-I "$test_dir" -L "$test_dir" -lKitCore)
  [[ $module == KitHTML ]] && deps=(-lxml2)
  xcrun swiftc -parse-as-library -emit-library -emit-module -module-name $module Kit/Sources/$module/*.swift ${deps[@]+"${deps[@]}"} \
    -emit-module-path "$test_dir/$module.swiftmodule" -o "$test_dir/lib$module.dylib" -Xlinker -install_name -Xlinker @rpath/lib$module.dylib
done
xcrun swiftc -parse-as-library -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -lKitHTML -Xlinker -rpath -Xlinker "$test_dir" \
  VideoApp/Vault.swift Tests/VaultTests.swift -o "$test_dir/vault-tests"
"$test_dir/vault-tests"
xcrun swiftc -parse-as-library -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -Xlinker -rpath -Xlinker "$test_dir" \
  VideoApp/Tango.swift Tests/TangoTests.swift -o "$test_dir/tango-tests"
"$test_dir/tango-tests"
