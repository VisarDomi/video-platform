# Shared Decisions

## AliasRegistry: single owner of aliases.json

Only the server process writes aliases.json via the hourly refresh cycle. The downloader reads from disk once at startup and uses resolveOrFetch for in-memory-only cache misses — it never persists to disk.

aliases.json format is `streamerId -> string[]` where the last element is the current alias and earlier elements are history. This is backward-compatible with the original format.

## AliasRegistry: tango.txt sync after refresh

After each hourly refresh, syncTangoTxt rewrites alias portions in tango.txt to match current truth. Only touches lines where the alias actually changed. Preserves comments and line ordering.

## Tokens: diagnostic fields for 401 debugging

readTokens() includes readAtMs (when read from disk), ttlAtReadSec (seconds until tte expiry at read time), and tokenAgeMs (ms since auth service wrote the token). These are used in 401 error logs to diagnose token timing issues.

## FileLock: stale lock detection

Lock is a directory (mkdir is atomic on all platforms). Holder info (PID + timestamp) is written inside. On contention: read holder PID, check if process is alive via `kill(pid, 0)`. If dead, remove stale lock and retry immediately. If holder file can't be read (mid-creation race), just retry after delay.

## Batch alias endpoint caps at 500

The Tango batch profile API returns at most 500 results per request. The fetcher chunks requests in groups of 500 sequentially. The followings endpoint uses size=5000 to get all followed accounts in one call.
