import { tangoLive } from '../providers/tango-live.js';
import { startExtension } from './boot.js';

// The Tango app moves its Safari login into its web view; there is no background worker.
startExtension(tangoLive, ['tango.me', 'www.tango.me']);
