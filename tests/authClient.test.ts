// tests/authClient.test.ts
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type * as AuthClientType from '../src/auth/authClient';

// --- ESM-FRIENDLY MOCKING ---
// Type the mock function correctly.
const mockRequestQueueAdd = jest.fn<() => Promise<Response>>();

await jest.unstable_mockModule('../src/auth/authQueue.js', () => ({
    requestQueue: {
        add: mockRequestQueueAdd,
    },
}));

const { refreshSession, fetchTokenData } = await import('../src/auth/authClient.js') as typeof AuthClientType;

describe('Auth Client', () => {
    beforeEach(() => {
        mockRequestQueueAdd.mockClear();
    });

    describe('refreshSession', () => {
        it('should resolve with new ST and RT on a successful response', async () => {
            const mockResponse = {
                ok: true,
                headers: {
                    getSetCookie: () => [
                        'Tango-ST=new-st-token; Path=/; Secure; HttpOnly',
                        'Tango-RT=new-rt-token; Path=/; Secure; HttpOnly',
                    ],
                },
            };
            // Use `as unknown as Response` to satisfy TypeScript
            mockRequestQueueAdd.mockResolvedValue(mockResponse as unknown as Response);

            const result = await refreshSession('testuser', 'old-rt-token');

            expect(result).toEqual({
                newTangoST: 'new-st-token',
                newTangoRT: 'new-rt-token',
            });
        });

        it('should throw an error if the response is not ok', async () => {
            const mockResponse = { ok: false, status: 500 };
            mockRequestQueueAdd.mockResolvedValue(mockResponse as unknown as Response);

            await expect(refreshSession('testuser', 'any-rt')).rejects.toThrow(
                'Session refresh failed with status 500'
            );
        });

        it('should throw an error if the Tango-ST cookie is missing', async () => {
            const mockResponse = {
                ok: true,
                headers: { getSetCookie: () => ['Some-Other-Cookie=value'] },
            };
            mockRequestQueueAdd.mockResolvedValue(mockResponse as unknown as Response);

            await expect(refreshSession('testuser', 'any-rt')).rejects.toThrow(
                'Refresh endpoint did not return a new Tango-ST cookie'
            );
        });
    });

    describe('fetchTokenData', () => {
        it('should resolve with tt, ttu, and tte on a successful response', async () => {
            const mockResponse = {
                ok: true,
                headers: {
                    getSetCookie: () => [
                        'tt=tt-val; Path=/',
                        'ttu=ttu-val; Path=/',
                        'tte=tte-val; Path=/',
                    ],
                },
            };
            mockRequestQueueAdd.mockResolvedValue(mockResponse as unknown as Response);

            const result = await fetchTokenData('any-st-token');

            expect(result).toEqual({
                tt: 'tt-val',
                ttu: 'ttu-val',
                tte: 'tte-val',
            });
        });

        it('should throw an error if any stream token cookie is missing', async () => {
            const mockResponse = {
                ok: true,
                headers: {
                    getSetCookie: () => ['tt=tt-val;', 'tte=tte-val;'],
                },
            };
            mockRequestQueueAdd.mockResolvedValue(mockResponse as unknown as Response);

            await expect(fetchTokenData('any-st')).rejects.toThrow(
                'Token data response was missing one or more required cookies'
            );
        });
    });
});