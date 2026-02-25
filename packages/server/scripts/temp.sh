#!/bin/bash

# --- Configuration ---
# Set the constant for the directory you want to scan.
# IMPORTANT: Replace "/home/visar/Videos/tango/upload" with your actual directory path.
TARGET_DIR="/home/visar/Videos/tango/upload"

# --- Pre-flight Checks ---
# Check if the directory exists
if [ ! -d "$TARGET_DIR" ]; then
  echo "Error: Directory not found: $TARGET_DIR"
  exit 1
fi

# Check if the 'bc' command is available for calculations
if ! command -v bc &> /dev/null; then
    echo "Error: The 'bc' command is not installed. Please install it to proceed."
    echo "On Debian/Ubuntu, run: sudo apt-get install bc"
    exit 1
fi

# --- Main Logic ---
echo "Scanning for video details in: $TARGET_DIR"

# Print the table header using printf for alignment.
# We've added a fourth column for DURATION.
printf "\n%-50s %-15s %-15s %-15s\n" "FILENAME" "BITRATE (kb/s)" "SIZE (MB)" "DURATION"
# Print a separator line that matches the new column widths
printf '%*s\n' 98 | tr ' ' '-'

# Loop through all files in the target directory.
for file in "$TARGET_DIR"/*
do
  # Check if the current item is a regular file
  if [ -f "$file" ]; then
    
    # OPTIMIZATION: Run ffmpeg only ONCE per file and store its output.
    ffmpeg_output=$(ffmpeg -i "$file" 2>&1)

    # 1. Get the Bitrate from the stored output
    bitrate=$(echo "$ffmpeg_output" | awk '/bitrate/ {print $6; exit}')

    # Check if a bitrate was found (i.e., it's a valid video file ffmpeg can read)
    if [ -n "$bitrate" ]; then
      
      # 2. Get the Duration from the stored output
      # awk finds the line with "Duration", removes the trailing comma from the second field, and prints it.
      duration=$(echo "$ffmpeg_output" | awk '/Duration/ {gsub(/,/, ""); print $2; exit}')

      # 3. Get the File Size in Megabytes
      size_bytes=$(stat -c %s "$file")
      size_mb=$(echo "scale=2; $size_bytes / 1024 / 1024" | bc)

      # 4. Get just the filename (without the directory path)
      filename=$(basename "$file")

      # Print the formatted row with all four columns
      printf "%-50s %-15s %-15s %-15s\n" "$filename" "$bitrate" "${size_mb} MB" "$duration"
    fi
  fi
done

printf '%*s\n' 98 | tr ' ' '-'
echo "Scan complete."