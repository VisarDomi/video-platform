import css from "../style.css?inline";

export function takeOverPage(): void {
    window.stop();
    document.open();
    document.close();
    const viewport = document.createElement("meta");
    viewport.name = "viewport";
    viewport.content = "width=device-width,initial-scale=1,viewport-fit=cover";
    document.head.append(viewport);
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
}

export function showStatus(message: string, error = false): void {
    document.body.replaceChildren();
    const status = document.createElement("p");
    status.className = error ? "status status-error" : "status";
    status.textContent = message;
    document.body.append(status);
}
