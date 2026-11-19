import { Router } from "express";
import { promises as fs } from "fs";
import logger from "../../core/logger.js";
import { cleanListContent } from "../../core/content-processor.js";
import { mutateTextFile } from "../../core/durableFile.js";

interface ParsedEntry {
    id: string;
    label: string;
}

export interface ListProviderAdapter {
    name: string;
    filePath: string;
    parseLine(line: string): ParsedEntry | null;
    resolveIdentifier(input: string): Promise<ParsedEntry | null>;
    beforeAdd?(entry: ParsedEntry): Promise<void> | void;
    formatEntry(entry: ParsedEntry): string;
    enrichList?(parsed: ParsedEntry[]): string[];
    // The listed ID a name belongs to (for remove and membership); may ask the provider,
    // so names a streamer had before a rename still find them.
    resolveForRemove?(identifier: string): Promise<string> | string;
    // Whether the provider itself has a streamer by this name (listed or not); throws when it cannot say.
    exists?(identifier: string): Promise<boolean>;
}

export function createListRoutes(adapter: ListProviderAdapter): Router {
    const router = Router();
    const prefix = `/api/${adapter.name}`;

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

            // The read, the decision and the write happen as one serialized step, and the
            // write replaces the file atomically: a power cut or a concurrent add cannot
            // truncate the list or drop an entry (a dropped line ends that live capture).
            type AddOutcome = { kind: "skip" } | { kind: "update"; previous?: string } | { kind: "add" };
            const outcome = await mutateTextFile<AddOutcome>(adapter.filePath, (current) => {
                const content = current ?? "";
                const lines = content.split("\n");
                const existingIndex = lines.findIndex((line) => adapter.parseLine(line)?.id === resolved.id);
                if (existingIndex !== -1) {
                    const existing = adapter.parseLine(lines[existingIndex]);
                    if (existing?.label === resolved.label) return { next: null, result: { kind: "skip" as const } };
                    lines[existingIndex] = adapter.formatEntry(resolved);
                    return { next: cleanListContent(lines.join("\n")), result: { kind: "update" as const, previous: existing?.label } };
                }
                return { next: cleanListContent(content + "\n" + adapter.formatEntry(resolved)), result: { kind: "add" as const } };
            });

            if (outcome.kind === "skip") {
                logger.debug(`${adapter.name} skip: ${resolved.id} ${resolved.label} (already exists)`);
            } else if (outcome.kind === "update") {
                logger.info(`${adapter.name} update: ${outcome.previous} -> ${resolved.label} (id=${resolved.id})`);
            } else {
                logger.info(`${adapter.name} add: ${resolved.id} ${resolved.label}`);
            }
            res.json({ success: true });
        } catch (error) {
            logger.error(`Error adding to ${adapter.name}`, { error });
            res.status(500).json({ error: "Failed to update file" });
        }
    });

    // Whether a streamer is listed, by ID: a name it is listed under answers at once, any
    // other name (such as one it recorded under before a rename) resolves through the provider.
    router.get(`${prefix}/member`, async (req, res) => {
        const identifier = typeof req.query.identifier === "string" ? req.query.identifier.trim() : "";
        if (!identifier) {
            return res.status(400).json({ error: "identifier required" });
        }
        try {
            let content = "";
            try { content = await fs.readFile(adapter.filePath, "utf-8"); } catch {}
            const entries = content.split("\n")
                .map(line => adapter.parseLine(line))
                .filter((p): p is ParsedEntry => p !== null);
            if (entries.some(entry => entry.id === identifier || entry.label === identifier)) {
                return res.json({ member: true });
            }
            const id = adapter.resolveForRemove ? await adapter.resolveForRemove(identifier) : identifier;
            res.json({ member: entries.some(entry => entry.id === id) });
        } catch (error) {
            logger.error(`Error checking ${adapter.name} membership`, { error });
            res.status(500).json({ error: "Failed to check membership" });
        }
    });

    // Whether the provider has a streamer by this name, listed or not: the uploads app's ➕ asks
    // all three providers which one an upload's streamer is on. A failed lookup is an error.
    router.get(`${prefix}/exists`, async (req, res) => {
        const identifier = typeof req.query.identifier === "string" ? req.query.identifier.trim() : "";
        if (!identifier) {
            return res.status(400).json({ error: "identifier required" });
        }
        if (!adapter.exists) {
            return res.status(501).json({ error: `${adapter.name} cannot look streamers up` });
        }
        try {
            res.json({ exists: await adapter.exists(identifier) });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`${adapter.name} lookup failed for ${identifier}: ${message}`);
            res.status(502).json({ error: message });
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
            await mutateTextFile(adapter.filePath, (current) => {
                if (current === null) throw new Error(`${adapter.filePath} does not exist`);
                const lines = current
                    .split("\n")
                    .filter((line) => {
                        const parsed = adapter.parseLine(line);
                        return parsed ? parsed.id !== resolvedId : true;
                    });
                return { next: cleanListContent(lines.join("\n")), result: undefined };
            });
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

    return router;
}
