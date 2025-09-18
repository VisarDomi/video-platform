import { Router } from 'express';
import { promises as fsp } from 'fs';
import fs from 'fs';
import path from 'path';
import { findVideoPath } from './utils.js';
import logger from './logger.js';

const router = Router();


router.get('/video/:type/:filename', async (req, res) => {
  const { type, filename } = req.params as { type: 'original' | 'edited', filename: string };

  if (type !== 'original' && type !== 'edited') {
    return res.status(400).send('Invalid video type specified.');
  }

  const safeFilename = path.normalize(filename).replace(/^(\.\.[\/\\])+/, '');
  const foundVideo = await findVideoPath(type, safeFilename);

  if (!foundVideo) {
    logger.warn(`Video file not found in any directory: { type: ${type}, filename: ${safeFilename} }`);
    return res.status(404).send('Video file not found.');
  }

  const videoFilePath = foundVideo.fullPath;

  try {
    const stat = await fsp.stat(videoFilePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const contentType = 'video/mp4';

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      
      if (start >= fileSize) {
        res.status(416).send(`Requested range not satisfiable\n${start} >= ${fileSize}`);
        return;
      }

      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(videoFilePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = { 'Content-Length': fileSize, 'Content-Type': contentType };
      res.writeHead(200, head);
      fs.createReadStream(videoFilePath).pipe(res);
    }
  } catch (error) {
    logger.error(`Failed to stream video file at path: ${videoFilePath}`, { error });
    if (!res.headersSent) {
      res.status(500).send('Could not stream video file.');
    }
  }
});

export default router;