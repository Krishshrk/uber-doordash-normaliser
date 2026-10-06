import initSqlJs, { Database } from 'sql.js';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(__dirname, '..', 'orders.db');

let db: Database;

export async function getDb(): Promise<Database> {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id               TEXT PRIMARY KEY,
      provider         TEXT NOT NULL,
      external_order_id TEXT NOT NULL,
      status           TEXT NOT NULL,
      customer         TEXT NOT NULL,
      line_items       TEXT NOT NULL,
      total_cents      INTEGER NOT NULL,
      currency         TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      raw_payload      TEXT NOT NULL,
      UNIQUE(provider, external_order_id)
    )
  `);
  // Separate table to dedup Uber event_id retries without re-fetching Get Order
  db.run(`
    CREATE TABLE IF NOT EXISTS uber_events (
      event_id TEXT PRIMARY KEY
    )
  `);
  persist();
  return db;
}

export function persist() {
  if (!db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}
