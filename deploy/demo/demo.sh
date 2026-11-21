#!/bin/bash
# The demo on demand: start it before you show or record the platform, stop it when you are
# done. Stopping deletes everything the demo made; so does the next boot after a power cut, so a
# demo never comes back by itself and never piles up recordings (it records about 2.7 GB an hour).
#
#   deploy/demo/demo.sh start [--hours N]   a fresh demo (the image rebuilt when the sources
#                                           changed); it stops itself after N hours (default 8)
#   deploy/demo/demo.sh stop                the pod stopped, its volume and auto-stop removed
#   deploy/demo/demo.sh status
#   deploy/demo/demo.sh install             the boot cleanup (a user unit) and `video-demo` in
#                                           ~/.local/bin
#
# A deployment's own settings come from a folder mounted read-only into the pod (default
# ~/.config/video-platform-demo, or $DEMO_CONFIG_DIR): cert.pem and key.pem, a certificate its
# phones already trust (with 127.0.0.1 and localhost among its names: the services inside the
# pod use them), and <site>-phone-key files, the keys its live apps were built with. Without the
# folder the demo makes its own certificate and keys.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
config=${DEMO_CONFIG_DIR:-$HOME/.config/video-platform-demo}
image=localhost/video-platform-demo:latest
pod=video-platform-demo
autostop=video-platform-demo-autostop

say() { printf '%s\n' "$*"; }

stop() {
    systemctl --user stop "$autostop.timer" "$autostop.service" >/dev/null 2>&1 || true
    systemctl --user reset-failed "$autostop.timer" "$autostop.service" >/dev/null 2>&1 || true
    # SIGTERM: the supervisor stops the worker first and the simulator last (60 s grace). Its
    # last lines are kept, so a stop can be checked afterwards.
    if podman pod exists "$pod" 2>/dev/null; then
        podman pod stop -t 60 "$pod" >/dev/null 2>&1 || true
        mkdir -p "$HOME/.local/state/video-platform-demo"
        podman logs --tail 40 "$pod-platform" > "$HOME/.local/state/video-platform-demo/last-stop.log" 2>&1 || true
    fi
    podman pod rm -f "$pod" >/dev/null 2>&1 || true
    podman volume rm -f "$pod" >/dev/null 2>&1 || true
}

# The image's sources: the commit and any uncommitted change outside private/ (which the build
# context leaves out).
source_label() {
    { git -C "$root" rev-parse HEAD; git -C "$root" status --porcelain -- . ':!private'; git -C "$root" diff -- . ':!private'; } \
        | sha256sum | cut -c1-16
}

build() {
    local want have
    want=$(source_label)
    have=$(podman image inspect "$image" --format '{{ index .Labels "demo.source" }}' 2>/dev/null || true)
    if [ "$want" = "$have" ]; then return; fi
    say "Building the demo image (sources $want; a few minutes)"
    (cd "$root" && nice -n 10 podman build -q --label "demo.source=$want" -t "$image" -f deploy/demo/Containerfile . >/dev/null)
}

# The pod's YAML, with the deployment's settings folder mounted when there is one.
pod_yaml() {
    local out=$1
    python3 - "$here/video-platform-demo.yaml" "$out" "$config" <<'PY'
import sys
source, target, config = sys.argv[1:]
text = open(source).read()
import os
if os.path.isdir(config):
    mount = "        - { name: state, mountPath: /demo }\n"
    assert text.count(mount) == 1, "volumeMounts layout changed"
    text = text.replace(mount, mount + "        - { name: config, mountPath: /demo-config, readOnly: true }\n")
    volumes = "  volumes:\n"
    assert text.count(volumes) == 1, "volumes layout changed"
    text = text.replace(volumes, volumes + "    - name: config\n      hostPath: { path: %s, type: Directory }\n" % config)
open(target, "w").write(text)
PY
}

start() {
    local hours=8
    while [ $# -gt 0 ]; do
        case "$1" in
            --hours) hours=$2; shift 2 ;;
            *) say "unknown option $1"; exit 2 ;;
        esac
    done
    case "$hours" in ''|*[!0-9]*) say "--hours needs a whole number"; exit 2 ;; esac
    stop
    build
    local yaml
    yaml=$(mktemp --suffix=.yaml)
    pod_yaml "$yaml"
    podman kube play --replace "$yaml" >/dev/null
    rm -f "$yaml"
    if [ "$hours" -gt 0 ]; then
        systemd-run --user --quiet --unit="$autostop" --on-active="${hours}h" \
            --description="Stop the video platform demo" "$here/demo.sh" stop
    fi
    say "Demo starting (fresh): the website https://localhost:29999, the dashboard https://localhost:28791."
    [ "$hours" -gt 0 ] && say "It stops itself in $hours h; deploy/demo/demo.sh stop ends it earlier."
    return 0
}

status() {
    if podman pod exists "$pod" 2>/dev/null; then
        podman pod ps --filter "name=^$pod\$" --format '{{.Name}}: {{.Status}} since {{.Created}}'
        systemctl --user is-active --quiet "$autostop.timer" 2>/dev/null && say "auto-stop: $(systemctl --user list-timers "$autostop.timer" --no-legend | awk '{print $1, $2, $3}')"
        local mount
        mount=$(podman volume inspect "$pod" --format '{{.Mountpoint}}' 2>/dev/null || true)
        [ -n "$mount" ] && say "data: $(podman unshare du -sh "$mount" 2>/dev/null | cut -f1)"
    else
        say "Demo is off (no pod$(podman volume exists "$pod" 2>/dev/null && echo ', but a leftover volume: deploy/demo/demo.sh stop removes it' || echo ', no data'))."
    fi
}

install() {
    mkdir -p "$HOME/.config/systemd/user" "$HOME/.local/bin"
    cat > "$HOME/.config/systemd/user/video-platform-demo-cleanup.service" <<EOF
[Unit]
Description=Remove a video platform demo left over by a power cut or a reboot
After=default.target

[Service]
Type=oneshot
ExecStart=$here/demo.sh stop

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable video-platform-demo-cleanup.service >/dev/null 2>&1
    ln -sfn "$here/demo.sh" "$HOME/.local/bin/video-demo"
    say "Installed: video-platform-demo-cleanup.service (at every boot) and ~/.local/bin/video-demo"
}

case "${1:-status}" in
    start) shift; start "$@" ;;
    stop) stop; say "Demo stopped; its data is gone." ;;
    status) status ;;
    install) install ;;
    *) sed -n '2,13p' "$0"; exit 2 ;;
esac
