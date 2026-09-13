import { saveState as saveSharedState, type SharedState } from '../../../src/core/state';
export { loadState, isPageReload } from '../../../src/core/state';

// Persist at the source's actual state transition, including asynchronous stream
// removal/discovery. A click or scroll event may precede that transition.
export function saveState(state: SharedState): void {
    saveSharedState(state);
    dispatchEvent(new Event('viewer-state-changed'));
}
