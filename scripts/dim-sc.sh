#!/usr/bin/env bash

set -uo pipefail

edited_root="${SC_EDITED_ROOT:-/home/visar/Videos/downloads/sc/downloaded}"

usage() {
    printf 'Usage: %s "STREAMER_ID"\n' "$(basename "$0")" >&2
    printf 'Example: %s "AI_channel"\n' "$(basename "$0")" >&2
}

if [[ $# -ne 1 || -z $1 ]]; then
    usage
    exit 2
fi

streamer_id=$1
rows=()
failed=0

for recording_dir in "$edited_root"/*; do
    [[ -d $recording_dir ]] || continue

    recording_id=${recording_dir##*/}
    [[ ${recording_id:18} == "$streamer_id" ]] || continue

    playlist="$recording_dir/playlist.m3u8"
    if [[ ! -f $playlist ]]; then
        rows+=("$recording_id"$'\t''—'$'\t''—'$'\t''playlist missing')
        failed=1
        continue
    fi

    random_pair=$(
        awk '
            /^#EXT-X-MAP:/ {
                map = $0
                sub(/^.*URI="/, "", map)
                sub(/".*$/, "", map)
            }
            /^[^#]/ && NF && map != "" {
                printf "%s\t%s\n", map, $0
            }
        ' "$playlist" | shuf -n 1
    )

    if [[ -z $random_pair ]]; then
        rows+=("$recording_id"$'\t''—'$'\t''—'$'\t''no fMP4 fragments')
        failed=1
        continue
    fi

    IFS=$'\t' read -r init_segment media_fragment <<< "$random_pair"
    init_path="$recording_dir/$init_segment"
    fragment_path="$recording_dir/$media_fragment"

    if [[ ! -f $init_path || ! -f $fragment_path ]]; then
        rows+=("$recording_id"$'\t'"$media_fragment"$'\t'"$init_segment"$'\t''selected file missing')
        failed=1
        continue
    fi

    if dimensions=$(ffprobe -v error \
        -read_intervals '%+#1' \
        -select_streams v:0 \
        -show_frames \
        -show_entries frame=width,height \
        -of csv=p=0:s=x \
        "concat:$init_path|$fragment_path"); then
        dimensions=${dimensions%%$'\n'*}
        rows+=("$recording_id"$'\t'"$media_fragment"$'\t'"$init_segment"$'\t'"$dimensions")
    else
        rows+=("$recording_id"$'\t'"$media_fragment"$'\t'"$init_segment"$'\t''probe failed')
        failed=1
    fi
done

if [[ ${#rows[@]} -eq 0 ]]; then
    printf 'No SC edited recordings found for streamer: %s\n' "$streamer_id" >&2
    exit 1
fi

{
    printf 'VIDEO\tRANDOM FRAGMENT\tINIT MAP\tDIMENSIONS\n'
    printf '%s\n' "${rows[@]}"
} | column -t -s $'\t'

exit "$failed"
