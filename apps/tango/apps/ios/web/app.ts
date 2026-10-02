import { installMediaRecovery } from './media-recovery';
import { provider } from '@selected-provider';
import { startViewer, showStartupError } from '../../../src/core/start';
import { native } from './native';

installMediaRecovery(true);

const documentID = crypto.randomUUID();
let ready = false;
let homeY = 0;
const save = async () => {
    if (!ready) return;
    if (location.pathname === '/') homeY = scrollY;
    await native('save', {document:documentID, homeY});
};
(window as any).streamViewerApp = {save};
addEventListener('scrollend', () => queueMicrotask(() => void save()));
addEventListener('change', () => void save());
addEventListener('click', () => queueMicrotask(() => void save()));
addEventListener('pagehide', () => void save());
addEventListener('pageshow', event => {
    if (event.persisted) void native('activate',{document:documentID}).then(() => { ready=true; return save(); });
});
// UIKit suspends network maintenance. Keep the user's pause/mute choices when
// returning; don't start previously paused or unloaded neighboring videos.
let playing: HTMLVideoElement[] = [];
addEventListener('viewer-background', () => {
    playing = [...document.querySelectorAll('video')].filter(video => !video.paused);
    for (const video of playing) video.pause();
    void save();
});
addEventListener('viewer-foreground', () => {
    for (const video of playing) if (video.isConnected && video.getAttribute('src')) void video.play().catch(() => {});
    playing = [];
});

async function main() {
    const checkpoint = await native('init',{document:documentID});
    homeY = checkpoint.homeY ?? 0;
    await startViewer(provider);
    const back = performance.getEntriesByType('navigation').some(entry =>
        (entry as PerformanceNavigationTiming).type === 'back_forward');
    if (back && location.pathname === '/') {
        await new Promise(requestAnimationFrame); scrollTo(0,homeY);
    }
    ready=true; await save();
}
void main().catch(error => {
    showStartupError(provider, error instanceof Error ? error.message : 'Unable to load streams.');
    const retry=document.createElement('a'); retry.href=location.pathname; retry.textContent='Retry';
    document.querySelector('.status')?.append(document.createElement('br'),retry);
});
