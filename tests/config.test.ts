// tests/config.test.ts
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import * as path from 'path';
import type { IConfig } from '../src/common/config';
import type { PathLike } from 'fs'; // <-- 1. IMPORT THE TYPE

// --- MOCKS ---
const mockExistsSync = jest.fn<(...args: any[]) => boolean>();
const mockMkdirSync = jest.fn();
const mockHomedir = jest.fn().mockReturnValue('/fake/home');
const mockReadFileSync = jest.fn().mockReturnValue('{}');
const mockWatch = jest.fn();

// Mock the utils module
jest.unstable_mockModule('../src/common/utils.js', () => ({
    __esModule: true,
    findProjectRoot: jest.fn().mockReturnValue('/fake/project/root'),
}));

// Mock the 'fs' module
jest.unstable_mockModule('fs', () => ({
    __esModule: true,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    mkdirSync: mockMkdirSync,
    watch: mockWatch,
}));

// Mock the 'os' module
jest.unstable_mockModule('os', () => ({
    __esModule: true,
    homedir: mockHomedir,
}));

// Dynamically import the config module
const { getConfig } = await import('../src/common/config.js') as { getConfig: () => IConfig };


// --- TESTS ---
describe('Common :: config', () => {

    beforeEach(() => {
        // Reset mocks before each test
        mockExistsSync.mockReset();
        mockMkdirSync.mockReset();
        mockHomedir.mockReset().mockReturnValue('/fake/home');
        mockReadFileSync.mockReset().mockReturnValue('{}');
        mockWatch.mockReset();
    });

    it('should correctly calculate the default sharedStatePath based on the user home directory', () => {
        mockExistsSync.mockReturnValue(false);
        const config = getConfig();
        const expectedPath = path.join('/fake/home', '.local', 'share', 'tango-services');
        expect(config.sharedStatePath).toBe(expectedPath);
    });

    it('should create the shared state directory if it does not exist', async () => {
        mockExistsSync.mockReturnValue(false);
        await import('../src/common/config.js?bustcache=' + Date.now());
        const expectedPath = path.join('/fake/home', '.local', 'share', 'tango-services');
        expect(mockMkdirSync).toHaveBeenCalledWith(expectedPath, { recursive: true });
    });

    it('should NOT attempt to create the shared state directory if it already exists', async () => {
        mockExistsSync.mockImplementation((p) => {
            if (typeof p === 'string' && p.includes('.local/share/tango-services')) {
                return true;
            }
            return false;
        });
        await import('../src/common/config.js?bustcache=' + Date.now());
        expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it('should allow a user-defined config.json to override the default sharedStatePath', async () => {
        // --- THE FINAL FIX ---
        // Provide a generic to jest.fn() to tell it what function signature we're mocking.
        // This makes TypeScript happy.
        const smartExistsSync = jest.fn<(path: PathLike) => boolean>().mockImplementation((p) => {
            // Now `p` is correctly typed, but we still need to check if it's a string
            if (typeof p === 'string' && p.endsWith('config.json')) {
                return true;
            }
            return false;
        });

        jest.unstable_mockModule('fs', () => ({
            __esModule: true,
            existsSync: smartExistsSync, // Use the smart mock
            readFileSync: jest.fn().mockReturnValue(JSON.stringify({
                sharedStatePath: "/custom/path/from/user"
            })),
            mkdirSync: mockMkdirSync,
            watch: mockWatch,
        }));

        // WHEN we reload the config module
        await import('../src/common/config.js?bustcache=' + Date.now());

        // THEN it should attempt to create that custom directory
        expect(mockMkdirSync).toHaveBeenCalledWith("/custom/path/from/user", { recursive: true });
    });
});