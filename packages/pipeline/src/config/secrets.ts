import { promises as fs } from "node:fs";

function unquote(value: string): string {
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1);
    return value;
}

export async function readSecretFile(filePath: string): Promise<Record<string, string>> {
    const content = await fs.readFile(filePath, "utf8");
    const values: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const equals = line.indexOf("=");
        if (equals < 1) continue;
        values[line.slice(0, equals).trim()] = unquote(line.slice(equals + 1).trim());
    }
    return values;
}

export async function readXvideosCredentials(filePath: string): Promise<{ email: string; password: string }> {
    const values = await readSecretFile(filePath);
    const email = values.EMAIL_XVIDEOS?.trim();
    const password = values.PASSWORD_XVIDEOS;
    if (!email || !password) throw new Error("XVideos email/password are missing from the configured secret file");
    return { email, password };
}
