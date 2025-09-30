// tests/jest.setup.ts
import { jest } from '@jest/globals';
import type * as fs from 'fs';

// Mock fs.watch globally for all tests to prevent an open handle
// issue caused by a side-effect in src/common/config.ts.
jest.mock('fs', () => {
    const originalFs = jest.requireActual('fs') as typeof fs;
    return {
        ...originalFs,
        watch: jest.fn(),
    };
});