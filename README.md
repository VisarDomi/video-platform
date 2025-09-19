# Tango Video Editor

**A fast, self-hosted web interface for viewing and trimming local video archives.**

This dashboard provides a simple, browser-based tool for quickly cutting segments from `.mp4` files and managing the originals without needing a complex desktop video editor.

<!-- It's highly recommended to add a screenshot or a GIF of the UI in action here -->
<!-- ![Tango Video Editor UI](path/to/screenshot.png) -->

## Table of Contents

-   [Core Features](#core-features)
-   [The Editing Workflow](#the-editing-workflow)
-   [Tech Stack](#tech-stack)
-   [System Prerequisites](#system-prerequisites)
-   [Installation & Setup](#installation--setup)
-   [Running the Application](#running-the-application)
-   [Project Architecture](#project-architecture)
-   [API Endpoints](#api-endpoints)
-   [Future Improvements](#future-improvements)

## Core Features

-   **Multi-Directory Support**: Scans and serves videos from multiple source folders defined in your environment configuration.
-   **Browser-Based Streaming**: Streams video files directly to your browser over the local network.
-   **Simple & Fast Editing**: A point-and-click interface to define start and end times for segments.
-   **Segment Merging**: Creates a new video file by concatenating multiple selected segments from the original.
-   **Non-Destructive Workflow**: Originals are never permanently deleted from the UI. They are moved to a `trash` sub-directory within their source folder for easy recovery.
-   **Responsive UI**: A clean, single-page application (SPA) experience that works on desktop and mobile browsers.
-   **Live Filtering**: Instantly filter the video list using regular expressions.
-   **Stateful Player**: Remembers your last-played video and playback position.

## The Editing Workflow

The primary goal of this tool is to make trimming videos as efficient as possible.

1.  **Browse & Select**: From the main list view, find and click on an "original" video to open it in the player.
2.  **Mark Segments**:
    -   Navigate the video to the desired starting point of a clip.
    -   Click the **Add Point (📍)** button. A marker and timestamp appear on the progress bar.
    -   Navigate to the desired end point of that clip.
    -   Click the **Add Point (📍)** button again. The UI now displays a complete `start` and `end` time pair.
    -   You can repeat this process to select multiple segments from the same video.
3.  **Finalize Edit**:
    -   Once you have an even number of points (i.e., complete pairs), the **Create (✂️)** button becomes enabled.
    -   Clicking **Create (✂️)** triggers a background `ffmpeg` process on the server.
    -   The UI optimistically removes the original from the list and navigates to the next video.
4.  **Result**:
    -   The server creates a new `.mp4` file in the `edited` sub-directory of the original's source folder. This new file contains only the segments you selected, stitched together.
    -   The original `.mp4` file is moved into a `trash` sub-directory.

You can also delete an original video (without editing) by clicking the **Delete (🗑️)** button, which also moves it to the `trash` folder.

## Tech Stack

| Category      | Technology                                    | Description                                               |
| ------------- | --------------------------------------------- | --------------------------------------------------------- |
| **Backend**   | Node.js, Express.js, TypeScript               | Serves the frontend, provides the API, and runs `ffmpeg`. |
| **Frontend**  | Vanilla JavaScript (ES Modules), HTML5, CSS3  | A lightweight, framework-free single-page application.    |
| **Video Proc**| **`ffmpeg`** (External Dependency)            | The core engine for all video trimming and concatenation. |
| **Process Mgmt**| `pm2`                                         | Manages the Node.js server process for stability.         |
| **Config**    | `dotenv`                                      | Manages environment variables from a `.env` file.         |
| **Logging**   | `winston`                                     | Provides structured logging for the backend.              |

## System Prerequisites

1.  **Node.js**: v18 or later.
2.  **`ffmpeg`**: **This is critical.** `ffmpeg` must be installed on the server and accessible from the system's `PATH`. The application will fail without it.

## Installation & Setup

1.  **Clone the repository:**
    ```bash
    git clone <your-repo-url>
    cd tango-dashboard
    ```

2.  **Install Node.js dependencies:**
    ```bash
    npm install
    ```

3.  **Configure your environment:**
    -   Copy the template file: `cp .env.template .env`
    -   Open the new `.env` file and edit the `VIDEOS_DIRS` variable. This is a comma-separated list of absolute paths to the folders containing your videos.
    -   Example: `VIDEOS_DIRS=/mnt/recordings/cam1,/mnt/archives/cam2`

4.  **Build the TypeScript source code:**
    ```bash
    npm run build
    ```
    This compiles the `src/` directory into JavaScript in the `dist/` directory.

## Running the Application

The application uses `pm2` to run as a persistent background service.

-   **Start the server:**
    ```bash
    npm start
    ```

-   **View logs:**
    ```bash
    npm run logs
    ```

-   **Restart the server (after making code changes and running `npm run build`):**
    ```bash
    npm run restart
    ```

-   **Stop the server:**
    ```bash
    npm run stop
    ```

Once started, the server will log its IP address and port (default: `7998`). You can access the web interface from any device on the same network.

## Project Architecture

The project is a classic client-server monolith, organized into two main parts:

### Backend (`src/`)

-   **`server.ts`**: The main entry point. Sets up the Express server, middleware, and API routes.
-   **`config.ts`**: Loads and validates environment variables from the `.env` file.
-   **`api/`**: Contains route definitions.
    -   `video.routes.ts`: Handles requests for listing videos, editing, and deleting (`/api/videos`, `/api/edit`).
    -   `streaming.routes.ts`: Handles byte-range requests to stream video content (`/video/:type/:filename`).
-   **`services/video.service.ts`**: The core business logic. This service is responsible for:
    -   Scanning the filesystem for video files.
    -   Building and executing `ffmpeg` commands.
    -   Moving files to the `edited` and `trash` directories.
-   **`utils.ts`, `logger.ts`, `errors.ts`**: Standard helper modules.

### Frontend (`public/`)

The frontend is built as a Single Page Application (SPA) without a major framework like React or Vue. It uses a modular, state-driven approach.

-   **`index.html`**: The single entry point for the entire application.
-   **`app.js`**: The main script. It initializes the application, sets up event listeners, and handles URL hash-based routing.
-   **`modules/`**: The code is broken down into modules with distinct responsibilities:
    -   **`store.js`**: A simple, centralized state management object. It holds the application state (e.g., `videoList`, `currentVideo`, `segments`) and uses a listener pattern to notify other parts of the app when data changes. This is the "single source of truth."
    -   **`ui.js`**: Responsible for all DOM manipulation. It subscribes to the `store` and re-renders the UI whenever the state changes. It contains no application logic.
    -   **`player.js`**: Manages the `<video>` element's state, including loading sources, playing, and stopping.
    -   **`api.js`**: A collection of functions that make `fetch` requests to the backend API.

This architecture ensures a clear separation of concerns: `app.js` coordinates, `store.js` holds data, `api.js` talks to the server, and `ui.js` draws what it's told.

## API Endpoints

-   `GET /api/videos`: Returns a JSON list of all `original` and `edited` video files.
-   `POST /api/edit`: Edits a video. Expects a JSON body: `{ "filename": "...", "segments": [{ "start": N, "end": N }, ...] }`.
-   `DELETE /api/videos/:type/:filename`: Moves the specified video to the `trash` directory.
-   `GET /video/:type/:filename`: Streams the raw video file, supporting HTTP Range requests.

## Future Improvements

-   **Keyboard Shortcuts**: Implement shortcuts for common actions (e.g., spacebar to play/pause, keys for adding points, frame-by-frame seeking).
-   **Real-time Edit Progress**: Use WebSockets or polling to show the `ffmpeg` encoding progress for long edits.
-   **Configuration File**: Move settings like the port and `ffmpeg` path to a more robust configuration file instead of just `.env`.
-   **Error Handling**: Improve frontend feedback when a background `ffmpeg` process fails.
-   **Unit/Integration Tests**: Add tests for the backend services, especially the `ffmpeg` argument builder.