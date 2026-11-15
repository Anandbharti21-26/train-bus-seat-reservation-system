import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DB_PATH || path.join(__dirname, 'reservation.db');

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_number INTEGER NOT NULL,
      side TEXT NOT NULL,
      position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      passenger_name TEXT,
      booking_id TEXT,
      locked_by TEXT
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      passenger_name TEXT NOT NULL,
      seat_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (seat_id) REFERENCES seats(id)
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY,
      time TEXT NOT NULL,
      message TEXT NOT NULL,
      level TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_stats (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      conflicts_prevented INTEGER NOT NULL DEFAULT 0
    );

    INSERT OR IGNORE INTO system_stats (id, conflicts_prevented) VALUES (1, 0);
  `);
}

export function clearData() {
  db.exec('DELETE FROM activity_logs; DELETE FROM bookings; DELETE FROM seats; UPDATE system_stats SET conflicts_prevented = 0 WHERE id = 1;');
}
