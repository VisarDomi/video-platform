# Sourced by the apps' scripts/test.sh: one compiler setup for the PC (Linux, the normal place
# to run these logic tests) and the Mac (xcrun). Sets SWIFTC, SWIFT, JOBS, DYLIB, XML_FLAGS and
# library_flags NAME (the shared-library identity flags for libNAME), and the cached builders
# kit_libraries and build_linux_shims below.
kit_linux_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ $(uname) == Darwin ]]; then
  SWIFTC=(xcrun swiftc)
  SWIFT=(xcrun swift)
  JOBS=2
  DYLIB=dylib
  library_flags() { printf '%s\n' -Xlinker -install_name -Xlinker "@rpath/lib$1.dylib"; }
  XML_FLAGS=(-lxml2)
else
  # Swift 6.2.4 from swift.org (swiftly), matching the Mac's Xcode 26.3 compiler.
  swiftc_path=$(command -v swiftc || echo "$HOME/.local/share/swiftly/bin/swiftc")
  if [[ ! -x $swiftc_path ]]; then
    echo 'No Swift toolchain on this PC: see ios-tools/native/README.md ("Logic tests on the PC").' >&2
    exit 1
  fi
  SWIFTC=("$swiftc_path")
  SWIFT=("$(dirname "$swiftc_path")/swift")
  JOBS=$(nproc)
  DYLIB=so
  library_flags() { printf '%s\n' -Xlinker -soname -Xlinker "lib$1.so"; }
  # libxml2's headers: the system's libxml2-dev, or the same package unpacked without root.
  xml_root=$HOME/.local/opt/libxml2-dev
  xml_include=/usr/include/libxml2
  [[ -d $xml_include ]] || xml_include=$xml_root/usr/include/libxml2
  XML_FLAGS=(-Xcc "-I$xml_include" -Xcc "-fmodule-map-file=$kit_linux_dir/libxml2/module.modulemap" -lxml2)
  [[ -e /usr/lib/x86_64-linux-gnu/libxml2.so ]] || XML_FLAGS+=("-L$xml_root/lib")
fi

# Compiled helper libraries are reused across runs while their sources and the compiler are
# unchanged: ~/.cache/nativekit-tests on the PC, ~/Library/Caches/nativekit-tests on the Mac.
if [[ $(uname) == Darwin ]]; then
  kit_cache=$HOME/Library/Caches/nativekit-tests
else
  kit_cache=${XDG_CACHE_HOME:-$HOME/.cache}/nativekit-tests
fi
compiler_identity=$("${SWIFTC[@]}" --version 2>&1)

