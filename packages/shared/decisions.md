# Shared Decisions

## AliasManager: atomic rename for consistency

Reads don't take a lock — atomic rename on write guarantees readers always see a complete file. Writes use a file lock (mkdir-based) for read-modify-write, then atomic rename from `.tmp` to final path.

## FileLock: stale lock detection

Lock is a directory (mkdir is atomic on all platforms). Holder info (PID + timestamp) is written inside. On contention: read holder PID, check if process is alive via `kill(pid, 0)`. If dead, remove stale lock and retry immediately. If holder file can't be read (mid-creation race), just retry after delay.
