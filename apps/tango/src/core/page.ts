import css from "../style.css?inline";

export function takeOverPage(mode: "rewrite" | "replace" = "rewrite"): void {
    window.stop();
    if (mode === "replace") document.documentElement?.replaceChildren();
    else {
        document.open();
        document.close();
    }
    if (!document.documentElement) document.appendChild(document.createElement('html'));
    if (!document.head) document.documentElement.appendChild(document.createElement('head'));
    if (!document.body) document.documentElement.appendChild(document.createElement('body'));
    const viewport = document.createElement("meta");
    viewport.name = "viewport";
    viewport.content = "width=device-width,initial-scale=1,viewport-fit=cover";
    document.head.append(viewport);
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
}

export function showStatus(message: string, error = false, links: { href: string; label: string }[] = []): void {
    document.body.replaceChildren();
    const status = document.createElement("p");
    status.className = error ? "status status-error" : "status";
    status.textContent = message;
    for (const { href, label } of links) {
        const link = document.createElement("a");
        link.href = href;
        link.textContent = label;
        status.append(document.createElement("br"), link);
    }
    document.body.append(status);
}
