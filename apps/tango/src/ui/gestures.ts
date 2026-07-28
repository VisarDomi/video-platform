export interface GestureCallbacks {
    move(delta: number): void;
    release(delta: number): void;
    controls(visible: boolean): void;
}

export function attachGestures(element: HTMLElement, callbacks: GestureCallbacks): void {
    let startX = 0;
    let startY = 0;
    let axis: "none" | "x" | "y" = "none";

    element.addEventListener("touchstart", event => {
        if (event.touches.length !== 1) return;
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
        axis = "none";
    }, { passive: true });

    element.addEventListener("touchmove", event => {
        if (event.touches.length !== 1) return;
        const dx = event.touches[0].clientX - startX;
        const dy = event.touches[0].clientY - startY;
        if (axis === "none" && Math.max(Math.abs(dx), Math.abs(dy)) > 8) {
            axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
        }
        if (axis === "y") {
            event.preventDefault();
            callbacks.move(dy);
        }
    }, { passive: false });

    element.addEventListener("touchend", event => {
        const dx = event.changedTouches[0].clientX - startX;
        const dy = event.changedTouches[0].clientY - startY;
        if (axis === "y") callbacks.release(dy);
        else if (axis === "x" && Math.abs(dx) > 80) callbacks.controls(dx > 0);
        axis = "none";
    });
}
