import { porntrex } from '../providers/porntrex.js';
import { startContentScript } from './boot.js';

// The site's own remember-me cookie keeps the login.
startContentScript(porntrex, ['porntrex.com', 'www.porntrex.com']);
