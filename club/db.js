// =============================================================
// club/db.js — 하월시아 클럽 데이터베이스 (SQLite, Node 22 내장 node:sqlite)
//  - 파일: /data/club/club.db (Railway 볼륨). 볼륨이 없으면 프로젝트 폴더의 club_data/
//  - 글·사진·태그·좋아요·댓글·회원·내 식물을 담는다. 방주 보증서·시트는 건드리지 않는다.
// =============================================================
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DAY = 24 * 3600 * 1000;

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'club.db'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=4000;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      nick TEXT NOT NULL,
      nick_key TEXT UNIQUE NOT NULL,
      bio TEXT DEFAULT '',
      ark_no TEXT DEFAULT '',
      ark_checked_at INTEGER DEFAULT 0,
      blocked INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY,
      user_id INTEGER,
      admin INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sms_codes(
      id INTEGER PRIMARY KEY,
      phone TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      ip TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      tries INTEGER DEFAULT 0,
      used INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS plants(
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      tag_key TEXT DEFAULT '',
      cert_no TEXT DEFAULT '',
      cert_key TEXT DEFAULT '',
      cert_status TEXT DEFAULT '',
      cert_info TEXT DEFAULT '',
      cert_note TEXT DEFAULT '',
      cert_at INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      deleted INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS posts(
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      plant_id INTEGER,
      body TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      edited_at INTEGER DEFAULT 0,
      hidden INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS photos(
      id INTEGER PRIMARY KEY,
      post_id INTEGER NOT NULL,
      file TEXT NOT NULL,
      thumb TEXT NOT NULL,
      w INTEGER DEFAULT 0,
      h INTEGER DEFAULT 0,
      ord INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tags(
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      merged_into TEXT DEFAULT '',
      pinned_post INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS post_tags(
      post_id INTEGER NOT NULL,
      tag_key TEXT NOT NULL,
      PRIMARY KEY(post_id, tag_key)
    );
    CREATE TABLE IF NOT EXISTS likes(
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS comments(
      id INTEGER PRIMARY KEY,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      hidden INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS reports(
      id INTEGER PRIMARY KEY,
      post_id INTEGER,
      comment_id INTEGER,
      user_id INTEGER,
      reason TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      done INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ix_posts_time ON posts(created_at);
    CREATE INDEX IF NOT EXISTS ix_posts_user ON posts(user_id);
    CREATE INDEX IF NOT EXISTS ix_posts_plant ON posts(plant_id);
    CREATE INDEX IF NOT EXISTS ix_pt_tag ON post_tags(tag_key);
    CREATE INDEX IF NOT EXISTS ix_photos_post ON photos(post_id);
    CREATE INDEX IF NOT EXISTS ix_likes_time ON likes(created_at);
    CREATE INDEX IF NOT EXISTS ix_cmt_post ON comments(post_id);
    CREATE INDEX IF NOT EXISTS ix_plants_user ON plants(user_id);
    CREATE INDEX IF NOT EXISTS ix_plants_cert ON plants(cert_key);
    CREATE INDEX IF NOT EXISTS ix_sms_phone ON sms_codes(phone, created_at);
  `);
  return db;
}

// 여러 문장을 한 번에 (중간에 실패하면 전부 되돌림)
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}

module.exports = { openDb, tx, DAY };
