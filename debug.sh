#!/bin/bash

# A diagnostic script to find problematic .ts segments in a directory that
# cause playback issues on sensitive players (like Safari on iOS) after
# concatenation.

# --- Colors for better output ---
C_RED='\033[0;31m'
C_GREEN='\033[0;32m'
C_YELLOW='\033[1;33m'
C_BLUE='\033[0;34m'
C_NC='\033[0m' # No Color

# ==============================================================================
# --- Configuration ---
# EDIT THIS VARIABLE to point to the specific directory you want to debug.

DEBUG_DIR_PATH="/home/visar/Documents/tango-dl/tango-raw/2025-09-16 131604 eva5557"

# --- End of Configuration ---
# ==============================================================================


# ==============================================================================
# --- Script Entry Point (No need to edit below this line) ---
# ==============================================================================

# Validate the configuration
if [[ -z "$DEBUG_DIR_PATH" || "$DEBUG_DIR_PATH" == "/path/to/your/problem/directory" ]]; then
    echo -e "${C_RED}Error: Please edit the 'DEBUG_DIR_PATH' variable inside the script.${C_NC}"
    exit 1
fi

INPUT_DIR="$DEBUG_DIR_PATH" # Use the variable from the config section

if [ ! -d "$INPUT_DIR" ]; then
    echo -e "${C_RED}Error: Directory not found: '$INPUT_DIR'${C_NC}"
    exit 1
fi

if ! command -v ffprobe &> /dev/null; then
    echo -e "${C_RED}Error: ffprobe is not installed or not in your PATH. It is part of the ffmpeg package.${C_NC}"
    exit 1
fi

echo -e "${C_BLUE}==============================================================================${C_NC}"
echo -e "${C_BLUE}>>> Starting Debug for Directory: $(basename "$INPUT_DIR")${C_NC}"
echo -e "${C_BLUE}==============================================================================${C_NC}"

cd "$INPUT_DIR" || { echo -e "${C_RED}Could not change to directory '$INPUT_DIR'${C_NC}"; exit 1; }

