import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import logger from './logger.js';
import { PORT } from './config.js';
import archiveApiRouter from './video.routes.js';
import streamingRouter from './streaming.js';

// --- Helper Functions ---
const logServerInfo = () => {
    logger.info(`✓ Tango Dashboard server running.`);
    logger.info(`   Listening on port: ${PORT}`);
    const networkInterfaces = os.networkInterfaces();
    Object.keys(networkInterfaces).forEach(ifaceName => {
        networkInterfaces[ifaceName]?.forEach(iface => {
            if ('IPv4' === iface.family && !iface.internal) {
                logger.info(`   LAN Access: http://${iface.address}:${PORT}`);
            }
        });
    });
};

// --- Path Setup ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Express App Setup ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Routers ---
app.use('/api', archiveApiRouter);
app.use('/', streamingRouter);

// --- Serve Frontend ---
// This catch-all route ensures that any direct navigation to a frontend route
// is handled by the single-page application.
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- Start Server & Services ---
app.listen(PORT, '0.0.0.0', () => {
    logServerInfo();
});