// tests/storage.test.ts
import { jest, describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { createDownloadPaths as CreateDownloadPathsType } from '../src/common/storage';

// --- THE NEW ESM-FRIENDLY MOCKING PATTERN ---

// 1. We create our mock function and GIVE IT A DEFAULT IMPLEMENTATION.
//    This default will be used when `logger.ts` is first imported.
const mockGetConfig = jest.fn().mockReturnValue({
    fileNames: {
        errorLog: 'test-error.log' // Provide a dummy value for initialization
    },
    // We can provide other defaults if needed, but fileNames is the one causing the crash.
});

// 2. We use the new API to mock the module BEFORE importing any code that uses it.
await jest.unstable_mockModule('../src/common/config.js', () => ({
    __esModule: true,
    getConfig: mockGetConfig,
}));

// 3. We can now dynamically import the module we want to test.
const { createDownloadPaths } = await import('../src/common/storage.js') as { createDownloadPaths: typeof CreateDownloadPathsType };


// --- TESTS (The test logic itself is unchanged) ---
describe('Storage :: createDownloadPaths', () => {
    let tempTestDir: string;
    
    beforeAll(() => {
        tempTestDir = path.join(os.tmpdir(), 'tango-downloader-storage-test');
    });

    beforeEach(() => {
        // This will OVERRIDE the default mock for each test with the specific
        // value needed for the test.
        mockGetConfig.mockReturnValue({
            storagePath: tempTestDir,
            fileNames: {
                errorLog: 'test-error.log'
            }
        });

        if (fs.existsSync(tempTestDir)) {
            fs.rmSync(tempTestDir, { recursive: true, force: true });
        }
    });
    
    afterEach(() => {
        mockGetConfig.mockClear();
    });

    it('should return correctly formatted paths for a given alias and date', () => {
        const alias = 'test-streamer';
        const date = new Date(2024, 4, 15, 10, 30, 0);
        
        const paths = createDownloadPaths(alias, date);

        const expectedBaseName = '2024-05-15 103000 test-streamer';
        
        expect(paths.tsFilePath).toBe(path.join(tempTestDir, `${expectedBaseName}.ts`));
        expect(paths.segmentsDirPath).toBe(path.join(tempTestDir, expectedBaseName));
    });

    it('should create the main storage directory if it does not exist', () => {
        const alias = 'another-streamer';
        const date = new Date();

        expect(fs.existsSync(tempTestDir)).toBe(false);
        
        createDownloadPaths(alias, date);

        expect(fs.existsSync(tempTestDir)).toBe(true);
    });

    it('should create the specific segments directory for the stream', () => {
        const alias = 'final-streamer';
        const date = new Date();
        
        const paths = createDownloadPaths(alias, date);

        if (fs.existsSync(paths.segmentsDirPath)) {
             fs.rmSync(paths.segmentsDirPath, { recursive: true, force: true });
        }
        expect(fs.existsSync(paths.segmentsDirPath)).toBe(false);

        createDownloadPaths(alias, date);
        
        expect(fs.existsSync(paths.segmentsDirPath)).toBe(true);
    });
});