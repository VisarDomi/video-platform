# Changelog

## 2026-02-25

- **feature**: Swipe gesture system replacing quadrant tap overlay
  - **design**: Ported swipe pattern from video-editor-svelte. Vertical swipe (80px threshold) navigates between streamers (up=next, down=prev). Horizontal swipe (80px threshold) shows/hides UI controls (right=show, left=hide). Edge-back swipe (start within 30px of left edge) goes back to list with iOS-native feel — `translateX` follows finger, commits at 30% screen width, cancels with 250ms ease-out transition. List view is revealed mid-swipe by temporarily removing `hidden-view` class. Touch events use saved `originalAddEventListener` reference to bypass the global addEventListener block that prevents page JS from registering touch handlers.
  - **files**: `stream-unit.ts` (swipe handlers, edge-back logic, heart icons), `stream-unit.dom.ts` (removed quadrant overlay HTML/CSS, added touch-action:none), `ui.resources.ts` (removed user-select:none, swipe-active/swipe-animating CSS), `environment.ts` (export originalAddEventListener, disable zoom viewport meta), `app.builder.ts` → `container.ts` → `video.manager.ts` (thread addEventListener through DI chain)

- **refactor**: Remove back button, replace follow icons with hearts
  - **design**: Back-to-list button removed — replaced by edge-back swipe. Follow/unfollow icons changed from ➕/➖ to 🤍/❤️ with red border when following.
  - **files**: `stream-unit.dom.ts` (removed back-btn, changed emoji), `stream-unit.ts` (removed backBtn binding/listener, updated updateFollowButton)

- **fix**: Text now selectable in video view
  - **root cause**: `#videoView` had `user-select: none` and `-webkit-user-select: none`, preventing streamer name selection.
  - **files**: `ui.resources.ts`

- **infra**: Moved repo from `~/Documents/video-repos/tango-explorer` to `~/Documents/scripts/browser/userscripts/tango-explorer` with symlink at old location.
