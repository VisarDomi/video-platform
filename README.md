# tango-dashboard

Safari ios focus. A web interface for managing and editing archived Tango videos.

This dashboard is a standalone tool for viewing, trimming, and managing video files in a specified directory.

## Architecture

This is a user-facing web application with an Express backend that:
-   Reads a `videos` directory to serve archived content.
-   Provides a UI to view, trim, and delete these archives.
-   Trimming a video creates a new version in an `edited` sub-directory and deletes the original. Deleting from the UI permanently removes the file.
