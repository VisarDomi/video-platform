import { xvideos } from '../providers/xvideos.js';
import { startContentScript } from './boot.js';

// The Xvid app keeps the XVideos login durable natively.
startContentScript(xvideos, ['xvideos.com', 'www.xvideos.com']);
