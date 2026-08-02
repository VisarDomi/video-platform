export interface GestureCallbacks {
    verticalStart(): void;
    controls(visible: boolean): void;
}

export function attachGestures(element: HTMLElement, callbacks: GestureCallbacks): void {
    let startX = 0;
    let startY = 0;
    let axis: "none" | "x" | "y" | "browser" = "none";
    const edgeWidth = 28;

    element.addEventListener("touchstart", event => {
        if (event.touches.length > 1) {
            axis = "browser";
            return;
        }
        if (event.touches.length !== 1) return;
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
        axis = startX <= edgeWidth ? "browser" : "none";
    }, { passive: true, capture: true });

    element.addEventListener("touchmove", event => {
        if (axis === "browser") return;
        if (event.touches.length > 1) {
            axis = "browser";
            return;
        }
        if (event.touches.length !== 1) return;
        const dx = event.touches[0].clientX - startX;
        const dy = event.touches[0].clientY - startY;
        if (axis === "none" && Math.max(Math.abs(dx), Math.abs(dy)) > 8) {
            axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
            if (axis === "y") callbacks.verticalStart();
        }
        if (axis === "x") {
            event.preventDefault();
        }
    }, { passive: false, capture: true });

    element.addEventListener("touchend", event => {
        if (axis === "browser") {
            if (event.touches.length === 0) axis = "none";
            return;
        }
        const dx = event.changedTouches[0].clientX - startX;
        if (axis === "x" && Math.abs(dx) > 80) callbacks.controls(dx > 0);
        axis = "none";
    }, { capture: true });

    element.addEventListener("touchcancel", () => {
        axis = "none";
    }, { capture: true });
}
