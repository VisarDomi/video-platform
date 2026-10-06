#!/bin/bash
# Evaluate one of these scripts in the Tango app on the iPhone (cabled to the Mac,
# unlocked, Tango in the foreground) through ios-tools' WebKit inspector on the Mac.
# The inspector does not await promises: the *-test.js scripts start the check and
# return; run state.js afterwards until its "result.done" is true.
#   apps/tango/scripts/phone/run.sh state.js
set -euo pipefail
script=$(cd "$(dirname "$0")" && pwd)/${1:?usage: run.sh <script.js>}
OPTIONS=(-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes
         -o UserKnownHostsFile=/home/visar/Documents/hackingtosh/validation/macos-known-hosts)
MAC=visar@192.168.1.198
scp -q "${OPTIONS[@]}" "$script" "$MAC:/tmp/tango-phone-check.js"
ssh "${OPTIONS[@]}" "$MAC" '~/Developer/ios-tools/inspector/.venv/bin/python ~/Developer/ios-tools/inspector/app-inspector.py \
    --bundle com.visar.Tango.paid --url-prefix https://tango.me/ --evaluate-file /tmp/tango-phone-check.js 2>/dev/null' \
    | grep '^RESULT' | sed 's/^RESULT //'
