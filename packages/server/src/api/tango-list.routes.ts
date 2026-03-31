import { Router } from "express";
import { promises as fs } from "fs";
import { createTxtListRoutes } from "./txt-list-routes.js";
import { TANGO_FILE_PATH, ALIASES_PATH } from "../core/config.js";
import { resolveAlias, fetchAliasesInBatch } from "../services/tango/apiClient.js";
import { AliasRegistry } from "shared";
import logger from "../core/logger.js";
import { cleanListContent } from "../core/content-processor.js";

const TANGO_URL_PREFIX = "https://tango.me/";
const baseRouter = createTxtListRoutes({ provider: "tango", filePath: TANGO_FILE_PATH, urlPrefix: "" });
const registry = new AliasRegistry(ALIASES_PATH);
void registry.load();

const router = Router();

function parseLine(line: string): { accountId: string; alias: string } | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(TANGO_URL_PREFIX)) return null;
    const rest = trimmed.slice(TANGO_URL_PREFIX.length);
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) return null;
    return { accountId: rest.slice(0, spaceIdx), alias: rest.slice(spaceIdx + 1) };
}

router.get("/api/tango/list", async (_req, res) => {
    try {
        const content = await fs.readFile(TANGO_FILE_PATH, "utf-8");
        const parsed = content.split("\n")
            .map(line => parseLine(line))
            .filter((p): p is NonNullable<typeof p> => p !== null);

        // Reload from disk to pick up downloader's latest writes
        await registry.load();
        const allAliases = registry.getAllWithHistory();
        const identifiers = new Set<string>();

        for (const { accountId, alias } of parsed) {
            identifiers.add(accountId);
            identifiers.add(alias);
            const cached = allAliases[accountId];
            if (cached) {
                for (const a of cached) identifiers.add(a);
            }
        }

        res.json([...identifiers]);
    } catch {
        res.json([]);
    }
});

router.post("/api/tango/remove", async (req, res) => {
    const { identifier } = req.body;
    if (!identifier || typeof identifier !== "string") {
        return res.status(400).json({ error: "identifier required" });
    }
    try {
        const content = await fs.readFile(TANGO_FILE_PATH, "utf-8");
        const reverse = registry.getReverse();
        const accountId = reverse[identifier];

        const lines = content.split("\n").filter(line => {
            if (accountId) {
                return !line.includes(accountId);
            }
            return !line.includes(identifier);
        });

        await fs.writeFile(TANGO_FILE_PATH, cleanListContent(lines.join("\n")), "utf-8");
        logger.info(`tango remove: ${identifier}${accountId ? ` (accountId: ${accountId})` : ""}`);
        res.json({ success: true });
    } catch (error) {
        logger.error("Error removing from tango file", { error });
        res.status(500).json({ error: "Failed to update file" });
    }
});

router.post("/api/tango/add", async (req, res) => {
    const { identifier } = req.body;
    if (!identifier || typeof identifier !== "string") {
        return res.status(400).json({ error: "identifier required" });
    }
    try {
        const resolved = await resolveAlias(identifier);
        if (!resolved) {
            return res.status(404).json({ error: "Could not resolve alias on tango" });
        }
        const { accountId } = resolved;

        const profiles = await fetchAliasesInBatch([accountId]);
        const latestAlias = profiles?.[accountId]?.alias || identifier;

        let content = "";
        try { content = await fs.readFile(TANGO_FILE_PATH, "utf-8"); } catch {}

        const lines = content.split("\n");

        const existingIndex = lines.findIndex(line => line.includes(accountId));

        if (existingIndex !== -1) {
            const existing = parseLine(lines[existingIndex]);
            if (existing?.alias === latestAlias) {
                logger.info(`tango skip: ${accountId} ${latestAlias} (already exists)`);
                return res.json({ success: true });
            }
            lines[existingIndex] = `${TANGO_URL_PREFIX}${accountId} ${latestAlias}`;
            await fs.writeFile(TANGO_FILE_PATH, cleanListContent(lines.join("\n")), "utf-8");
            logger.info(`tango update: ${accountId} ${existing?.alias} -> ${latestAlias}`);
            return res.json({ success: true });
        }

        const entry = `${TANGO_URL_PREFIX}${accountId} ${latestAlias}`;
        const newContent = cleanListContent(content + "\n" + entry);
        await fs.writeFile(TANGO_FILE_PATH, newContent, "utf-8");
        logger.info(`tango add: ${accountId} ${latestAlias}`);
        res.json({ success: true });
    } catch (error) {
        logger.error("Error adding to tango", { error });
        res.status(500).json({ error: "Failed to update file" });
    }
});

router.post("/api/tango", async (req, res) => {
    const { content } = req.body;
    if (typeof content !== "string") {
        return res.status(400).send("Invalid content");
    }
    try {
        const lines = content.split("\n");
        const resolved: string[] = [];

        for (const raw of lines) {
            const trimmed = raw.trim();
            if (!trimmed || trimmed.startsWith("#")) {
                resolved.push(raw);
                continue;
            }
            if (parseLine(trimmed)) {
                resolved.push(raw);
                continue;
            }
            const alias = trimmed;
            const result = await resolveAlias(alias);
            if (!result) {
                logger.warn(`tango save: could not resolve "${alias}", skipping`);
                continue;
            }
            const profiles = await fetchAliasesInBatch([result.accountId]);
            const latestAlias = profiles?.[result.accountId]?.alias || alias;
            const entry = `${TANGO_URL_PREFIX}${result.accountId} ${latestAlias}`;
            resolved.push(entry);
            logger.info(`tango save: resolved "${alias}" -> ${entry}`);
        }

        await fs.writeFile(TANGO_FILE_PATH, cleanListContent(resolved.join("\n")), "utf-8");
        logger.info("tango file updated via web editor (smart save)");
        res.sendStatus(200);
    } catch (error) {
        logger.error("Error saving tango file", { error });
        res.status(500).send("Error saving file");
    }
});

router.use(baseRouter);

export default router;
