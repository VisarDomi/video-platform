// swift-tools-version: 5.9
import PackageDescription

// Official VideoLAN binary, pinned and verified by scripts/prepare-vlckit.py.
// Only iOS slices are staged; the shared viewer in other apps has no VLC dependency.
let package = Package(name: "OriginalVideoDecoder", platforms: [.iOS(.v12)],
    products: [.library(name: "VLCKit", targets: ["VLCKit"])],
    targets: [.binaryTarget(name: "VLCKit", path: "VLCKit.xcframework")])
