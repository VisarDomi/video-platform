# HTTP caching follow-up

The frontend cache split introduced in commit `88e67c2` is sound: hashed build assets can use a one-year immutable lifetime, while the SPA entry document must revalidate so a deployment cannot strand clients on an old asset graph.

## Dynamic API responses need an explicit policy

The video and provider-list endpoints currently rely on browser heuristic caching. Add `Cache-Control: no-store` to dynamic API responses. This makes the server's intent unambiguous and prevents Safari or an intermediary from reusing a stale list.

## Live HLS playlists must not be cached

Active media playlists change while a stream is running. Serve live `.m3u8` responses with `Cache-Control: no-store` (or an equivalently strict revalidation policy). A cached playlist can make playback appear frozen even while new segments are being produced.

## Finalized segments may be immutable only when their URLs are immutable

Completed HLS segments can use `Cache-Control: public, max-age=31536000, immutable` if a segment URL is never overwritten with different bytes. Keep short or no caching if the same URL can be regenerated.

## Keep the SPA shell explicitly revalidated

Continue serving `index.html` and the SPA fallback with `Cache-Control: no-cache`. `max-age=0` is not itself a problem here: it permits storage but requires validation before reuse, which is the desirable behavior for the entry document. The long lifetime belongs on content-hashed assets, not HTML.

## Minor routing cleanup

A missing static file such as `favicon.ico` currently falls through to the SPA document. Return a real icon or a `404` for asset-looking paths so clients do not cache HTML under an asset URL.
