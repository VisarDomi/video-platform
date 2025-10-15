// src/services/database.service.ts
import sqlite3 from "sqlite3";
import { DB_PATH } from "../config.js";
import logger from "../logger.js";

const verboseSqlite = sqlite3.verbose();
export const db = new verboseSqlite.Database(DB_PATH, (err) => {
    if (err) {
        logger.error("Could not connect to database", { error: err.message });
        process.exit(1);
    }
    logger.info("Connected to the SQLite database.");
});

const createTableQuery = `
CREATE TABLE IF NOT EXISTS durations (
    video_filename TEXT NOT NULL,
    ts_filename TEXT NOT NULL,
    duration REAL NOT NULL,
    resolution TEXT,
    PRIMARY KEY (video_filename, ts_filename)
);`;

const createFixedPlaylistsTableQuery = `
CREATE TABLE IF NOT EXISTS fixed_playlists (
    video_filename TEXT PRIMARY KEY
);`;

db.serialize(() => {
    db.run(createTableQuery, (err) => {
        if (err) {
            logger.error("Error creating database table", { error: err.message });
            process.exit(1);
        }
        logger.info("Database table 'durations' is ready.");
    });

    // Check for resolution column and add it if it doesn't exist
    db.all("PRAGMA table_info(durations)", (err, columns: { name: string }[]) => {
        if (err) {
            logger.error("Error getting table info for 'durations'", { error: err.message });
            return;
        }

        const hasResolutionColumn = columns.some((column) => column.name === "resolution");

        if (!hasResolutionColumn) {
            db.run("ALTER TABLE durations ADD COLUMN resolution TEXT", (alterErr) => {
                if (alterErr) {
                    logger.error("Error adding 'resolution' column to 'durations' table", { error: alterErr.message });
                } else {
                    logger.info("Added 'resolution' column to 'durations' table.");
                }
            });
        }
    });

    db.run(createFixedPlaylistsTableQuery, (err) => {
        if (err) {
            logger.error("Error creating fixed_playlists table", { error: err.message });
            process.exit(1);
        }
        logger.info("Database table 'fixed_playlists' is ready.");
    });
});

export function isPlaylistFixed(video_filename: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const sql = `SELECT 1 FROM fixed_playlists WHERE video_filename = ?`;
        db.get(sql, [video_filename], (err, row) => {
            if (err) {
                logger.error(`Failed to check fixed_playlists for ${video_filename}`, { error: err });
                return reject(err);
            }
            resolve(!!row);
        });
    });
}

export function addFixedPlaylistEntry(video_filename: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const sql = `INSERT OR IGNORE INTO fixed_playlists (video_filename) VALUES (?)`;
        db.run(sql, [video_filename], function (err) {
            if (err) {
                logger.error(`Failed to add fixed_playlists entry for ${video_filename}`, { error: err });
                return reject(err);
            }
            resolve();
        });
    });
}

export function removeFixedPlaylistEntry(video_filename: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const sql = `DELETE FROM fixed_playlists WHERE video_filename = ?`;
        db.run(sql, [video_filename], function (err) {
            if (err) {
                logger.error(`Failed to remove fixed_playlists entry for ${video_filename}`, { error: err });
                return reject(err);
            }
            resolve();
        });
    });
}
