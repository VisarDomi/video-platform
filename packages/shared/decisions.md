# Shared Decisions

## Tokens: diagnostic fields for 401 debugging

readTokens() includes readAtMs (when read from disk), ttlAtReadSec (seconds until tte expiry at read time), and tokenAgeMs (ms since auth service wrote the token). These are used in 401 error logs to diagnose token timing issues.

## FileLock: stale lock detection

Lock is a directory (mkdir is atomic on all platforms). Holder info (PID + timestamp) is written inside. On contention: read holder PID, check if process is alive via `kill(pid, 0)`. If dead, remove stale lock and retry immediately. If holder file can't be read (mid-creation race), just retry after delay.