# _cached NAME KEY BUILD_FUNCTION: prints the cache directory for KEY, building it once
# (into a temporary directory renamed into place, so an interrupted build is never reused).
_cached() {
  local dir="$kit_cache/$1-$2" tmp
  if [[ ! -d $dir ]]; then
    mkdir -p "$kit_cache"
    tmp=$(mktemp -d "$kit_cache/.build-XXXXXX")
    if ! "$3" "$tmp" >&2; then rm -rf "$tmp"; return 1; fi
    mv "$tmp" "$dir" 2>/dev/null || rm -rf "$tmp"   # another run may have finished first
    # Keep the 16 most recent builds.
    ls -1dt "$kit_cache"/*-* 2>/dev/null | tail -n +17 | while read -r old; do rm -rf "$old"; done
  fi
  touch "$dir"
  printf '%s\n' "$dir"
}

_digest() { { printf '%s\n' "$compiler_identity"; cat "$@"; } | shasum -a 256 | cut -c1-20; }

# kit_libraries OUT "FLAGS" MODULE...: NativeKit modules (dependency order) from ./Kit/Sources as
# shared libraries linked into OUT, e.g. kit_libraries "$test_dir" "" KitCore KitNet KitHTML.
kit_libraries() {
  local out=$1; kit_lib_flags=($2); shift 2
  kit_lib_modules=("$@")
  kit_lib_sources=$PWD/Kit/Sources
  local files=() module key dir
  for module in "$@"; do while IFS= read -r file; do files+=("$file"); done < <(find "$kit_lib_sources/$module" -name '*.swift' -type f | LC_ALL=C sort); done
  key=$( { printf '%s\n' "${kit_lib_flags[*]-}" "$@" "${files[@]#$kit_lib_sources/}"; cat "${files[@]}" "$kit_linux_dir/libxml2/module.modulemap" "$kit_linux_dir/swift-env.sh"; } | _digest /dev/stdin)
  dir=$(_cached kit "$key" _build_kit_libraries) || return 1
  ln -sf "$dir"/* "$out"/
}
_build_kit_libraries() {
  local into=$1 module built=() deps
  for module in "${kit_lib_modules[@]}"; do
    deps=(-I "$into" -L "$into")
    for previous in ${built[@]+"${built[@]}"}; do deps+=("-l$previous"); done
    [[ $module == KitHTML ]] && deps+=("${XML_FLAGS[@]}")
    "${SWIFTC[@]}" -j "$JOBS" ${kit_lib_flags[@]+"${kit_lib_flags[@]}"} -parse-as-library -emit-library -emit-module \
      -module-name "$module" "$kit_lib_sources/$module"/*.swift "${deps[@]}" \
      -emit-module-path "$into/$module.swiftmodule" -o "$into/lib$module.$DYLIB" $(library_flags "$module") || return 1
    built+=("$module")
  done
}

# build_linux_shims DIR: on Linux, links the stand-ins for the Apple modules the apps' logic
# imports (Linux/Shims: CryptoKit's SHA256, CoreGraphics' types, LinuxCompat) into DIR and sets
# SHIM_FLAGS for the test compiles. A no-op on the Mac. Use as ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"}.
SHIM_FLAGS=()
build_linux_shims() {
  [[ $(uname) == Darwin ]] && return 0
  local dir name
  dir=$(_cached shims "$(_digest $(find "$kit_linux_dir/Shims" -name '*.swift' -type f | LC_ALL=C sort))" _build_linux_shims) || return 1
  ln -sf "$dir"/* "$1"/
  for name in $(cd "$kit_linux_dir/Shims" && ls -d */ | tr -d /); do SHIM_FLAGS+=("-l$name"); done
  # Darwin's Foundation includes URLSession; on Linux it is FoundationNetworking (plus LinuxCompat).
  SHIM_FLAGS+=(-I "$1" -L "$1" -Xlinker -rpath -Xlinker "$1" -Xfrontend -import-module -Xfrontend LinuxCompat)
}
_build_linux_shims() {
  local shim name
  for shim in "$kit_linux_dir"/Shims/*/; do
    name=$(basename "$shim")
    "${SWIFTC[@]}" -j "$JOBS" -parse-as-library -emit-library -emit-module -module-name "$name" "$shim"*.swift \
      -emit-module-path "$1/$name.swiftmodule" -o "$1/lib$name.so" $(library_flags "$name") || return 1
  done
}

# compile NAME SWIFTC_ARGS...: builds the test program $test_dir/NAME. On the PC independent
# programs compile concurrently (finish_compiles waits for all of them and fails if one failed);
# on the 2-core Mac they compile one at a time, as before.
compile() {
  local name=$1; shift
  if [[ $(uname) == Darwin ]]; then "${SWIFTC[@]}" -j "$JOBS" "$@" -o "$test_dir/$name"; return; fi
  while (( $(jobs -rp | wc -l) >= (JOBS + 1) / 2 )); do wait -n || true; done
  ( "${SWIFTC[@]}" -j 2 "$@" -o "$test_dir/$name" > "$test_dir/$name.log" 2>&1 || touch "$test_dir/$name.failed" ) &
}
finish_compiles() {
  [[ $(uname) == Darwin ]] && return 0
  wait
  local failed
  for failed in "$test_dir"/*.failed; do
    [[ -e $failed ]] || continue
    cat "${failed%.failed}.log" >&2
    echo "Compiling $(basename "${failed%.failed}") failed." >&2
    return 1
  done
}
