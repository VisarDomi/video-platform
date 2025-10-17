import sqlite3 from "sqlite3";
import { DB_PATH } from "../../../core/config.js";
import logger from "../../../core/logger.js";
import { DATABASE } from "../../../core/constants.js";

const verboseSqlite = sqlite3.verbose();
export const db = new verboseSqlite.Database(DB_PATH, (err) => {
    if (err) {
        logger.error("Could not connect to database", { error: err.message });
        process.exit(1);
    }
});

const fixedPlaylistsCache = new Set<string>();

const createTableQuery = `
CREATE TABLE IF NOT EXISTS ${DATABASE.TABLES.DURATIONS} (
    ${DATABASE.COLUMNS.VIDEO_FILENAME} TEXT NOT NULL,
    ${DATABASE.COLUMNS.TS_FILENAME} TEXT NOT NULL,
    ${DATABASE.COLUMNS.DURATION} REAL NOT NULL,
    ${DATABASE.COLUMNS.RESOLUTION} TEXT,
    PRIMARY KEY (${DATABASE.COLUMNS.VIDEO_FILENAME}, ${DATABASE.COLUMNS.TS_FILENAME})
);`;

const createFixedPlaylistsTableQuery = `
CREATE TABLE IF NOT EXISTS ${DATABASE.TABLES.FIXED_PLAYLISTS} (
    ${DATABASE.COLUMNS.VIDEO_FILENAME} TEXT PRIMARY KEY
);`;

db.serialize(() => {
    db.run(createTableQuery, (err) => {
        if (err) {
            logger.error("Error creating database table", { error: err.message });
            process.exit(1);
        }
    });

    db.all(`PRAGMA table_info(${DATABASE.TABLES.DURATIONS})`, (err, columns: { name: string }[]) => {
        if (err) {
            logger.error(`Error getting table info for '${DATABASE.TABLES.DURATIONS}'`, { error: err.message });
            return;
        }

        const hasResolutionColumn = columns.some((column) => column.name === DATABASE.COLUMNS.RESOLUTION);

        if (!hasResolutionColumn) {
            db.run(`ALTER TABLE ${DATABASE.TABLES.DURATIONS} ADD COLUMN ${DATABASE.COLUMNS.RESOLUTION} TEXT`, (alterErr) => {
                if (alterErr) {
                    logger.error(`Error adding '${DATABASE.COLUMNS.RESOLUTION}' column to '${DATABASE.TABLES.DURATIONS}' table`, { error: alterErr.message });
                }
            });
        }
    });

    db.run(createFixedPlaylistsTableQuery, (err) => {
        if (err) {
            logger.error(`Error creating ${DATABASE.TABLES.FIXED_PLAYLISTS} table`, { error: err.message });
            process.exit(1);
        }
    });

    db.all(`SELECT ${DATABASE.COLUMNS.VIDEO_FILENAME} FROM ${DATABASE.TABLES.FIXED_PLAYLISTS}`, [], (err, rows: { video_filename: string }[]) => {
        if (err) {
            logger.error(`Failed to load ${DATABASE.TABLES.FIXED_PLAYLISTS} into cache`, { error: err });
            process.exit(1);
        }
        rows.forEach((row) => fixedPlaylistsCache.add(row.video_filename));
    });
});

export function isPlaylistFixed(video_filename: string): boolean {
    return fixedPlaylistsCache.has(video_filename);
}

export function addFixedPlaylistEntry(video_filename: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const sql = `INSERT OR IGNORE INTO ${DATABASE.TABLES.FIXED_PLAYLISTS} (${DATABASE.COLUMNS.VIDEO_FILENAME}) VALUES (?)`;
        db.run(sql, [video_filename], function (err) {
            if (err) {
                logger.error(`Failed to add ${DATABASE.TABLES.FIXED_PLAYLISTS} entry for ${video_filename}`, { error: err });
                return reject(err);
            }
            fixedPlaylistsCache.add(video_filename);
            resolve();
        });
    });
}

export function removeFixedPlaylistEntry(video_filename: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const sql = `DELETE FROM ${DATABASE.TABLES.FIXED_PLAYLISTS} WHERE ${DATABASE.COLUMNS.VIDEO_FILENAME} = ?`;
        db.run(sql, [video_filename], function (err) {
            if (err) {
                logger.error(`Failed to remove ${DATABASE.TABLES.FIXED_PLAYLISTS} entry for ${video_filename}`, { error: err });
                return reject(err);
            }
            fixedPlaylistsCache.delete(video_filename);
            resolve();
        });
    });
}

export function removeDurationsEntry(video_filename: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const sql = `DELETE FROM ${DATABASE.TABLES.DURATIONS} WHERE ${DATABASE.COLUMNS.VIDEO_FILENAME} = ?`;
        db.run(sql, [video_filename], function (err) {
            if (err) {
                logger.error(`Failed to remove ${DATABASE.TABLES.DURATIONS} entry for ${video_filename}`, { error: err });
                return reject(err);
            }
            resolve();
        });
    });
}
