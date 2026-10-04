import { PORNTREX_HOSTS, XVIDEOS_HOSTS, VAULT_URL, vault, vaultRoute, vaultSites } from '../providers/vault.js';
import { startContentScript } from './boot.js';

// Video Vault (formerly Ptrex) lives on porntrex.com; any other Porntrex page opens its vault
// page. XVideos opens only to log in, then returns to the vault.
if (!window.opener && PORNTREX_HOSTS.includes(location.hostname)) {
    const route = vaultRoute(location.pathname);
    if (route !== location.pathname) location.replace(route);
    else startContentScript(vault, PORNTREX_HOSTS);
} else if (!window.opener && XVIDEOS_HOSTS.includes(location.hostname)) {
    const route = vaultSites.xvideos.matchRoute(location.pathname);
    if (route === 'login') void vaultSites.xvideos.waitForLogin();
    else if (route) location.replace(VAULT_URL);
}
