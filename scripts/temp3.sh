#!/bin/bash

# --- Configuration ---
TARGET_DIR="/home/visar/Videos/tango/modified"
CPU_CORES=$(nproc)
echo "Using up to $CPU_CORES CPU cores for parallel processing."

# --- Pre-flight Checks ---
# (omitted for brevity, they are the same)

# --- Main Logic ---
echo "Scanning for video details in: $TARGET_DIR (Parallel Mode)"

printf "\n%-50s %-15s %-15s %-15s\n" "DIRECTORY" "AVG BITRATE (kb/s)" "TOTAL SIZE (MB)" "TOTAL DURATION"
printf '%*s\n' 101 | tr ' ' '-'

probe_ts_file() {
    file="$1"
    ffprobe -v error \
            -show_entries format=duration,bit_rate \
            -of default=noprint_wrappers=1:nokey=1 "$file" 2>/dev/null | paste -sd ' ' -
}
export -f probe_ts_file

for item in "$TARGET_DIR"/*
do
  if [ -d "$item" ]; then
    dirname=$(basename "$item")

    aggregated_data=$( \
        find "$item" -maxdepth 1 -type f -name "*.ts" -print0 | \
        xargs -0 -P "$CPU_CORES" -I {} bash -c 'probe_ts_file "{}"' | \
        awk '
            # Check that we have valid, two-column output
            NF == 2 {
                # --- THIS IS THE FIX ---
                # Perform a sanity check to reject outlier bitrates.
                # A bitrate over 5,000 kbps (5 Mbps) is likely an error.
                bitrate_kbps = $2 / 1000
                if (bitrate_kbps < 5000) {
                    total_duration += $1
                    total_bitrate_sum += $2
                    count++
                }
            }
            END {
                if (count > 0) {
                    avg_bitrate_kbps = (total_bitrate_sum / count) / 1000
                    printf "%.2f %d", total_duration, avg_bitrate_kbps
                }
            }
        ' \
    )

    if [ -n "$aggregated_data" ]; then
      read total_duration_seconds average_bitrate_kbps <<< "$aggregated_data"
      size_bytes=$(du -sb "$item" | awk '{print $1}')
      size_mb=$(echo "scale=2; $size_bytes / 1024 / 1024" | bc)
      
      total_seconds_int=${total_duration_seconds%.*}
      centiseconds=${total_duration_seconds#*.}
      ss=$((total_seconds_int % 60))
      mm=$(((total_seconds_int / 60) % 60))
      hh=$((total_seconds_int / 3600))
      
      formatted_duration=$(printf "%02d:%02d:%02d.%s" $hh $mm $ss $centiseconds)
      printf "%-50s %-15s %-15s %-15s\n" "$dirname" "$average_bitrate_kbps" "${size_mb} MB" "$formatted_duration"
    fi
  fi
done

printf '%*s\n' 101 | tr ' ' '-'
echo "Scan complete."