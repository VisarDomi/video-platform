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

    // Serve the HTML Interface
    router.get(`/${provider}`, (_req, res) => {
        const title = `${provider.toUpperCase()} Links Editor`;
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            background-color: #000;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            margin: 0;
            padding: 20px;
            display: flex;
            flex-direction: column;
            height: 90vh;
            box-sizing: border-box;
        }
        h1 { margin-top: 0; font-size: 1.2rem; margin-bottom: 10px; }
        textarea {
            flex-grow: 1;
            background-color: #1a1a1a;
            color: #e0e0e0;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 15px;
            font-family: monospace;
            font-size: 16px;
            resize: none;
            outline: none;
            margin-bottom: 15px;
        }
        textarea:focus { border-color: #555; }
        button {
            background-color: #007aff;
            color: white;
            border: none;
            padding: 15px;
            font-size: 18px;
            border-radius: 12px;
            cursor: pointer;
            font-weight: bold;
        }
        button:active { opacity: 0.8; }
        #status {
            height: 20px;
            font-size: 0.9rem;
            color: #aaa;
            margin-bottom: 5px;
            text-align: right;
        }
    </style>
</head>
<body>
    <div id="status"></div>
    <textarea id="content" spellcheck="false"></textarea>
    <button id="saveBtn">Save Changes</button>

    <script>
        const textarea = document.getElementById('content');
        const status = document.getElementById('status');
        const saveBtn = document.getElementById('saveBtn');

        async function loadContent() {
            try {
                const res = await fetch('/api/${provider}');
                if (!res.ok) throw new Error('Failed to load');
                const text = await res.text();
                textarea.value = text;
            } catch (err) {
                status.textContent = 'Error loading file';
                status.style.color = '#ff3b30';
            }
        }

        async function saveContent() {
            const originalText = saveBtn.textContent;
            saveBtn.textContent = 'Saving...';
            saveBtn.disabled = true;

            try {
                const res = await fetch('/api/${provider}', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: textarea.value })
                });

                if (res.ok) {
                    status.textContent = 'Saved successfully at ' + new Date().toLocaleTimeString();
                    status.style.color = '#34c759';
                    loadContent();
                } else {
                    throw new Error('Save failed');
                }
            } catch (err) {
                status.textContent = 'Error saving file';
                status.style.color = '#ff3b30';
            } finally {
                saveBtn.textContent = originalText;
                saveBtn.disabled = false;
            }
        }

        saveBtn.addEventListener('click', saveContent);
        loadContent();
    </script>
</body>
</html>
        `;
        res.send(html);
    });

    // API: Get raw content
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

    // API: Get parsed identifiers
    router.get(`/api/${provider}/following`, async (_req, res) => {
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

    // API: Follow (add to txt)
    router.post(`/api/${provider}/follow`, async (req, res) => {
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
            logger.info(`${provider} follow: added ${identifier}`);
            res.json({ success: true });
        } catch (error) {
            logger.error(`Error adding to ${provider} file`, { error });
            res.status(500).json({ error: "Failed to update file" });
        }
    });

    // API: Unfollow (remove from txt)
    router.post(`/api/${provider}/unfollow`, async (req, res) => {
        const { identifier } = req.body;
        if (!identifier || typeof identifier !== "string") {
            return res.status(400).json({ error: "identifier required" });
        }
        try {
            const content = await fs.readFile(filePath, "utf-8");
            const lines = content.split("\n").filter(line => !line.includes(identifier));
            await fs.writeFile(filePath, cleanListContent(lines.join("\n")), "utf-8");
            logger.info(`${provider} unfollow: removed ${identifier}`);
            res.json({ success: true });
        } catch (error) {
            logger.error(`Error removing from ${provider} file`, { error });
            res.status(500).json({ error: "Failed to update file" });
        }
    });

    // API: Save content
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
