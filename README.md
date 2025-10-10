# video-editor
A web interface for viewing and editing videos.

            // Use the XDG Base Directory Specification for user-specific data files.
            // This is the standard "Linux way" for services running under a specific user.
            const sharedStatePath = path.join(os.homedir(), ".local", "share", "tango-services");
            const statusFilePath = path.join(sharedStatePath, LIVE_STATUS_FILENAME);
