import { Router } from "express";
import { promises as fs } from "fs";
import logger from "../../core/logger.js";
import { cleanListContent } from "../../core/content-processor.js";

interface ParsedEntry {
    id: string;
    label: string;
}

export interface ListProviderAdapter {
    name: string;
    filePath: string;
    parseLine(line: string): ParsedEntry | null;
    isResolved(line: string): boolean;
    resolveIdentifier(input: string): Promise<ParsedEntry | null>;
    beforeAdd?(entry: ParsedEntry): Promise<void> | void;
    formatEntry(entry: ParsedEntry): string;
    enrichList?(parsed: ParsedEntry[]): string[];
    resolveForRemove?(identifier: string): Promise<string> | string;
}

export function createListRoutes(adapter: ListProviderAdapter): Router {
    const router = Router();
    const prefix = `/api/${adapter.name}`;

    router.get(prefix, async (_req, res) => {
        try {
            const content = await fs.readFile(adapter.filePath, "utf-8");
            res.type("text/plain").send(content);
        } catch (error: any) {
            if (error.code === "ENOENT") return res.type("text/plain").send("");
            logger.error(`Error reading ${adapter.name} file`, { error });
            res.status(500).send("Error reading file");
        }
    });

    router.get(`${prefix}/list`, async (_req, res) => {
        try {
            const content = await fs.readFile(adapter.filePath, "utf-8");
            const parsed = content.split("\n")
                .map(line => adapter.parseLine(line))
                .filter((p): p is ParsedEntry => p !== null);

            if (adapter.enrichList) {
                res.json(adapter.enrichList(parsed));
            } else {
                res.json(parsed.map(p => p.label));
            }
        } catch {
            res.json([]);
        }
    });

    router.post(`${prefix}/add`, async (req, res) => {
        const { identifier } = req.body;
        if (!identifier || typeof identifier !== "string") {
            return res.status(400).json({ error: "identifier required" });
        }
        try {
            const resolved = await adapter.resolveIdentifier(identifier);
            if (!resolved) {
                return res.status(404).json({ error: `Could not resolve: ${identifier}` });
            }
            if (adapter.beforeAdd) await adapter.beforeAdd(resolved);

            let content = "";
            try { content = await fs.readFile(adapter.filePath, "utf-8"); } catch {}

            const lines = content.split("\n");
            const existingIndex = lines.findIndex((line) => adapter.parseLine(line)?.id === resolved.id);

            if (existingIndex !== -1) {
                const existing = adapter.parseLine(lines[existingIndex]);
                if (existing?.label === resolved.label) {
                    logger.info(`${adapter.name} skip: ${resolved.id} ${resolved.label} (already exists)`);
                    return res.json({ success: true });
                }
                lines[existingIndex] = adapter.formatEntry(resolved);
                await fs.writeFile(adapter.filePath, cleanListContent(lines.join("\n")), "utf-8");
                logger.info(`${adapter.name} update: ${existing?.label} -> ${resolved.label} (id=${resolved.id})`);
                return res.json({ success: true });
            }

            const newContent = cleanListContent(content + "\n" + adapter.formatEntry(resolved));
            await fs.writeFile(adapter.filePath, newContent, "utf-8");
            logger.info(`${adapter.name} add: ${resolved.id} ${resolved.label}`);
            res.json({ success: true });
        } catch (error) {
            logger.error(`Error adding to ${adapter.name}`, { error });
            res.status(500).json({ error: "Failed to update file" });
        }
    });

    router.post(`${prefix}/remove`, async (req, res) => {
        const { identifier } = req.body;
        if (!identifier || typeof identifier !== "string") {
            return res.status(400).json({ error: "identifier required" });
        }
        try {
            const resolvedId = adapter.resolveForRemove
                ? await adapter.resolveForRemove(identifier)
                : identifier;
            const content = await fs.readFile(adapter.filePath, "utf-8");
            const lines = content
                .split("\n")
                .filter((line) => {
                    const parsed = adapter.parseLine(line);
                    return parsed ? parsed.id !== resolvedId : true;
                });
            await fs.writeFile(adapter.filePath, cleanListContent(lines.join("\n")), "utf-8");
            logger.info(`${adapter.name} remove: ${identifier}${resolvedId !== identifier ? ` (id: ${resolvedId})` : ""}`);
            res.json({ success: true });
        } catch (error) {
            logger.error(`Error removing from ${adapter.name} file`, { error });
            res.status(500).json({ error: "Failed to update file" });
        }
    });

    // Read-only resolution capability for every provider: the same
    // resolveIdentifier the add flow uses, without catalog writes or follow
    // actions. The pipeline consumes this for recording provenance instead of
    // re-implementing its own catalog-scoped matching.
    router.get(`${prefix}/resolve`, async (req, res) => {
        const identifier = typeof req.query.identifier === "string" ? req.query.identifier.trim() : "";
        if (!identifier) {
            return res.status(400).json({ error: "identifier required" });
        }
        try {
            const resolved = await adapter.resolveIdentifier(identifier);
            if (!resolved) {
                return res.status(404).json({ error: `Could not resolve: ${identifier}` });
            }
            res.json({ id: resolved.id, label: resolved.label });
        } catch (error) {
            logger.error(`Error resolving ${adapter.name} identifier`, { error });
            res.status(500).json({ error: "Failed to resolve identifier" });
        }
    });

    router.post(prefix, async (req, res) => {
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
                if (adapter.isResolved(trimmed)) {
                    resolved.push(raw);
                    continue;
                }
                const result = await adapter.resolveIdentifier(trimmed);
                if (!result) {
                    logger.warn(`${adapter.name} save: could not resolve "${trimmed}", skipping`);
                    continue;
                }
                if (adapter.beforeAdd) await adapter.beforeAdd(result);
                const entry = adapter.formatEntry(result);
                resolved.push(entry);
                logger.info(`${adapter.name} save: resolved "${trimmed}" -> ${entry}`);
            }

            await fs.writeFile(adapter.filePath, cleanListContent(resolved.join("\n")), "utf-8");
            logger.info(`${adapter.name} file updated via web editor (smart save)`);
            res.sendStatus(200);
        } catch (error) {
            logger.error(`Error saving ${adapter.name} file`, { error });
            res.status(500).send("Error saving file");
        }
    });

    return router;
}
