import { tangoLive } from '../providers/tango-live.js';
import { startContentScript } from './boot.js';

// The Tango app moves its Safari login into its web view before this runs.
startContentScript(tangoLive, ['tango.me', 'www.tango.me']);
