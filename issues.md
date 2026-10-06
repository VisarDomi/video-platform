# HTTP caching

The server (`packages/server/src/main.ts`) gives the content-hashed build assets under
`/assets/` `Cache-Control: public, max-age=31536000, immutable`. `index.html`, the SPA
fallback and every other static file get Express's default `public, max-age=0` with an
ETag, so clients revalidate the entry document before reuse and a deployment cannot
strand them on an old asset graph. The long lifetime belongs on hashed assets, not HTML.

## Dynamic API responses have no caching policy

The video and provider-list endpoints (`/api/videos`, `/api/<provider>/list|member|exists|resolve`)
send no `Cache-Control`, only an ETag. Add `Cache-Control: no-store` to dynamic API
responses so the server's intent is unambiguous and Safari or an intermediary cannot reuse
a stale list. `API.HEADERS.NO_CACHE` in `packages/server/src/core/constants.ts` is defined
but unused.

## Live HLS playlists have no caching policy

`GET /hls/:provider/:filename/playlist.m3u8` (`packages/server/src/api/hls.routes.ts`)
sends no `Cache-Control`, although a recording's playlist changes while the stream is
running. Serve it with `Cache-Control: no-store` (or an equivalently strict revalidation
policy): a cached playlist can make playback appear frozen while new segments are produced.

## Segments may be immutable only when their URLs are immutable

Segments (`/hls/:provider/:filename/<segment>.ts|.mp4`) also send no `Cache-Control`.
Completed segments can use `Cache-Control: public, max-age=31536000, immutable` only if a
segment URL is never overwritten with different bytes. Keep short or no caching if the
same URL can be regenerated.

## Missing asset paths return the SPA document

`/favicon.ico` and any missing asset-looking path (such as `/assets/missing.js`) get
`index.html` with status 200, so clients can cache HTML under an asset URL. `index.html`
links `/favicon.ico`, but the icon is in `packages/app/static/`, which Vite does not copy
into the build (its public directory is `public/`). Ship the icon and return a `404` for
asset-looking paths.
