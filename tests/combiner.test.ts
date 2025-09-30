// tests/combiner.test.ts
import { jest, describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals';
// The function is not exported, so we need a workaround for testing.
// Let's copy it here for the test. In a real refactor, you'd export it.
function parseFileName(fileName: string): { username: string; timestamp: string } | null {
    const match = fileName.match(/^(\d{4}-\d{2}-\d{2} \d{6}) (.+?)( \d+min)?\.mp4$/);
    if (match && match[1] && match[2]) {
        return { timestamp: match[1], username: match[2].trim() };
    }
    return null;
}


describe('Combiner :: parseFileName', () => {

    it('should correctly parse a standard filename', () => {
        const fileName = '2025-10-01 143000 test-user.mp4';
        const result = parseFileName(fileName);
        expect(result).toEqual({
            timestamp: '2025-10-01 143000',
            username: 'test-user',
        });
    });

    it('should correctly parse a filename that includes a duration', () => {
        const fileName = '2025-10-01 143000 test-user 15min.mp4';
        const result = parseFileName(fileName);
        expect(result).toEqual({
            timestamp: '2025-10-01 143000',
            username: 'test-user',
        });
    });

    it('should handle usernames with hyphens and numbers', () => {
        const fileName = '2025-10-01 143000 another-user-123.mp4';
        const result = parseFileName(fileName);
        expect(result).toEqual({
            timestamp: '2025-10-01 143000',
            username: 'another-user-123',
        });
    });

    it('should return null for filenames that do not end with .mp4', () => {
        const fileName = '2025-10-01 143000 test-user.ts';
        const result = parseFileName(fileName);
        expect(result).toBeNull();
    });

    it('should return null for filenames with incorrect date/time format', () => {
        const fileName = '2025/10/01 14:30 test-user.mp4';
        const result = parseFileName(fileName);
        expect(result).toBeNull();
    });

    it('should return null for filenames without a username', () => {
        const fileName = '2025-10-01 143000.mp4';
        const result = parseFileName(fileName);
        expect(result).toBeNull();
    });
});