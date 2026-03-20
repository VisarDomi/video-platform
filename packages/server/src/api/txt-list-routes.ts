import { Router } from "express";
import { promises as fs } from "fs";
import logger from "../core/logger.js";
import { cleanListContent } from "../core/content-processor.js";

interface TxtListRoutesOptions {
    provider: string;
    filePath: string;
    urlPrefix: string;
    urlSuffix?: string;
}

export function createTxtListRoutes({ provider, filePath, urlPrefix, urlSuffix = "" }: TxtListRoutesOptions): Router {
    const router = Router();

    router.get(`/api/${provider}`, async (_req, res) => {
        try {
            const content = await fs.readFile(filePath, "utf-8");
            res.type("text/plain").send(content);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return res.type("text/plain").send("");
            }
            logger.error(`Error reading ${provider} file`, { error });
            res.status(500).send("Error reading file");
        }
    });

    router.get(`/api/${provider}/list`, async (_req, res) => {
        try {
            const content = await fs.readFile(filePath, "utf-8");
            const identifiers = content.split("\n")
                .map(line => line.trim())
                .filter(line => line && !line.startsWith("#"))
                .filter(line => urlPrefix === "" || line.startsWith(urlPrefix))
                .map(line => {
                    let id = urlPrefix ? line.replace(urlPrefix, "") : line;
                    if (urlSuffix) id = id.replace(new RegExp(urlSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "$"), "");
                    return id.replace(/\/$/, "");
                });
            res.json(identifiers);
        } catch {
            res.json([]);
        }
    });

    router.post(`/api/${provider}/add`, async (req, res) => {
        const { identifier } = req.body;
        if (!identifier || typeof identifier !== "string") {
            return res.status(400).json({ error: "identifier required" });
        }
        try {
            let content = "";
            try { content = await fs.readFile(filePath, "utf-8"); } catch {}
            if (content.includes(identifier)) {
                return res.json({ success: true });
            }
            const entry = urlPrefix + identifier + urlSuffix;
            const newContent = cleanListContent(content + "\n" + entry);
            await fs.writeFile(filePath, newContent, "utf-8");
            logger.info(`${provider} add: ${identifier}`);
            res.json({ success: true });
        } catch (error) {
            logger.error(`Error adding to ${provider} file`, { error });
            res.status(500).json({ error: "Failed to update file" });
        }
    });

    router.post(`/api/${provider}/remove`, async (req, res) => {
        const { identifier } = req.body;
        if (!identifier || typeof identifier !== "string") {
            return res.status(400).json({ error: "identifier required" });
        }
        try {
            const content = await fs.readFile(filePath, "utf-8");
            const lines = content.split("\n").filter(line => !line.includes(identifier));
            await fs.writeFile(filePath, cleanListContent(lines.join("\n")), "utf-8");
            logger.info(`${provider} remove: ${identifier}`);
            res.json({ success: true });
        } catch (error) {
            logger.error(`Error removing from ${provider} file`, { error });
            res.status(500).json({ error: "Failed to update file" });
        }
    });

    router.post(`/api/${provider}`, async (req, res) => {
        const { content } = req.body;
        if (typeof content !== 'string') {
            return res.status(400).send("Invalid content");
        }
        try {
            const cleanedContent = cleanListContent(content);
            await fs.writeFile(filePath, cleanedContent, "utf-8");
            logger.info(`${provider} file updated and cleaned via web editor`);
            res.sendStatus(200);
        } catch (error) {
            logger.error(`Error writing ${provider} file`, { error });
            res.status(500).send("Error saving file");
        }
    });

    return router;
}
