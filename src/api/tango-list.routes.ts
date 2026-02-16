import { Router } from "express";
import { promises as fs } from "fs";
import { createTxtListRoutes } from "./txt-list-routes.js";
import { TANGO_FILE_PATH } from "../core/config.js";
import { resolveAlias, fetchAliasesInBatch } from "../services/tango/apiClient.js";
import logger from "../core/logger.js";
import { cleanListContent } from "../core/content-processor.js";

const TANGO_URL_PREFIX = "https://tango.me/";
const baseRouter = createTxtListRoutes({ provider: "tango-list", filePath: TANGO_FILE_PATH, urlPrefix: "" });

const router = Router();

// Parse a tango.txt line: "https://tango.me/{accountId} {alias}" -> { accountId, alias }
function parseLine(line: string): { accountId: string; alias: string } | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(TANGO_URL_PREFIX)) return null;
    const rest = trimmed.slice(TANGO_URL_PREFIX.length);
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) return null;
    return { accountId: rest.slice(0, spaceIdx), alias: rest.slice(spaceIdx + 1) };
}

// Override list to return aliases from the new format
router.get("/api/tango-list/list", async (_req, res) => {
    try {
        const content = await fs.readFile(TANGO_FILE_PATH, "utf-8");
        const identifiers = content.split("\n")
            .map(line => parseLine(line))
            .filter((p): p is NonNullable<typeof p> => p !== null)
            .map(p => p.alias);
        res.json(identifiers);
    } catch {
        res.json([]);
    }
});

// Override add with smart alias resolution
router.post("/api/tango-list/add", async (req, res) => {
    const { identifier } = req.body;
    if (!identifier || typeof identifier !== "string") {
        return res.status(400).json({ error: "identifier required" });
    }
    try {
        // 1. Resolve alias -> accountId
        const resolved = await resolveAlias(identifier);
        if (!resolved) {
            return res.status(404).json({ error: "Could not resolve alias on tango" });
        }
        const { accountId } = resolved;

        // 2. Get latest alias for this accountId
        const profiles = await fetchAliasesInBatch([accountId]);
        const latestAlias = profiles?.[accountId]?.alias || identifier;

        // 3. Read current file
        let content = "";
        try { content = await fs.readFile(TANGO_FILE_PATH, "utf-8"); } catch {}

        const lines = content.split("\n");

        // 4. Check if accountId already exists
        const existingIndex = lines.findIndex(line => line.includes(accountId));

        if (existingIndex !== -1) {
            const existing = parseLine(lines[existingIndex]);
            if (existing?.alias === latestAlias) {
                logger.info(`tango-list skip: ${accountId} ${latestAlias} (already exists)`);
                return res.json({ success: true });
            }
            // Update alias
            lines[existingIndex] = `${TANGO_URL_PREFIX}${accountId} ${latestAlias}`;
            await fs.writeFile(TANGO_FILE_PATH, cleanListContent(lines.join("\n")), "utf-8");
            logger.info(`tango-list update: ${accountId} ${existing?.alias} -> ${latestAlias}`);
            return res.json({ success: true });
        }

        // 5. Add new entry
        const entry = `${TANGO_URL_PREFIX}${accountId} ${latestAlias}`;
        const newContent = cleanListContent(content + "\n" + entry);
        await fs.writeFile(TANGO_FILE_PATH, newContent, "utf-8");
        logger.info(`tango-list add: ${accountId} ${latestAlias}`);
        res.json({ success: true });
    } catch (error) {
        logger.error("Error adding to tango-list", { error });
        res.status(500).json({ error: "Failed to update file" });
    }
});

// Use base router for everything else (HTML editor, raw content, remove, save)
router.use(baseRouter);

export default router;
