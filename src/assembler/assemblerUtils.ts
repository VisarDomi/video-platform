// src/assembler/assemblerUtils.ts
const FOLDER_NAME_REGEX = /^(\d{4}-\d{2}-\d{2} \d{6}) (.+)$/;
export function parseDownloadFolderName(folderName: string): { alias: string; dateString: string } | null {
    const match = folderName.match(FOLDER_NAME_REGEX);
    if (!match) {
        return null;
    }
    return {
        dateString: match[1],
        alias: match[2],
    };
}
