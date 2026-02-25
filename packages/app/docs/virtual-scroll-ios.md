# Virtual Scrolling on iOS: How We Made It Work

How we implemented virtual scrolling for a 5000+ item list in a PWA while keeping native iOS scroll feel — and why the obvious approaches fail on iOS.

## The problem

One provider has ~5600 videos. Rendering all 5600 `<button>` elements at once made startup visibly slow — the backend returned data in ~100ms, but the browser needed hundreds of milliseconds to mount 5600 components and lay them out.

## Why virtual scrolling is usually painful on iOS

Most virtual scroll libraries use `position: fixed` or `position: absolute` containers with `overflow: auto` to create a scrollable viewport. On iOS Safari (and iOS PWAs), `position: fixed` has well-known issues:

1. **Viewport height mismatch** — `window.innerHeight` is smaller than `screen.height` by ~26px (the home indicator area). Fixed elements are capped to `window.innerHeight`, leaving a gap at the bottom.

2. **Scroll bounce interference** — iOS overscroll bounce interacts badly with fixed containers. Elements shift during the bounce, causing visual glitches.

3. **Transform + fixed = broken** — Applying `transform` to a parent of a `position: fixed` element makes the element behave as `position: absolute` instead. This breaks layouts that rely on fixed positioning inside transformed containers.

4. **Momentum scroll desync** — iOS momentum scrolling (`-webkit-overflow-scrolling: touch`) in a custom scroll container can desync from the virtual rendering, causing blank flashes.

These issues meant every virtual scroll library we tried either had visual glitches, broke momentum scrolling, or created positioning bugs in the PWA fullscreen context.

## Our approach: virtual scroll on native window scroll

Instead of creating a custom scroll container, we kept native `window` scrolling and built virtual rendering on top of it.

### Architecture

```
window (native scroll — iOS handles all momentum, bounce, etc.)
  └── .list-container
        └── .virtual-spacer  (height: itemCount × 52px)
              └── div  (transform: translateY to position visible items)
                    └── VideoItem × ~100 (only visible + buffer)
```

### Key pieces

**1. Fixed item height (52px)**

Every `VideoItem` has `height: 52px; box-sizing: border-box`. This makes position calculation trivial: item N is at `N × 52` pixels from the top.

**2. Spacer div for correct scrollbar**

A `div.virtual-spacer` with `height: totalItems × 52px` gives the browser the real content height. The native scrollbar reflects the true list size. The user sees a normal scrollbar and can fling-scroll through the entire list.

**3. Svelte 5 reactive windowing**

```typescript
const ITEM_HEIGHT = 52;
const SCROLL_BUFFER = 40;

let scrollY = $state(0);

const startIdx = $derived(Math.max(0, Math.floor(scrollY / ITEM_HEIGHT) - SCROLL_BUFFER));
const endIdx = $derived(
    Math.min(filteredVideos.length,
        Math.ceil((scrollY + window.innerHeight) / ITEM_HEIGHT) + SCROLL_BUFFER)
);
const visibleVideos = $derived(filteredVideos.slice(startIdx, endIdx));
const offsetY = $derived(startIdx * ITEM_HEIGHT);
```

`scrollY` is the only `$state` that changes on scroll. Svelte 5's `$derived` is memoized — `startIdx` and `endIdx` only produce new values every 52px of scrolling, so `visibleVideos` (and the DOM) only update when items actually enter or leave the visible range.

**4. translateY positioning**

The visible items are wrapped in a div with `transform: translateY({offsetY}px)`. This positions them correctly within the spacer without using `position: absolute` on individual items.

**5. Scroll position restore**

On provider switch or returning from video view, we calculate the target scroll position mathematically:

```typescript
function scrollToActiveVideo() {
    const idx = filteredVideos.findIndex(v => v.filename === active.filename);
    const targetY = idx * ITEM_HEIGHT - window.innerHeight / 2 + ITEM_HEIGHT / 2;
    window.scrollTo(0, Math.max(0, targetY));
}
```

No DOM queries needed — the item doesn't even need to be rendered yet. `window.scrollTo` triggers the scroll handler, which updates `scrollY`, which renders the correct items.

## Why this works on iOS

- **No `position: fixed` scroll container** — we use `window` scrolling, which iOS handles natively with full momentum, bounce, and rubber-banding
- **No `overflow: auto` container** — no `-webkit-overflow-scrolling: touch` quirks
- **No transform on scroll container** — the `translateY` is on a child inside the spacer, not on the scroll container itself
- **The spacer is just a tall empty div** — iOS has no problem scrolling through a tall `position: relative` div with a small number of children

The only `position: fixed` element is the search/filter bar, which floats above the list. It's not inside any transformed container, so iOS handles it correctly.

## Performance characteristics

| Metric | Before (no virtualization) | After (virtual scroll) |
|--------|---------------------------|----------------------|
| DOM nodes for 5600 items | ~5600 buttons | ~100 buttons |
| Initial render | Hundreds of ms | < 10ms |
| Scroll handler cost | None (but initial mount slow) | `$state` assignment + integer math |
| Memory | All 5600 components alive | ~100 components alive |

The scroll handler fires on every scroll event but only does one `$state` assignment (`scrollY = currentScrollY`). The `$derived` chain does integer division and comparison — negligible cost. Svelte only touches the DOM when items enter or leave the visible range.

## Buffer size

`SCROLL_BUFFER = 40` means we render 40 extra items above and below the viewport. This prevents blank flashes during fast scrolling. For 52px items on a ~900px viewport, the visible count is ~17 items, plus 80 buffer items = ~97 items in the DOM at any time. Even with fast fling-scrolling, the buffer ensures items are rendered before they scroll into view.

## What we avoided

- **No external library** — the implementation is ~15 lines of reactive declarations
- **No IntersectionObserver** — unnecessary complexity for fixed-height items
- **No requestAnimationFrame throttling** — Svelte's `$derived` memoization handles this naturally
- **No `position: absolute` per-item** — `translateY` on the wrapper is simpler and causes one composite layer instead of N
- **No pagination** — the user sees one continuous scrollable list with a correct scrollbar, not pages
