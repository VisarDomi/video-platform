// tests/assemblerUtils.test.ts
import { jest, describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals';
import { parseDownloadFolderName } from "../src/assembler/assemblerUtils";

describe("parseDownloadFolderName", () => {
    it("should correctly parse a valid folder name", () => {
        const folderName = "2025-09-30 235828 nonameim";
        const result = parseDownloadFolderName(folderName);
        expect(result).toEqual({
            dateString: "2025-09-30 235828",
            alias: "nonameim",
        });
    });

    it("should return null for an invalid folder name", () => {
        const folderName = "my-random-folder";
        const result = parseDownloadFolderName(folderName);
        expect(result).toBeNull();
    });
});
