import { porntrex } from '../providers/porntrex.js';
import { startExtension } from './boot.js';

// The site's own remember-me cookie keeps the login; no background worker.
startExtension(porntrex, ['porntrex.com', 'www.porntrex.com']);
