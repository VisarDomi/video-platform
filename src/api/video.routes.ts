import { Router } from 'express';
import * as videoService from '../services/video.service.js';
import logger from '../logger.js';

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
        // Service throws a generic error, so we assume 404 if file not found.
        if (err.message.includes('not found')) {
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
         if (error.message.includes('not found')) {
            return res.status(404).json({ success: false, message: error.message });
        }
        res.status(500).json({ success: false, message: 'Failed to process video.' });
    }
});

export default router;