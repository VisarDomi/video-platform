// tests/jest.setup.ts
import { jest } from '@jest/globals';
import type * as fs from 'fs';

// --- NEW MOCK FOR THE LOGGER ---
// This runs before ALL test suites. It replaces the real logger with a fake one.
// This prevents Winston from creating file transports and holding open handles.
jest.mock('../src/common/logger.js', () => ({
    __esModule: true,
    // The logger is a default export, so we mock `default`.
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        verbose: jest.fn(),
    },
}));

// --- NEW MOCK TO SILENCE CONSOLE OUTPUT IN TESTS ---
// This prevents `console.log` from cluttering your test results.
global.console = {
    ...console,
    log: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

// Mock fs.watch globally for all tests to prevent an open handle
// issue caused by a side-effect in src/common/config.ts.
jest.mock('fs', () => {
    const originalFs = jest.requireActual('fs') as typeof fs;
    return {
        ...originalFs,
        watch: jest.fn(),
    };
});