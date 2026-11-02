/** Fit the complete details block to the image, without changing the image or row width. */
export function fitBunkrText(details: HTMLElement, image: HTMLImageElement): { refresh: () => void; dispose: () => void } {
    let frame = 0, width = -1, disposed = false;
    function refresh(): void {
        if (disposed || frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            if (!details.isConnected || !details.clientWidth) return;
            const height = image.getBoundingClientRect().height;
            if (height <= 0) return;
            details.style.removeProperty("--album-font-size");
            if (details.getBoundingClientRect().height <= height) return;
            // Search for the largest size that keeps all text and the button visible.
            let low = 0.25, high = parseFloat(getComputedStyle(details).fontSize);
            for (let attempt = 0; attempt < 9; attempt++) {
                const size = (low + high) / 2;
                details.style.setProperty("--album-font-size", `${size}px`);
                if (details.getBoundingClientRect().height <= height) low = size; else high = size;
            }
            details.style.setProperty("--album-font-size", `${low}px`);
        });
    }
    const observer = new ResizeObserver(entries => {
        let changed = false;
        for (const entry of entries) {
            if (entry.target === image) changed = true;
            else if (entry.contentRect.width !== width) { width = entry.contentRect.width; changed = true; }
        }
        // Ignore our own text-height changes, so fitting cannot trigger a resize loop.
        if (changed) refresh();
    });
    observer.observe(image); observer.observe(details);
    return { refresh, dispose: () => { disposed = true; observer.disconnect(); cancelAnimationFrame(frame); } };
}
