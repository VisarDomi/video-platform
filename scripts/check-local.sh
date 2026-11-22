#!/usr/bin/env bash
# Every check this repository has, in a clone of it: install, build, each package's unit and
# contract tests, the simulated sites' plug-ins, the iPhone engine's logic tests, and the
# end-to-end runs against the simulator.
# A machine's own CI runs it on each new commit (the owner's PC: environment services/local-ci).
#   bash scripts/check-local.sh            everything (about 15 minutes on two CPUs)
#   bash scripts/check-local.sh --quick    without the end-to-end runs
set -euo pipefail
cd "$(dirname "$0")/.."
quick=${1:-}
step() { printf '\n== %s\n' "$*"; }

step install
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
step build
npm run build:backend
npm run build -w simulator
npm run build:sim-plugins
for workspace in sdk shared auth downloader server descriptor pipeline simulator; do
    step "tests: $workspace"
    npm test -w "$workspace"
done
step "tests: simulated sites' plug-ins"
npm run test:sim-plugins
step "tests: the website's providers"
npm run test:app:pages
step "tests: the iPhone engine (Swift for Linux)"
if command -v swiftc >/dev/null || [ -x "$HOME/.local/share/swiftly/bin/swiftc" ] || [ "$(uname)" = Darwin ]; then
    bash apps/ios/scripts/test.sh
else
    echo "skipped: no Swift toolchain (apps/ios/README.md, Tests)"
fi
if [ "$quick" != --quick ]; then
    step "end to end: capture"
    npm run e2e:capture
    step "end to end: pipeline (form host)"
    npm run e2e:pipeline
    step "end to end: pipeline (API host)"
    npm run e2e:pipeline -- --destination api-host
    step "end to end: file host"
    npm run e2e:file-host
fi
step passed
