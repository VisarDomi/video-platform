#!/bin/bash

# A script to convert large video files (.ts, .mp4) into a standardized,
# highly compatible format.
#
# It re-encodes every video file found in the BASE_DIR to:
#   - Resolution: 720x1280 (portrait)
#   - Video Codec: H.264 (libx264) with high-quality settings
#   - Audio Codec: AAC
#   - Container: MP4 with 'faststart' for web streaming.
#
# The script preserves the original aspect ratio by adding black bars
# (padding) if the source video is not already 720x1280. This prevents
# unwanted stretching or distortion.
#
# Original files are not modified by default. Processed files are saved in a
# 'converted' subdirectory. The script can be configured to move originals
# to a 'trashed' folder or delete them permanently.

# ==============================================================================
# --- Configuration ---
# EDIT THESE VARIABLES to suit your needs.

# The full path to the directory containing your .ts and .mp4 files.
BASE_DIR="/home/visar/Videos/oldtango"

### NEW: Deletion Behavior Configuration
# What to do with an original file after a successful conversion, or if the
# converted file already exists on a subsequent run.
# Options:
#   "skip"   - (Default & Safest) Do nothing to the original file.
#   "trash"  - (Recommended) Move the original file to a 'trashed' subdirectory.
#   "delete" - (DANGEROUS) Permanently delete the original file. Use with caution.
DELETE_MODE="trash" # <<< CHANGE THIS TO "skip", "trash", or "delete"

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

if ! command -v ffmpeg &> /dev/null; then
    echo -e "${C_RED}Error: ffmpeg is not installed or not in your PATH.${C_NC}"
    exit 1
fi

### NEW: Add a final warning for the dangerous 'delete' mode
if [[ "$DELETE_MODE" == "delete" ]]; then
    echo -e "${C_RED}!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! WARNING !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo -e "DELETE_MODE is set to 'delete'. Original files will be PERMANENTLY REMOVED."
    echo -e "You have 5 seconds to press Ctrl+C to abort."
    echo -e "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!${C_NC}"
    sleep 5
fi

# --- Setup Output & Trash Directories ---
OUTPUT_DIR="$BASE_DIR/converted"
TRASH_DIR="$BASE_DIR/trashed" ### NEW
mkdir -p "$OUTPUT_DIR"
echo -e "${C_BLUE}Source directory: $BASE_DIR${C_NC}"
echo -e "${C_BLUE}Output will be saved in: $OUTPUT_DIR${C_NC}"

### NEW: Create trash directory only if needed
if [[ "$DELETE_MODE" == "trash" ]]; then
    mkdir -p "$TRASH_DIR"
    echo -e "${C_BLUE}Originals will be moved to: $TRASH_DIR${C_NC}"
fi
echo "=============================================================================="

### NEW: Helper function to handle the original file
handle_original_file() {
    local source_file="$1"
    local source_filename="$2"

    case "$DELETE_MODE" in
        "trash")
            echo -e "  -> Moving original to trash: ${C_YELLOW}${source_filename}${C_NC}"
            mv -f "$source_file" "$TRASH_DIR/"
            ;;
        "delete")
            echo -e "  -> ${C_RED}DELETING original file: ${C_YELLOW}${source_filename}${C_NC}"
            rm -f "$source_file"
            ;;
        *)
            # This case covers "skip" or any other value
            # Do nothing to the original file
            ;;
    esac
}

# --- Main Processing Loop ---
find "$BASE_DIR" -maxdepth 1 -type f \( -iname "*.ts" -o -iname "*.mp4" \) -print0 | sort -z | while IFS= read -r -d '' INPUT_FILE; do    
    FILENAME=$(basename "$INPUT_FILE")
    BASENAME="${FILENAME%.*}"
    OUTPUT_FILE="$OUTPUT_DIR/${BASENAME}.mp4"

    echo -e "${C_BLUE}>>> Processing file: ${C_YELLOW}${FILENAME}${C_NC}"

    # Check if the output file already exists
    if [ -f "$OUTPUT_FILE" ]; then
        ### MODIFIED: Instead of just skipping, we now handle the original
        echo -e "  -> ${C_GREEN}Output file already exists.${C_NC}"
        handle_original_file "$INPUT_FILE" "$FILENAME"
        echo "" # for spacing
        continue
    fi

    echo "  -> Starting conversion..."

    # ffmpeg command to robustly re-encode the video
    ffmpeg \
        -nostdin \
        -hide_banner \
        -loglevel error \
        -progress - \
        -stats \
        -i "$INPUT_FILE" \
        \
        -vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,format=yuv420p" \
        \
        -c:v libx264 \
        -preset slow \
        -crf 18 \
        -threads 0 \
        \
        -c:a aac \
        -b:a 128k \
        \
        -bsf:a aac_adtstoasc \
        -movflags +faststart \
        -fflags +genpts \
        -y \
        "$OUTPUT_FILE"

    # Check if ffmpeg succeeded
    if [ $? -eq 0 ]; then
        echo -e "  -> ${C_GREEN}Success! Converted file saved to: $(basename "$OUTPUT_FILE")${C_NC}"
        ### NEW: Handle the original file after successful conversion
        handle_original_file "$INPUT_FILE" "$FILENAME"
    else
        echo -e "  -> ${C_RED}ERROR: ffmpeg failed to convert '${FILENAME}'.${C_NC}"
        rm -f "$OUTPUT_FILE"
    fi
    echo ""
done

echo "=============================================================================="
echo -e "${C_GREEN}All files have been processed.${C_NC}"
echo "=============================================================================="