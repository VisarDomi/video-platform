import { Router } from "express";
import { promises as fs } from "fs";
import { targetKey, type Catalog, type Target } from "sdk";
import logger from "../../core/logger.js";
import { cleanListContent } from "../../core/content-processor.js";
import { mutateTextFile } from "../../core/durableFile.js";

// One site's download list as the clients (the apps, the Safari extensions, the pipeline)
// edit and read it. The core owns the file: every change is one serialized
// read-modify-write that replaces the file atomically. The site's catalog is the only
// parser of its lines (the downloader reads them with it too), writes new lines, and
// knows the site: resolving names, following before an add, existence, old names.
export interface ListSite {
    // The site ID: the route segment (/api/<id>/...) and the name in log lines.
    id: string;
    filePath: string;
    catalog: Catalog;
}

// Each listed entry, through the catalog's parser (silently: the downloader reports
// malformed lines), in list order with repeats.
export function listedTargets(catalog: Catalog, content: string): Target[] {
    return content.split("\n")
        .map((line) => catalog.parseTargetLine(line))
        .filter((target): target is Target => target !== null);
}

// A missing list is empty.
async function readList(site: ListSite): Promise<Target[]> {
    let content = "";
    try { content = await fs.readFile(site.filePath, "utf-8"); } catch {}
    return listedTargets(site.catalog, content);
}

export function createListRoutes(site: ListSite): Router {
    const router = Router();
    const { catalog } = site;
    const prefix = `/api/${site.id}`;
    // The listed key (ID, or label for an entry without one) a name belongs to.
    const resolveForRemove = async (identifier: string, listed: readonly Target[]) =>
        catalog.resolveForRemove ? await catalog.resolveForRemove(identifier, listed) : identifier;
    const resolveIdentifier = async (identifier: string) => {
        if (!catalog.resolveIdentifier) throw new Error(`${site.id} cannot resolve identifiers`);
        return catalog.resolveIdentifier(identifier);
    };

    router.get(`${prefix}/list`, async (_req, res) => {
        try {
            const content = await fs.readFile(site.filePath, "utf-8");
            const parsed = listedTargets(catalog, content);

            if (catalog.enrichList) {
                res.json(catalog.enrichList(parsed));
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
            const resolved = await resolveIdentifier(identifier);
            if (!resolved) {
                return res.status(404).json({ error: `Could not resolve: ${identifier}` });
            }
            if (catalog.beforeAdd) await catalog.beforeAdd(resolved);

            // The read, the decision and the write happen as one serialized step, and the
            // write replaces the file atomically: a power cut or a concurrent add cannot
            // truncate the list or drop an entry (a dropped line ends that live capture).
            type AddOutcome = { kind: "skip" } | { kind: "update"; previous?: string } | { kind: "add" };
            const outcome = await mutateTextFile<AddOutcome>(site.filePath, (current) => {
                const content = current ?? "";
                const lines = content.split("\n");
                const existingIndex = lines.findIndex((line) => catalog.parseTargetLine(line)?.id === resolved.id);
                if (existingIndex !== -1) {
                    const existing = catalog.parseTargetLine(lines[existingIndex]);
                    if (existing?.label === resolved.label) return { next: null, result: { kind: "skip" as const } };
                    lines[existingIndex] = catalog.formatTargetLine(resolved);
                    return { next: cleanListContent(lines.join("\n")), result: { kind: "update" as const, previous: existing?.label } };
                }
                return { next: cleanListContent(content + "\n" + catalog.formatTargetLine(resolved)), result: { kind: "add" as const } };
            });

            if (outcome.kind === "skip") {
                logger.debug(`${site.id} skip: ${resolved.id} ${resolved.label} (already exists)`);
            } else if (outcome.kind === "update") {
                logger.info(`${site.id} update: ${outcome.previous} -> ${resolved.label} (id=${resolved.id})`);
            } else {
                logger.info(`${site.id} add: ${resolved.id} ${resolved.label}`);
            }
            res.json({ success: true });
        } catch (error) {
            logger.error(`Error adding to ${site.id}`, { error });
            res.status(500).json({ error: "Failed to update file" });
        }
    });

    // Whether a streamer is listed: a name it is listed under answers at once, any other
    // name (such as one it recorded under before a rename) resolves through the site.
    router.get(`${prefix}/member`, async (req, res) => {
        const identifier = typeof req.query.identifier === "string" ? req.query.identifier.trim() : "";
        if (!identifier) {
            return res.status(400).json({ error: "identifier required" });
        }
        try {
            const entries = await readList(site);
            if (entries.some(entry => entry.id === identifier || entry.label === identifier)) {
                return res.json({ member: true });
            }
            const key = await resolveForRemove(identifier, entries);
            res.json({ member: entries.some(entry => targetKey(entry) === key) });
        } catch (error) {
            logger.error(`Error checking ${site.id} membership`, { error });
            res.status(500).json({ error: "Failed to check membership" });
        }
    });

    // Whether the site has a streamer by this name, listed or not: Video Vault's ➕ asks
    // every site which one an upload's streamer is on. A failed lookup is an error.
    router.get(`${prefix}/exists`, async (req, res) => {
        const identifier = typeof req.query.identifier === "string" ? req.query.identifier.trim() : "";
        if (!identifier) {
            return res.status(400).json({ error: "identifier required" });
        }
        if (!catalog.exists) {
            return res.status(501).json({ error: `${site.id} cannot look streamers up` });
        }
        try {
            res.json({ exists: await catalog.exists(identifier) });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`${site.id} lookup failed for ${identifier}: ${message}`);
            res.status(502).json({ error: message });
        }
    });

    router.post(`${prefix}/remove`, async (req, res) => {
        const { identifier } = req.body;
        if (!identifier || typeof identifier !== "string") {
            return res.status(400).json({ error: "identifier required" });
        }
        try {
            const resolvedId = await resolveForRemove(identifier, await readList(site));
            await mutateTextFile(site.filePath, (current) => {
                if (current === null) throw new Error(`${site.filePath} does not exist`);
                const lines = current
                    .split("\n")
                    .filter((line) => {
                        const parsed = catalog.parseTargetLine(line);
                        return parsed ? targetKey(parsed) !== resolvedId : true;
                    });
                return { next: cleanListContent(lines.join("\n")), result: undefined };
            });
            logger.info(`${site.id} remove: ${identifier}${resolvedId !== identifier ? ` (id: ${resolvedId})` : ""}`);
            res.json({ success: true });
        } catch (error) {
            logger.error(`Error removing from ${site.id} file`, { error });
            res.status(500).json({ error: "Failed to update file" });
        }
    });

    // Read-only resolution for every site: the same resolveIdentifier the add flow uses,
    // without list writes or follow actions. The pipeline consumes this for recording
    // provenance instead of re-implementing its own catalog-scoped matching.
    router.get(`${prefix}/resolve`, async (req, res) => {
        const identifier = typeof req.query.identifier === "string" ? req.query.identifier.trim() : "";
        if (!identifier) {
            return res.status(400).json({ error: "identifier required" });
        }
        try {
            const resolved = await resolveIdentifier(identifier);
            if (!resolved) {
                return res.status(404).json({ error: `Could not resolve: ${identifier}` });
            }
            res.json({ id: resolved.id, label: resolved.label });
        } catch (error) {
            logger.error(`Error resolving ${site.id} identifier`, { error });
            res.status(500).json({ error: "Failed to resolve identifier" });
        }
    });

    return router;
}
