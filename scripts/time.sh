#!/bin/bash

# A script to calculate the total duration of all video files in parallel
# that the 'convert.sh' script would process.
#
# It uses xargs to run multiple ffprobe instances concurrently, which can
# significantly speed up the scanning process on multi-core systems.
#
# It also provides a live progress bar showing the number of files
# processed and the cumulative duration found so far.

# ==============================================================================
# --- Configuration ---
# EDIT THIS VARIABLE. It MUST match the BASE_DIR in your 'convert.sh' script.

# The full path to the directory containing your .ts and .mp4 files.
BASE_DIR="/home/visar/Videos/oldtango"

# Number of parallel jobs to run. Defaults to the number of CPU cores.
# You can set this to a specific number, e.g., NUM_CORES=4
if command -v nproc &> /dev/null; then
    NUM_CORES=$(nproc)
else
    NUM_CORES=2 # A safe default if nproc isn't available
fi


# --- End of Configuration ---
# ==============================================================================

# --- Colors for better output ---
C_RED='\033[0;31m'
C_GREEN='\033[0;32m'
C_YELLOW='\033[1;33m'
C_BLUE='\033[0;34m'
C_NC='\033[0m' # No Color

# ==============================================================================
# --- Script Entry Point ---
# ==============================================================================

# --- Initial Sanity Checks ---
if [[ "$BASE_DIR" == "/path/to/your/video/directory" || -z "$BASE_DIR" ]]; then
    echo -e "${C_RED}Error: Please edit the 'BASE_DIR' variable inside the script.${C_NC}"
    exit 1
fi
if [ ! -d "$BASE_DIR" ]; then
    echo -e "${C_RED}Error: Base directory '$BASE_DIR' not found.${C_NC}"
    exit 1
fi
if ! command -v ffprobe &> /dev/null; then
    echo -e "${C_RED}Error: ffprobe is not installed or not in your PATH.${C_NC}"
    exit 1
fi

echo -e "${C_BLUE}Scanning for video files in: $BASE_DIR${C_NC}"
echo -e "${C_BLUE}Using up to ${NUM_CORES} parallel processes.${C_NC}"
echo "=============================================================================="

# --- Step 1: Find all files and get a total count ---
# We store the file list in an array to get an accurate count upfront.
# The 'mapfile' command is a safe way to read null-delimited input into an array.
mapfile -d '' files_to_process < <(find "$BASE_DIR" -maxdepth 1 -type f \( -iname "*.ts" -o -iname "*.mp4" \) -print0 | sort -z)
total_files=${#files_to_process[@]}

if [ "$total_files" -eq 0 ]; then
    echo -e "${C_YELLOW}No video files (.ts, .mp4) found in the specified directory.${C_NC}"
    exit 0
fi

# --- Step 2: Define the worker function ---
# This function will be executed by each parallel process.
# It takes one file path as an argument and prints its duration to stdout.
# It's crucial to 'export' the function so subshells created by xargs can see it.
get_duration() {
    local input_file="$1"
    # Use ffprobe to get the duration. Redirect ffprobe's own text output (stderr)
    # to /dev/null so it doesn't interfere with our progress bar.
    local duration
    duration=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$input_file" 2>/dev/null)

    if [ -n "$duration" ]; then
        echo "$duration"
    else
        # If ffprobe fails, we echo 0 so the aggregator loop doesn't break.
        # We also print an error message to stderr.
        >&2 echo -e "\n${C_RED}Warning: Could not get duration for '$(basename "$input_file")'. Skipping.${C_NC}"
        echo "0"
    fi
}
export -f get_duration # This makes the function available to child processes

# --- Step 3: Process files in parallel and aggregate results ---
total_seconds="0"
processed_count=0

# Use a 'while' loop reading from a 'process substitution' <(...)
# This prevents the loop from running in a subshell, so our variables
# (total_seconds, processed_count) remain available after the loop.
while IFS= read -r duration; do
    # bc is used for floating point arithmetic
    total_seconds=$(echo "$total_seconds + $duration" | bc)
    ((processed_count++))

    # Print the live progress line.
    # '\r' returns the cursor to the beginning of the line without a newline,
    # so the next printf overwrites the current one.
    # '%.2f' formats the seconds to two decimal places.
    printf "\r${C_GREEN}Progress: [%d/%d] | Total Duration So Far: %.2f seconds...${C_NC}" "$processed_count" "$total_files" "$total_seconds"

done < <(printf "%s\0" "${files_to_process[@]}" | xargs -0 -n 1 -P "$NUM_CORES" bash -c 'get_duration "$@"' _)

# After the loop, print a newline to move to the next line after the progress bar.
echo ""
echo "=============================================================================="

# --- Final Report ---
# Convert total seconds to HH:MM:SS format
# Bash can only do integer arithmetic, so we truncate the decimal part.
total_seconds_int=${total_seconds%.*}
hours=$((total_seconds_int / 3600))
minutes=$(((total_seconds_int % 3600) / 60))
seconds=$((total_seconds_int % 60))

FORMATTED_TIME=$(printf "%02d:%02d:%02d" $hours $minutes $seconds)

echo -e "${C_GREEN}Scan complete.${C_NC}"
echo -e "Files processed:  ${C_YELLOW}${processed_count}/${total_files}${C_NC}"
echo -e "Total duration:   ${C_YELLOW}${total_seconds} seconds${C_NC}"
echo -e "Formatted time:   ${C_YELLOW}${FORMATTED_TIME} (HH:MM:SS)${C_NC}"
echo ""
echo -e "${C_BLUE}To estimate conversion time:${C_NC}"
echo -e "If ffmpeg reports processing at ${C_YELLOW}10x${C_NC} speed, it would take roughly ${C_YELLOW}${FORMATTED_TIME}${C_NC} / 10."
echo -e "If it reports ${C_YELLOW}0.5x${C_NC} speed, it would take roughly ${C_YELLOW}${FORMATTED_TIME}${C_NC} * 2."
echo "=============================================================================="