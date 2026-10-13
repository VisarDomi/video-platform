// swift-tools-version: 6.2
import PackageDescription

// NativeKit: what the native apps share (ios-tools/native/README.md).
// Canonical here; each app repository vendors a copy as apps/ios/Kit
// (native/scripts/vendor-kit.py). KitCore, KitNet, KitHTML and KitLifecycle's transfers
// build on macOS too, so their tests run with `swift test` on the Mac; the UI modules
// compile to nothing outside iOS.
let package = Package(
    name: "NativeKit",
    platforms: [.iOS(.v26), .macOS(.v15)],
    products: [
        .library(name: "KitCore", targets: ["KitCore"]),
        .library(name: "KitNet", targets: ["KitNet"]),
        .library(name: "KitHTML", targets: ["KitHTML"]),
        .library(name: "KitImages", targets: ["KitImages"]),
        .library(name: "KitNavigation", targets: ["KitNavigation"]),
        .library(name: "KitLists", targets: ["KitLists"]),
        .library(name: "KitReader", targets: ["KitReader"]),
        .library(name: "KitLifecycle", targets: ["KitLifecycle"]),
        .library(name: "KitTestHooks", targets: ["KitTestHooks"]),
        .library(name: "KitMigration", targets: ["KitMigration"]),
        .library(name: "KitBackup", targets: ["KitBackup"]),
    ],
    targets: [
        .target(name: "KitCore"),
        .target(name: "KitNet", dependencies: ["KitCore"]),
        .target(name: "KitHTML"),
        .target(name: "KitImages", dependencies: ["KitCore"]),
        .target(name: "KitNavigation", dependencies: ["KitCore"]),
        .target(name: "KitLists", dependencies: ["KitCore", "KitImages"]),
        .target(name: "KitReader", dependencies: ["KitCore", "KitImages"]),
        .target(name: "KitLifecycle", dependencies: ["KitCore", "KitNet"]),
        // Simulator builds only: drives the app from the Mac (see TestHooks.swift).
        .target(name: "KitTestHooks", dependencies: ["KitCore"]),
        // Once per app: data the web version kept in WebKit's storage (WebStorageReader.swift).
        .target(name: "KitMigration", dependencies: ["KitCore"]),
        // The PC backups of the apps' own data (PCBackup.swift).
        .target(name: "KitBackup", dependencies: ["KitCore", "KitNet"]),
        .testTarget(name: "KitCoreTests", dependencies: ["KitCore"]),
        .testTarget(name: "KitNetTests", dependencies: ["KitNet"]),
        .testTarget(name: "KitHTMLTests", dependencies: ["KitHTML"]),
    ]
)
