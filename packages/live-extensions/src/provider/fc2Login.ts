// FC2's Login button is an anchor to /login/ in every site language. Follow the
// site's own link (including its return URL), without submitting the FC2 ID form.
export function autoClickFc2Login(): void {
    if (/^\/login\/?$/.test(location.pathname)) return;

    const attemptKey = "fc2-live:auto-login-clicked";
    try {
        // A failed session handoff can return to the same logged-out page.
        if (sessionStorage.getItem(attemptKey)) return;
    } catch { return; } // Without session storage we cannot enforce one attempt.

    const observer = new MutationObserver(clickLogin);
    // documentElement need not exist yet at document_start.
    observer.observe(document, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ["href", "class", "style", "hidden", "aria-disabled"],
    });
    clickLogin();

    function clickLogin(): void {
        const link = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).find(anchor => {
            if (anchor.origin !== location.origin || !/^\/login\/?$/.test(anchor.pathname)) return false;
            const rect = anchor.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
                && rect.top < innerHeight && rect.left < innerWidth
                && getComputedStyle(anchor).visibility === "visible"
                && !anchor.closest('[aria-disabled="true"], [inert]');
        });
        if (!link) return;
        observer.disconnect();
        try { sessionStorage.setItem(attemptKey, "1"); } catch { return; }
        link.click();
    }
}