# Get a sorted list of .ts files
files_to_process=( $(ls -v *.ts*) )
total_files=${#files_to_process[@]}

if [ "$total_files" -eq 0 ]; then
    echo -e "${C_YELLOW}No .ts files found in this directory. Exiting.${C_NC}"
    cd - > /dev/null
    exit 0
fi

# ==============================================================================
# --- PHASE 1: Stream Parameter Analysis ---
# ==============================================================================
echo ""
echo -e "${C_YELLOW}--- PHASE 1: Analyzing all segments for inconsistencies... ---${C_NC}"
echo "Comparing all segments against the first segment ('${files_to_process[0]}') for any changes in video or audio properties."
echo ""

# Get reference properties from the first file
REF_FILE="${files_to_process[0]}"
PROBE_CMD="ffprobe -v error -select_streams"
REF_VIDEO_PROPS=$($PROBE_CMD v:0 -show_entries stream=codec_name,profile,width,height,pix_fmt,r_frame_rate -of default=noprint_wrappers=1:nokey=1 "$REF_FILE")
REF_AUDIO_PROPS=$($PROBE_CMD a:0 -show_entries stream=codec_name,sample_rate,channels,channel_layout -of default=noprint_wrappers=1:nokey=1 "$REF_FILE")

echo "Reference Properties from '$REF_FILE':"
echo "  Video: $REF_VIDEO_PROPS"
echo "  Audio: $REF_AUDIO_PROPS"
echo ""

anomaly_found=false
current_file_num=0

for f in "${files_to_process[@]}"; do
    ((current_file_num++))
    printf "\r  -> Checking: [%d/%d] %s... " "$current_file_num" "$total_files" "$f"

    VIDEO_PROPS=$($PROBE_CMD v:0 -show_entries stream=codec_name,profile,width,height,pix_fmt,r_frame_rate -of default=noprint_wrappers=1:nokey=1 "$f")
    AUDIO_PROPS=$($PROBE_CMD a:0 -show_entries stream=codec_name,sample_rate,channels,channel_layout -of default=noprint_wrappers=1:nokey=1 "$f")

    if [ "$VIDEO_PROPS" != "$REF_VIDEO_PROPS" ]; then
        anomaly_found=true
        echo -e "\n${C_RED}!!! ANOMALY FOUND (VIDEO) in '$f' !!!${C_NC}"
        echo -e "  - Expected: $REF_VIDEO_PROPS"
        echo -e "  - Found:    $VIDEO_PROPS"
    fi

    if [ "$AUDIO_PROPS" != "$REF_AUDIO_PROPS" ]; then
        anomaly_found=true
        echo -e "\n${C_RED}!!! ANOMALY FOUND (AUDIO) in '$f' !!!${C_NC}"
        echo -e "  - Expected: $REF_AUDIO_PROPS"
        echo -e "  - Found:    $AUDIO_PROPS"
    fi
done

printf "\r%s\n" "  -> Analysis complete. Scanned $total_files segments.                    "
echo ""

if [ "$anomaly_found" = true ]; then
    echo -e "${C_GREEN}--- PHASE 1 VERDICT ---${C_NC}"
    echo -e "${C_YELLOW}An inconsistency was found! This is the most likely cause of your problem.${C_NC}"
    echo "The safest solution is to re-encode ALL segments to a consistent format before joining."
    echo "You can do this by modifying your original script to force re-encoding instead of copying."
    echo "See 'THE ROBUST FIX' section at the end of this script's output for a command."
    cd - > /dev/null
    exit 0
else
    echo -e "${C_GREEN}--- PHASE 1 VERDICT ---${C_NC}"
    echo "No inconsistencies found in stream parameters. The problem might be related to timestamps or other subtle container issues."
    echo "Proceeding to Phase 2..."
fi


# ==============================================================================
# --- PHASE 2: Incremental Concatenation Test ---
# ==============================================================================
echo ""
echo -e "${C_YELLOW}--- PHASE 2: Building test files for manual checking... ---${C_NC}"
echo "This will create several MP4 files in a new 'debug_output' directory."
echo "You will need to test each file as it is created."
echo ""
read -p "Do you wish to continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    cd - > /dev/null
    exit 1
fi

DEBUG_DIR="debug_output"
mkdir -p "$DEBUG_DIR"
rm -f "$DEBUG_DIR"/* # Clean previous runs
FILE_LIST=$(mktemp)
trap 'rm -f "$FILE_LIST"' EXIT

# Create a list of all files with full paths
for f in "${files_to_process[@]}"; do
    echo "file '$(realpath "$f")'" >> "$FILE_LIST"
done

chunk_size=10
last_good_count=0

for (( i=chunk_size; i<=total_files; i+=chunk_size )); do
    SEGMENT_COUNT=$i
    # Handle the last chunk which might be smaller
    if [ $i -gt $total_files ] && [ $last_good_count -lt $total_files ]; then
        SEGMENT_COUNT=$total_files
    elif [ $i -gt $total_files ]; then
        break
    fi
    
    OUTPUT_TEST_FILE="$DEBUG_DIR/test_video_segments_1_to_${SEGMENT_COUNT}.mp4"
    echo -e "\n${C_BLUE}Creating test file with the first $SEGMENT_COUNT segments...${C_NC}"
    echo "  -> Output: $OUTPUT_TEST_FILE"
    
    head -n "$SEGMENT_COUNT" "$FILE_LIST" | ffmpeg \
        -nostdin -hide_banner -loglevel error -stats \
        -f concat -safe 0 -i - \
        -c copy -bsf:a aac_adtstoasc \
        -movflags +faststart -fflags +genpts -y "$OUTPUT_TEST_FILE"

    echo -e "${C_YELLOW}ACTION REQUIRED: Please test the file '${OUTPUT_TEST_FILE}' now.${C_NC}"
    read -p "Does it play correctly for its full duration? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "\n${C_RED}--- PHASE 2 VERDICT ---${C_NC}"
        echo "Playback failed!"
        echo -e "The problematic segment is likely between segment #${C_YELLOW}$((last_good_count + 1))${C_NC} and #${C_YELLOW}${SEGMENT_COUNT}${C_NC}."
        echo "The filename is likely around: ${files_to_process[$last_good_count]}"
        break
    fi
    last_good_count=$SEGMENT_COUNT
    # Break if we just processed the last chunk
    if [ $SEGMENT_COUNT -eq $total_files ]; then
      break
    fi
done

# Final check if all passed
if [ $last_good_count -eq $total_files ]; then
    echo -e "${C_GREEN}All incremental tests passed. The issue might be very specific to the full concatenation or file size."
fi

echo ""
echo -e "${C_GREEN}==============================================================================${C_NC}"
echo -e "${C_GREEN}>>> DEBUGGING COMPLETE <<<${C_NC}"
echo -e "${C_GREEN}==============================================================================${C_NC}"
echo ""
echo -e "${C_BLUE}--- THE ROBUST FIX ---${C_BLUE}"
echo "Regardless of the issue found, the most reliable way to fix this is to NOT use '-c copy'."
echo "Instead, re-encode all streams to guarantee they are 100% compatible. This forces a uniform"
echo "framerate, pixel format, and resets all timestamps properly."
echo ""
echo "You can replace your final 'ffmpeg' command in the original script with this:"
echo ""
echo -e "${C_YELLOW}ffmpeg \\"
echo -e "${C_YELLOW}    -nostdin -hide_banner -loglevel error -stats \\"
echo -e "${C_YELLOW}    -f concat -safe 0 -i \"\$FILE_LIST\" \\"
echo -e "${C_YELLOW}    -c:v libx264 -preset fast -crf 22 \\"
echo -e "${C_YELLOW}    -c:a aac -b:a 128k \\"
echo -e "${C_YELLOW}    -pix_fmt yuv420p \\"
echo -e "${C_YELLOW}    -movflags +faststart \\"
echo -e "${C_YELLOW}    -y \"\$OUTPUT_FILE\"${C_NC}"
echo ""
echo "This will take longer as it re-encodes video, but it produces a much more compatible file."

cd - > /dev/null