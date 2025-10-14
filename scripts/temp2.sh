#!/bin/bash

# --- CONFIGURABLE VARIABLES ---

# 1. Set the source folder containing your video files.
INPUT_FOLDER="/home/visar/Videos/tango/edited/"

# 2. Set the destination directory for the upscaled files.
OUTPUT_DIR="/home/visar/Videos/temp"

# 3. Set your chosen encoding parameters.
CQ_VALUE=24
PRESET=p4

# 4. Set the suffix to add to the new filename (before the extension).
#    Underscores are generally safer than spaces in filenames.
FILENAME_SUFFIX=""

# --- END OF CONFIGURATION ---


# --- SCRIPT LOGIC (No need to edit below this line) ---

# Check if the input folder actually exists
if [ ! -d "$INPUT_FOLDER" ]; then
    echo "Error: Input folder not found at: $INPUT_FOLDER"
    exit 1
fi

# Create output directory if it doesn't exist
mkdir -p "$OUTPUT_DIR"

# Find all .mp4 files in the input folder to process
# Note: To process other types, add them like: ("$INPUT_FOLDER"/*.mp4 "$INPUT_FOLDER"/*.mov)
shopt -s nullglob # This prevents errors if no files are found
files=("$INPUT_FOLDER"/*.mp4)
shopt -u nullglob

total_files=${#files[@]}
if [ "$total_files" -eq 0 ]; then
    echo "No .mp4 files found in the input folder. Exiting."
    exit 0
fi

echo "Found $total_files video(s) to process."
echo "---"

current_file_num=1

# --- BATCH PROCESSING LOOP ---
for INPUT_FILE in "${files[@]}"; do

    BASENAME=$(basename "$INPUT_FILE")
    FILENAME="${BASENAME%.*}"
    EXTENSION="${BASENAME##*.}"
    OUTPUT_FILE="${OUTPUT_DIR}/${FILENAME}${FILENAME_SUFFIX}.${EXTENSION}"

    echo "=========================================================="
    echo "Processing file ${current_file_num}/${total_files}: ${BASENAME}"
    echo "Outputting to: ${OUTPUT_FILE}"
    echo "=========================================================="

    # --- FULLY COMPATIBLE DIMENSION DETECTION ---
    dimensions_output=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of default=noprint_wrappers=1:nokey=1 "$INPUT_FILE")
    width=$(echo "$dimensions_output" | sed -n 1p)
    height=$(echo "$dimensions_output" | sed -n 2p)

    if [ -z "$width" ] || [ -z "$height" ]; then
        echo "WARNING: Could not read dimensions for ${BASENAME}. Skipping this file."
        ((current_file_num++))
        continue # Skip to the next file
    fi
    echo "Detected dimensions: ${width}x${height}"

    # Apply math to determine the correct scaling dimensions
    if (( width > height )); then
        SCALE_FILTER="scale=1920:-2"
        echo "Orientation: Horizontal. Scaling to 1920x..."
    elif (( height > width )); then
        SCALE_FILTER="scale=1080:-2"
        echo "Orientation: Vertical. Scaling to 1080x..."
    else
        SCALE_FILTER="scale=1080:1080"
        echo "Orientation: Square. Scaling to 1080x1080..."
    fi

    # --- Execute the FFmpeg command ---
    ffmpeg -i "$INPUT_FILE" \
        -vf "${SCALE_FILTER}:flags=lanczos" \
        -c:v h264_nvenc \
        -preset "$PRESET" \
        -cq "$CQ_VALUE" \
        -c:a copy \
        "$OUTPUT_FILE"

    echo "Finished processing ${BASENAME}."
    ((current_file_num++))
done

echo "=========================================================="
echo "All $total_files files have been processed."
echo "Upscaled videos are located in: $OUTPUT_DIR"
echo "=========================================================="
