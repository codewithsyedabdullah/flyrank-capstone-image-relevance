/**
 * db/index.js — single SQLite connection (node:sqlite, built into Node 22+/25).
 *
 * Why SQLite: the brief suggests PostgreSQL via Docker, but Docker is absent on
 * the build machine and pgvector is optional at ~50 images (brief §10). SQLite
 * gives the evaluator a one-command run with zero install. The repository layer
 * isolates this choice; vectors are stored as JSON and cosine is computed
 * in-app (trivial at this scale).
 */
require('../config'); // load .env BEFORE DATABASE_PATH is read
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', '..', 'db', 'app.sqlite');

let db = null;

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb, DB_PATH };
