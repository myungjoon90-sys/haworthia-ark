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
  // ---- 종(만상·옥선…) — 2026-11-16 추가. 예전 데이터베이스에도 칸을 붙인다 ----
  db.exec(`CREATE TABLE IF NOT EXISTS species(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      ord INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );`);
  const addCol = (t, c, def) => {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((x) => x.name);
    if (!cols.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
  };
  addCol('tags', 'species', 'INTEGER');          // 이 품종이 속한 종 (운영자가 정함)
  addCol('posts', 'species', 'INTEGER');         // 이 글의 종 (없으면 ETC)
  addCol('posts', 'species_src', "TEXT DEFAULT ''"); // 'user' = 글쓴이·운영자가 직접 고름, 그 밖 = 자동
  db.exec('CREATE INDEX IF NOT EXISTS ix_posts_species ON posts(species)');
  // 종 이름 외국어 (English / 简体 / 繁體) — 2026-11-16
  // 닉네임 마지막으로 바꾼 때 (3개월에 한 번만 — 2026-11-16 사장님 결정). 가입할 때 정한 건 셈하지 않음
  addCol('users', 'nick_changed_at', 'INTEGER DEFAULT 0');
  addCol('species', 'name_en', "TEXT DEFAULT ''");
  addCol('species', 'name_zhs', "TEXT DEFAULT ''");
  addCol('species', 'name_zht', "TEXT DEFAULT ''");
  if (!db.prepare('SELECT COUNT(*) n FROM species').get().n) {
    const ins = db.prepare('INSERT INTO species(name,ord,created_at) VALUES(?,?,?)');
    ['만상', '옥선', '바디아', '스프링복스'].forEach((n, i) => ins.run(n, i + 1, Date.now()));
  }
  // 처음 넣어 둔 종의 외국어 이름 (비어 있을 때만 — 운영자 화면에서 고칠 수 있음)
  const SP_I18N = {
    '만상': ['Maughanii', '万象', '萬象'],
    '옥선': ['Truncata', '玉扇', '玉扇'],
    '바디아': ['Badia', 'Badia', 'Badia'],
    '스프링복스': ['Springbokvlakensis', 'Springbokvlakensis', 'Springbokvlakensis'],
  };
  for (const [n, v] of Object.entries(SP_I18N)) {
    db.prepare("UPDATE species SET name_en=?, name_zhs=?, name_zht=? WHERE name=? AND COALESCE(name_en,'')='' AND COALESCE(name_zhs,'')='' AND COALESCE(name_zht,'')=''").run(v[0], v[1], v[2], n);
  }

  // ---- v29 (2026-11-16): 팔로우 · 알림 · 폰 알림(웹 푸시) · 옛 닉네임 주소 · 판매 연결 ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS follows(
      follower_id INTEGER NOT NULL,
      followee_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(follower_id, followee_id)
    );
    CREATE INDEX IF NOT EXISTS ix_follows_followee ON follows(followee_id);

    -- 알림 한 줄. kind: like · comment · follow · newpost · diary
    -- ukey 가 같은 알림은 한 번만 (같은 사람이 ♥ 눌렀다 뺐다 해도 한 줄)
    CREATE TABLE IF NOT EXISTS notifs(
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      actor_id INTEGER,
      post_id INTEGER,
      comment_id INTEGER,
      tag_key TEXT,
      ukey TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      read_at INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ix_notifs_user ON notifs(user_id, id);

    -- 폰 알림을 켠 기기 (브라우저가 준 받는 주소)
    CREATE TABLE IF NOT EXISTS push_subs(
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      ua TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      last_ok INTEGER DEFAULT 0,
      fails INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ix_push_user ON push_subs(user_id);

    -- 예전 닉네임 → 지금 회원 (옛 온실 주소를 새 주소로 넘김)
    CREATE TABLE IF NOT EXISTS nick_history(
      old_key TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      changed_at INTEGER NOT NULL
    );

    -- 작은 설정값 (폰 알림 열쇠 등)
    CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
  `);
  addCol('users', 'lang', "TEXT DEFAULT ''");          // 폰 알림을 이 언어로
  addCol('tags', 'shop_off', 'INTEGER DEFAULT 0');      // 1 = 이 품종은 판매 연결 안 보임 (운영자)
  // v32 카카오 로그인: 카카오 회원번호 (처음 한 번 휴대폰으로 확인한 뒤 이어 둠)
  addCol('users', 'kakao_id', "TEXT DEFAULT ''");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_kakao ON users(kakao_id) WHERE kakao_id<>''");
  return db;
}

// 여러 문장을 한 번에 (중간에 실패하면 전부 되돌림)
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}

module.exports = { openDb, tx, DAY };
