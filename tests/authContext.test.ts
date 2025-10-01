// tests/authContext.test.ts
import { describe, it, expect } from '@jest/globals';
import { AuthContext } from '../src/auth/authContext';

describe('AuthContext', () => {

    it('should initialize with all tokens as null', () => {
        const authContext = new AuthContext();

        expect(authContext.getTangoRT()).toBeNull();
        expect(authContext.getTangoST()).toBeNull();
        expect(authContext.getTt()).toBeNull();
        expect(authContext.getTtu()).toBeNull();
        expect(authContext.getTte()).toBeNull();
    });

    describe('updateFromLogin', () => {
        it('should correctly set Tango-RT and Tango-ST from login results', () => {
            const authContext = new AuthContext();
            const loginResult = {
                tangoRT: 'login-rt-token',
                tangoST: 'login-st-token',
            };

            authContext.updateFromLogin(loginResult);

            expect(authContext.getTangoRT()).toBe('login-rt-token');
            expect(authContext.getTangoST()).toBe('login-st-token');
        });
    });

    describe('updateFromRefresh', () => {
        it('should update ST and RT and return true when a new RT is provided', () => {
            const authContext = new AuthContext();
            // Simulate having an old token
            authContext.updateFromLogin({ tangoRT: 'old-rt', tangoST: 'old-st' });

            const refreshResult = {
                newTangoST: 'refreshed-st-token',
                newTangoRT: 'new-rt-token',
            };

            const result = authContext.updateFromRefresh(refreshResult);

            expect(result).toBe(true);
            expect(authContext.getTangoST()).toBe('refreshed-st-token');
            expect(authContext.getTangoRT()).toBe('new-rt-token'); // Should be updated
        });

        it('should update only ST and return false when no new RT is provided', () => {
            const authContext = new AuthContext();
            authContext.updateFromLogin({ tangoRT: 'original-rt', tangoST: 'old-st' });

            const refreshResult = {
                newTangoST: 'refreshed-st-token',
                newTangoRT: null,
            };

            const result = authContext.updateFromRefresh(refreshResult);

            expect(result).toBe(false);
            expect(authContext.getTangoST()).toBe('refreshed-st-token');
            expect(authContext.getTangoRT()).toBe('original-rt'); // Should NOT be updated
        });
    });

    describe('updateFromTokenData', () => {
        it('should correctly set tt, ttu, and tte', () => {
            const authContext = new AuthContext();
            const tokenData = {
                tt: 'tt-token',
                ttu: 'ttu-token',
                tte: 'tte-token',
            };

            authContext.updateFromTokenData(tokenData);

            expect(authContext.getTt()).toBe('tt-token');
            expect(authContext.getTtu()).toBe('ttu-token');
            expect(authContext.getTte()).toBe('tte-token');
        });
    });

    describe('Header Generation', () => {
        it('getApiHeaders should throw if Tango-ST is missing', () => {
            const authContext = new AuthContext();
            expect(() => authContext.getApiHeaders()).toThrow('Tango-ST is missing');
        });

        it('getStreamHeaders should throw if stream tokens are missing', () => {
            const authContext = new AuthContext();
            expect(() => authContext.getStreamHeaders()).toThrow('tt, ttu, or tte are missing');
        });

        it('should generate correct API headers', () => {
            const authContext = new AuthContext();
            authContext.updateFromLogin({ tangoRT: 'any-rt', tangoST: 'my-st-token' });
            
            const headers = authContext.getApiHeaders();
            expect(headers).toEqual({ cookie: 'Tango-ST=my-st-token' });
        });

        it('should generate correct stream headers', () => {
            const authContext = new AuthContext();
            authContext.updateFromTokenData({ tt: 'a', ttu: 'b', tte: 'c' });

            const headers = authContext.getStreamHeaders();
            expect(headers).toEqual({ cookie: 'tt=a;ttu=b;tte=c' });
        });
    });
});