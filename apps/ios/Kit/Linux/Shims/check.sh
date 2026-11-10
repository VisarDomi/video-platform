#!/bin/bash
# Checks the Linux stand-ins against known answers (FIPS 180-4 SHA-256 test vectors). PC only.
set -euo pipefail
cd "$(dirname "$0")/../.."
source Linux/swift-env.sh
dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT
build_linux_shims "$dir"
cat > "$dir/main.swift" <<'SWIFT'
import CryptoKit
import CoreGraphics
func hex(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
let vectors = [
    "": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "abc": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq": "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    String(repeating: "a", count: 1_000_000): "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
]
for (input, expected) in vectors where hex(input) != expected { fatalError("SHA256 mismatch for \(input.prefix(20))") }
let size = CGSize(width: 2, height: 3); precondition(size.width * size.height == 6)
print("PASS: Linux stand-ins (SHA-256 vectors, CoreGraphics types)")
SWIFT
"${SWIFTC[@]}" -O "${SHIM_FLAGS[@]}" "$dir/main.swift" -o "$dir/check"
"$dir/check"
