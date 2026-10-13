// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OhMyUsage",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "OhMyUsage"),
        .testTarget(name: "OhMyUsageTests", dependencies: ["OhMyUsage"]),
    ]
)
