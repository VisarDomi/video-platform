// tests/requests.test.ts
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as requests from '../src/downloader/requests';
import * as constants from '../src/common/constants';

let fetchSpy: any;

const mockTokens: requests.Tokens = {
    st: 'mock-session-token',
    tt: 'mock-tt-token',
    ttu: 'mock-ttu-token',
    tte: 'mock-tte-token',
};

describe('Downloader :: requests', () => {

    beforeEach(() => {
        // Before each test, create a spy that watches `global.fetch`.
        // We provide a mock implementation to prevent actual network calls.
        fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({}),
            } as Response)
        );
    });

    afterEach(() => {
        // After each test, restore the original `fetch` function.
        // This is crucial for test isolation.
        fetchSpy.mockRestore();
    });

    describe('getFollowingResponseBody', () => {
        it('should call fetch with the correct URL and API headers', async () => {
            // Override the default mock for this specific test
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ success: true }),
            } as Response);

            await requests.getFollowingResponseBody(mockTokens);

            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('following?pageCount=0&pageSize=200'),
                expect.objectContaining({
                    method: 'GET',
                    headers: {
                        [constants.HEADERS.COOKIE]: `${constants.COOKIE_NAMES.TANGO_ST_PREFIX}${mockTokens.st}`
                    }
                })
            );
        });

        it('should return null if the fetch response is not ok', async () => {
             fetchSpy.mockResolvedValueOnce({ ok: false } as Response);

            const result = await requests.getFollowingResponseBody(mockTokens);
            expect(result).toBeNull();
        });
    });
    
    describe('getMasterList', () => {
        it('should call fetch with the correct URL and STREAM headers', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve('#EXTM3U'),
            } as Response);
            
            const testUrl = 'http://cinema.test/master.m3u8';
            await requests.getMasterList(testUrl, mockTokens);

            const expectedCookie = `tt=${mockTokens.tt};ttu=${mockTokens.ttu};tte=${mockTokens.tte}`;

            expect(fetch).toHaveBeenCalledWith(
                testUrl,
                expect.objectContaining({
                    method: 'GET',
                    headers: {
                        [constants.HEADERS.COOKIE]: expectedCookie,
                    }
                })
            );
        });
    });

    describe('getTsSegment', () => {
        it('should return a Buffer on a successful fetch', async () => {
            const mockArrayBuffer = new Uint8Array([1, 2, 3]).buffer;
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: () => Promise.resolve(mockArrayBuffer),
            } as Response);

            const result = await requests.getTsSegment('http://cinema.test/segment.ts');

            expect(result).toBeInstanceOf(Buffer);
            expect(result).toEqual(Buffer.from(mockArrayBuffer));
        });

        it('should return null if the fetch fails', async () => {
            fetchSpy.mockRejectedValueOnce(new Error('Network error'));
            
            const result = await requests.getTsSegment('http://cinema.test/segment.ts');
            
            expect(result).toBeNull();
        });
    });
});