import { Router } from "express";
import { promises as fs } from "fs";
import { SC_FILE_PATH } from "../core/config.js";
import { resolveScUsername } from "../services/sc/apiClient.js";
import logger from "../core/logger.js";
import { cleanListContent } from "../core/content-processor.js";

const SC_URL_PREFIX = "https://stripchat.com/";

function parseLine(line: string): { username: string; roomId: string } | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(SC_URL_PREFIX)) return null;
    const rest = trimmed.slice(SC_URL_PREFIX.length);
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) return { username: rest.replace(/\/$/, ""), roomId: "" };
    return { username: rest.slice(0, spaceIdx), roomId: rest.slice(spaceIdx + 1) };
}

function parseUsername(identifier: string): string {
    if (identifier.includes("stripchat.com/")) {
        const parts = identifier.split("stripchat.com/");
        if (parts[1]) return parts[1].split("/")[0].split("?")[0];
    }
    return identifier;
}

const router = Router();

router.get("/api/sc/list", async (_req, res) => {
    try {
        const content = await fs.readFile(SC_FILE_PATH, "utf-8");
        const identifiers = content.split("\n")
            .map(line => parseLine(line))
            .filter((p): p is NonNullable<typeof p> => p !== null)
            .map(p => p.username);
        res.json(identifiers);
    } catch {
        res.json([]);
    }
});

router.get("/api/sc", async (_req, res) => {
    try {
        const content = await fs.readFile(SC_FILE_PATH, "utf-8");
        res.type("text/plain").send(content);
    } catch (error: any) {
        if (error.code === "ENOENT") return res.type("text/plain").send("");
        logger.error("Error reading sc file", { error });
        res.status(500).send("Error reading file");
    }
});

router.post("/api/sc/add", async (req, res) => {
    const { identifier } = req.body;
    if (!identifier || typeof identifier !== "string") {
        return res.status(400).json({ error: "identifier required" });
    }

    try {
        const username = parseUsername(identifier);
        const resolved = await resolveScUsername(username);
        if (!resolved) {
            return res.status(404).json({ error: `Could not resolve username: ${username}` });
        }

        let content = "";
        try { content = await fs.readFile(SC_FILE_PATH, "utf-8"); } catch {}

        const lines = content.split("\n");

        const existingIndex = lines.findIndex(line => line.includes(resolved.roomId));

        if (existingIndex !== -1) {
            const existing = parseLine(lines[existingIndex]);
            if (existing?.username === resolved.username) {
                logger.info(`sc skip: ${resolved.username} ${resolved.roomId} (already exists)`);
                return res.json({ success: true });
            }
            lines[existingIndex] = `${SC_URL_PREFIX}${resolved.username} ${resolved.roomId}`;
            await fs.writeFile(SC_FILE_PATH, cleanListContent(lines.join("\n")), "utf-8");
            logger.info(`sc update: ${existing?.username} -> ${resolved.username} (roomId=${resolved.roomId})`);
            return res.json({ success: true });
        }

        const entry = `${SC_URL_PREFIX}${resolved.username} ${resolved.roomId}`;
        const newContent = cleanListContent(content + "\n" + entry);
        await fs.writeFile(SC_FILE_PATH, newContent, "utf-8");
        logger.info(`sc add: ${resolved.username} ${resolved.roomId}`);
        res.json({ success: true });
    } catch (error) {
        logger.error("Error adding to sc", { error });
        res.status(500).json({ error: "Failed to update file" });
    }
});

router.post("/api/sc/remove", async (req, res) => {
    const { identifier } = req.body;
    if (!identifier || typeof identifier !== "string") {
        return res.status(400).json({ error: "identifier required" });
    }
    try {
        const username = parseUsername(identifier);
        const content = await fs.readFile(SC_FILE_PATH, "utf-8");
        const lines = content.split("\n").filter(line => !line.includes(username));
        await fs.writeFile(SC_FILE_PATH, cleanListContent(lines.join("\n")), "utf-8");
        logger.info(`sc remove: ${identifier}`);
        res.json({ success: true });
    } catch (error) {
        logger.error("Error removing from sc file", { error });
        res.status(500).json({ error: "Failed to update file" });
    }
});

router.post("/api/sc", async (req, res) => {
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
            const parsed = parseLine(trimmed);
            if (parsed && parsed.roomId) {
                resolved.push(raw);
                continue;
            }
            const username = parseUsername(trimmed);
            const result = await resolveScUsername(username);
            if (!result) {
                logger.warn(`sc save: could not resolve "${username}", skipping`);
                continue;
            }
            const entry = `${SC_URL_PREFIX}${result.username} ${result.roomId}`;
            resolved.push(entry);
            logger.info(`sc save: resolved "${username}" -> ${entry}`);
        }

        await fs.writeFile(SC_FILE_PATH, cleanListContent(resolved.join("\n")), "utf-8");
        logger.info("sc file updated via web editor (smart save)");
        res.sendStatus(200);
    } catch (error) {
        logger.error("Error saving sc file", { error });
        res.status(500).send("Error saving file");
    }
});

export default router;
