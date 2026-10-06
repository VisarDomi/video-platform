# Tango

**Tango** is the iPhone app for live streams on tango.me (`tango-live` in
`apps/ios/providers.json`, bundle `com.visar.Tango.paid`). It runs the shared viewer's
`tango-live` provider (`packages/app/src/providers/tango-live.ts`) on tango.me:

1. Home lists followed streams first, then recommendations, one per streamer, without
   blocked streamers.
2. A stream plays full screen; swipe up/down for the next/previous stream.

This folder holds the app's notes and a maintenance script; it has no app code. Build,
deploy, login and renewal: [`apps/ios/PORT.md`](../ios/PORT.md). Provider details:
[`packages/app/PROVIDERS.md`](../../packages/app/PROVIDERS.md) ("Tango live").

## Why?
Native navigation is cumbersome and too resource intensive and wastes phone battery.

## How?
[flow.md](flow.md) explains the flows that this app handles best.

## setup
[notes.md](./notes.md)
