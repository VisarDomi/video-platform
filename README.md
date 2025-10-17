# video-editor
A web interface for viewing and editing videos.

## TODO
exactly after:
1. res.setHeader("Content-Type", "video/mp2t");
    - we serve from the disk.
    - we can improve response time by serving from memory
    - the network lag could be many more times that the improvement to disk retrieval
    - there's a point when the file is big and the disk is a hdd, with 100MB/s read speed.
    - which is a moot point because the .ts files are only ever 0.3MB in size
    - let's say the frontend requests 10 such files at once 
    - the total size is 3MB - so 0.03s - a local network delay is 0.01s at max... hmm so we actually got an issue for hdd
    - let's fix this to serve from memory as well
    flow:
    - check segmentCache.get(segmentName)
    - if it's there, serve from cache
    - if it's not there, serve from disk - at the same time - start cache invalidation:
    - we only ever cache the latest 3 filename requested
    - if the requested segment is from a new filename, we invalidate all segments of the oldest filename, and cache all segments of the new filename
    - cache does not throttle itself
