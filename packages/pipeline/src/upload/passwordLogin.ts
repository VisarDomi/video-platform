import type { Page } from "playwright";

// Never send credentials to a redirect, social-login popup, or ambiguous form.
// Both supported destinations use a native username/email + password form.
export async function submitPasswordLogin(
    page: Page,
    origin: string,
    credentials: { email: string; password: string },
): Promise<void> {
    if (new URL(page.url()).origin !== origin) throw new Error("Native login left the expected provider origin");
    const forms = page.locator('form:has(input[type="password"])');
    const visible = [];
    for (const form of await forms.all()) if (await form.isVisible()) visible.push(form);
    if (visible.length !== 1) throw new Error("Expected one visible native password login form");
    const form = visible[0];
    const action = await form.getAttribute("action");
    if (action && new URL(action, page.url()).origin !== origin) {
        throw new Error("Native login form submits to an unexpected origin");
    }
    const passwords = form.locator('input[type="password"]');
    let identifiers = form.locator('input:not([type="hidden"]):is([type="email"], [autocomplete="username"], [name="username"], [name*="email" i], [name="login"])');
    if (!await identifiers.count()) identifiers = form.locator('input[type="text"]');
    if (await passwords.count() !== 1 || await identifiers.count() !== 1) {
        throw new Error("Native login fields are ambiguous; manual login required");
    }
    const submit = form.locator('button[type="submit"], input[type="submit"], button:not([type])');
    if (await submit.count() !== 1) throw new Error("Native login submit control is ambiguous");
    // Origin is checked immediately before credential entry as well.
    if (new URL(page.url()).origin !== origin) throw new Error("Native login origin changed");
    await identifiers.fill(credentials.email);
    if (new URL(page.url()).origin !== origin) throw new Error("Native login origin changed before password entry");
    await passwords.fill(credentials.password);
    const remember = form.locator('input[type="checkbox"][name="remember_me"]');
    if (await remember.count() === 1 && await remember.isVisible()) await remember.check();
    if (new URL(page.url()).origin !== origin) throw new Error("Native login origin changed before submission");
    await submit.click();
}
