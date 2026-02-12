import { Router } from "express";
import { promises as fs } from "fs";
import { FC2_FILE_PATH } from "../core/config.js";
import logger from "../core/logger.js";
import { cleanListContent } from "../core/content-processor.js";

const router = Router();

// Serve the HTML Interface
router.get("/fc2", (_req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FC2 Links Editor</title>
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
            font-size: 16px; /* Prevents iOS zoom */
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
                const res = await fetch('/api/fc2');
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
                const res = await fetch('/api/fc2', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: textarea.value })
                });
                
                if (res.ok) {
                    status.textContent = 'Saved successfully at ' + new Date().toLocaleTimeString();
                    status.style.color = '#34c759';
                    // Reload to show the cleaned content
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
        
        // Load on start
        loadContent();
    </script>
</body>
</html>
    `;
    res.send(html);
});

// API: Get content
router.get("/api/fc2", async (_req, res) => {
    try {
        const content = await fs.readFile(FC2_FILE_PATH, "utf-8");
        res.type("text/plain").send(content);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            // If file doesn't exist, return empty string
            return res.type("text/plain").send("");
        }
        logger.error("Error reading fc2 file", { error });
        res.status(500).send("Error reading file");
    }
});

// API: Get following identifiers
router.get("/api/fc2/following", async (_req, res) => {
    try {
        const content = await fs.readFile(FC2_FILE_PATH, "utf-8");
        const identifiers = content.split("\n")
            .map(line => line.trim())
            .filter(line => line.startsWith("https://live.fc2.com/"))
            .map(line => line.replace("https://live.fc2.com/", "").replace(/\/$/, ""));
        res.json(identifiers);
    } catch {
        res.json([]);
    }
});

// API: Follow (add to fc2.txt)
router.post("/api/fc2/follow", async (req, res) => {
    const { identifier } = req.body;
    if (!identifier || typeof identifier !== "string") {
        return res.status(400).json({ error: "identifier required" });
    }
    try {
        let content = "";
        try { content = await fs.readFile(FC2_FILE_PATH, "utf-8"); } catch {}
        if (content.includes(identifier)) {
            return res.json({ success: true });
        }
        const url = `https://live.fc2.com/${identifier}/`;
        const newContent = cleanListContent(content + "\n" + url);
        await fs.writeFile(FC2_FILE_PATH, newContent, "utf-8");
        logger.info(`FC2 follow: added ${identifier}`);
        res.json({ success: true });
    } catch (error) {
        logger.error("Error adding to fc2 file", { error });
        res.status(500).json({ error: "Failed to update file" });
    }
});

// API: Unfollow (remove from fc2.txt)
router.post("/api/fc2/unfollow", async (req, res) => {
    const { identifier } = req.body;
    if (!identifier || typeof identifier !== "string") {
        return res.status(400).json({ error: "identifier required" });
    }
    try {
        const content = await fs.readFile(FC2_FILE_PATH, "utf-8");
        const lines = content.split("\n").filter(line => !line.includes(identifier));
        await fs.writeFile(FC2_FILE_PATH, cleanListContent(lines.join("\n")), "utf-8");
        logger.info(`FC2 unfollow: removed ${identifier}`);
        res.json({ success: true });
    } catch (error) {
        logger.error("Error removing from fc2 file", { error });
        res.status(500).json({ error: "Failed to update file" });
    }
});

// API: Save content
router.post("/api/fc2", async (req, res) => {
    const { content } = req.body;

    if (typeof content !== 'string') {
        return res.status(400).send("Invalid content");
    }

    try {
        const cleanedContent = cleanListContent(content);
        await fs.writeFile(FC2_FILE_PATH, cleanedContent, "utf-8");
        logger.info("FC2 file updated and cleaned via web editor");
        res.sendStatus(200);
    } catch (error) {
        logger.error("Error writing fc2 file", { error });
        res.status(500).send("Error saving file");
    }
});

export default router;