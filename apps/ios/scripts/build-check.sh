#!/bin/bash
# Compiles one app for the simulator, unsigned, to check the sources (on the Mac, through
# its workload guard): scripts/build-check.sh live-a-local
set -euo pipefail
cd "$(dirname "$0")/.."
SIMULATOR=1 python3 scripts/project.py "$1"
xcodebuild -project build/app/VideoApp.xcodeproj -scheme VideoApp -derivedDataPath build/DerivedData \
    -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    ARCHS=x86_64 ONLY_ACTIVE_ARCH=YES -jobs 2 'OTHER_SWIFT_FLAGS=$(inherited) -j2 -num-threads 2' \
    CODE_SIGNING_ALLOWED=NO build -quiet
