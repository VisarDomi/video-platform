// tests/hlsUtils.test.ts
import { describe, it, expect } from '@jest/globals';
import { findBestStreamUrl } from '../src/downloader/hlsUtils.js';

// A realistic mock of a master playlist file from the service.
const mockMasterPlaylist = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=448000,RESOLUTION=426x240,CODECS="avc1.42c01e,mp4a.40.2"
/v2/broadcaster-sessions/12345/playlist.m3u8?token=abc&stream=low
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1280000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"
/v2/broadcaster-sessions/12345/playlist.m3u8?token=abc&stream=mid
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2560000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2"
/v2/broadcaster-sessions/12345/playlist.m3u8?token=abc&stream=high
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=5120000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
/v2/broadcaster-sessions/12345/playlist.m3u8?token=abc&stream=fullhd
`;

describe('HLS Utilities :: findBestStreamUrl (Current Logic)', () => {

    it('should find and return the relative URL for the 720p stream', () => {
        const expectedUrl = '/v2/broadcaster-sessions/12345/playlist.m3u8?token=abc&stream=high';
        const result = findBestStreamUrl(mockMasterPlaylist);
        expect(result).toBe(expectedUrl);
    });

    it('should return null if no 720p stream is found in the playlist', () => {
        const playlistWithout720p = mockMasterPlaylist.replace(/#EXT-X-STREAM-INF:.*RESOLUTION=1280x720.*\s*.*stream=high\s*/, '');
        const result = findBestStreamUrl(playlistWithout720p);
        expect(result).toBeNull();
    });

    it('should return null for an empty or invalid playlist string', () => {
        expect(findBestStreamUrl('')).toBeNull();
        expect(findBestStreamUrl('#EXTM3U')).toBeNull();
    });

    it('should correctly handle a playlist where the 720p stream is the first entry', () => {
        const reversedPlaylist = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2560000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2"
/v2/broadcaster-sessions/12345/playlist.m3u8?token=abc&stream=high
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=448000,RESOLUTION=426x240,CODECS="avc1.42c01e,mp4a.40.2"
/v2/broadcaster-sessions/12345/playlist.m3u8?token=abc&stream=low`;
        const expectedUrl = '/v2/broadcaster-sessions/12345/playlist.m3u8?token=abc&stream=high';
        const result = findBestStreamUrl(reversedPlaylist);
        expect(result).toBe(expectedUrl);
    });
});