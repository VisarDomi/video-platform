# Auth Decisions

## Tango token lifetimes

Refresh token (RT): 90 days. Access token (ST): 1 hour. Stream tokens (tt/ttu/tte): 10 seconds.

## Auth queue: pass full response, not just body

The auth queue resolves with the full Response object, not parsed JSON. Callers need to inspect headers (set-cookie) to extract tokens. A simple `response.ok` check + body parse would lose cookie data.
