// tests/utils.test.ts
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import * as path from 'path';
import type { findProjectRoot as FindProjectRootType } from '../src/common/utils';

// --- THE CORRECTED ESM-FRIENDLY MOCKING PATTERN ---

const mockedExistsSync = jest.fn();

// This is the only part that changes.
jest.unstable_mockModule('fs', () => ({
    __esModule: true,
    // Provide a `default` property in our mock. The value of this property
    // is what the `fs` variable in utils.ts will become.
    default: {
        existsSync: mockedExistsSync,
    },
}));

// Dynamically import the function we want to test *after* the mock is in place.
const { findProjectRoot } = await import('../src/common/utils.js') as { findProjectRoot: typeof FindProjectRootType };

// --- TESTS (The test logic itself is unchanged) ---
describe('Common Utils :: findProjectRoot', () => {

    beforeEach(() => {
        mockedExistsSync.mockClear();
    });

    it('should find the project root in the starting directory', () => {
        const startDir = '/home/user/project';
        const packageJsonPath = path.join(startDir, 'package.json');
        
        mockedExistsSync.mockReturnValueOnce(true);

        const root = findProjectRoot(startDir);
        
        expect(root).toBe(startDir);
        expect(mockedExistsSync).toHaveBeenCalledWith(packageJsonPath);
    });

    it('should find the project root by searching upwards', () => {
        const rootDir = '/home/user/project';
        const startDir = path.join(rootDir, 'src', 'common');
        
        const pathsToCheck = [
            path.join(startDir, 'package.json'),
            path.join(path.dirname(startDir), 'package.json'),
            path.join(rootDir, 'package.json'),
        ];
        
        mockedExistsSync
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);

        const root = findProjectRoot(startDir);
        
        expect(root).toBe(rootDir);
        expect(mockedExistsSync).toHaveBeenCalledTimes(3);
        expect(mockedExistsSync).toHaveBeenCalledWith(pathsToCheck[0]);
        expect(mockedExistsSync).toHaveBeenCalledWith(pathsToCheck[1]);
        expect(mockedExistsSync).toHaveBeenCalledWith(pathsToCheck[2]);
    });

    it('should throw an error if package.json is not found up to the filesystem root', () => {
        const startDir = '/home/user/project';
        
        mockedExistsSync.mockReturnValue(false);
        
        expect(() => findProjectRoot(startDir)).toThrow('Could not find project root containing a package.json.');
    });
});