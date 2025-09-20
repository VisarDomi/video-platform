// src/api/video.routes.ts
import { Router } from 'express';
import * as videoService from '../services/video.service.js';
import logger from '../logger.js';
import { FileNotFoundError } from '../errors.js';

const router = Router();

/**
 * GET /api/videos
 * Retrieves a list of all original and edited videos.
 */
router.get('/videos', async (req, res) => {
  try {
    const allFiles = await videoService.getAllVideos();
    res.json(allFiles);
  } catch (error: any) {
    logger.error(`Error listing video directories:`, { error });
    res.status(500).json({ success: false, message: 'Could not list video directories.' });
  }
});

/**
 * GET /api/videos/durations
 * Retrieves a map of filenames to their duration in seconds.
 */
router.get('/videos/durations', async (req, res) => {
    try {
        const durations = await videoService.getAllVideoDurations();
        res.json(durations);
    } catch (error: any) {
        logger.error(`Error getting video durations:`, { error });
        res.status(500).json({ success: false, message: 'Could not retrieve video durations.' });
    }
});


/**
 * DELETE /api/videos/:type/:filename
 * Moves a specified video file to a 'trash' directory.
 */
router.delete('/videos/:type/:filename', async (req, res) => {
    const { type, filename } = req.params as { type: 'original' | 'edited', filename: string };

    if (!filename || (type !== 'original' && type !== 'edited')) {
        return res.status(400).json({ success: false, message: 'Invalid request parameters.' });
    }
    
    try {
        await videoService.trashVideo(type, filename);
        res.json({ success: true, message: 'Video moved to trash successfully.' });
    } catch (err: any) {
        logger.error('Error in trashVideo route:', { file: filename, err });
        if (err instanceof FileNotFoundError) {
            return res.status(404).json({ success: false, message: err.message });
        }
        res.status(500).json({ success: false, message: 'Failed to move video to trash.' });
    }
});


/**
 * POST /api/edit
 * Creates a new, edited video from segments of an original video.
 */
router.post('/edit', async (req, res) => {
    const { filename, segments }: { filename: string, segments: {start: number, end: number}[] } = req.body;

    if (!filename || !segments || segments.length === 0) {
        return res.status(400).json({ success: false, message: 'Invalid request: filename and segments are required.' });
    }

    try {
        await videoService.createEditedVideo(filename, segments);
        res.json({ success: true, message: 'Created edited video and moved original to trash.' });
    } catch (error: any) {
        logger.error(`Failed to process video ${filename}:`, { error });
         if (error instanceof FileNotFoundError) {
            return res.status(404).json({ success: false, message: error.message });
        }
        res.status(500).json({ success: false, message: 'Failed to process video.' });
    }
});

export default router;