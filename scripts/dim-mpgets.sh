#!/usr/bin/env bash

set -uo pipefail

provider_root="${MPEGTS_ROOT:-/home/visar/Videos/downloads/fc2}"

usage() {
    printf 'Usage: %s "CHANNEL_ID"\n' "$(basename "$0")" >&2
    printf 'Example: %s "1179794"\n' "$(basename "$0")" >&2
}

if [[ $# -ne 1 || -z $1 ]]; then
    usage
    exit 2
fi

channel_id=$1
rows=()
failed=0

for collection in downloaded edited; do
    for recording_dir in "$provider_root/$collection"/*; do
        [[ -d $recording_dir ]] || continue

        recording_id=${recording_dir##*/}
        [[ ${recording_id:18} == "$channel_id" ]] || continue

        playlist="$recording_dir/playlist.m3u8"
        if [[ ! -f $playlist ]]; then
            rows+=("$recording_id"$'\t''—'$'\t''playlist missing')
            failed=1
            continue
        fi

        media_fragment=$(awk '/^[^#]/ && NF { print }' "$playlist" | shuf -n 1)
        if [[ -z $media_fragment ]]; then
            rows+=("$recording_id"$'\t''—'$'\t''no MPEG-TS fragments')
            failed=1
            continue
        fi

        fragment_path="$recording_dir/$media_fragment"
        if [[ ! -f $fragment_path ]]; then
            rows+=("$recording_id"$'\t'"$media_fragment"$'\t''selected file missing')
            failed=1
            continue
        fi

        if dimensions=$(ffprobe -v error \
            -read_intervals '%+#1' \
            -select_streams v:0 \
            -show_frames \
            -show_entries frame=width,height \
            -of csv=p=0:s=x \
            "$fragment_path"); then
            dimensions=${dimensions%%$'\n'*}
            rows+=("$recording_id"$'\t'"$media_fragment"$'\t'"$dimensions")
        else
            rows+=("$recording_id"$'\t'"$media_fragment"$'\t''probe failed')
            failed=1
        fi
    done
done

if [[ ${#rows[@]} -eq 0 ]]; then
    printf 'No MPEG-TS recordings found for FC2 channel: %s\n' "$channel_id" >&2
    exit 1
fi

{
    printf 'VIDEO\tRANDOM FRAGMENT\tDIMENSIONS\n'
    printf '%s\n' "${rows[@]}"
} | column -t -s $'\t'

exit "$failed"
