// =============================================================
// club/index.js — 하월시아 클럽 (club.haworthia.co.kr)
//  커뮤니티 = 바깥의 큰 집 / 방주 = 그 안의 특별한 방
//  - 누구나 휴대폰 문자 인증으로 가입 → 사진 올리기 · #품종 해시태그 · ♥ · 댓글
//  - 태그마다 대표 게시물: 📌 운영자 지정이 먼저, 없으면 최근 30일 점수(좋아요 1 + 댓글 2) 1위
//  - 내 온실: 내 식물별 성장 기록 / 방주 보증서를 연결하면 🛡정품 배지 + 족보(모본×부본)
//  - 같은 서버(방주)에서 돈다. club. 으로 들어오면 /club 아래로 보낸다.
//  - 데이터는 SQLite(/data/club/club.db). 방주 구글 시트는 읽기만 한다.
// =============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { openDb, tx, DAY } = require('./db');
const T = require('./text');

const VIEWS = path.join(__dirname, 'views');
const PUBLIC = path.join(__dirname, 'public');
const VERSION = 'club-1';

// ---- 활동 등급 (사장님 결정 2026-11-15 · 보석형) ----
//  글 = 숨김·삭제 안 된 내 글 / 댓글 = 남의 글에 단 댓글 (내 글에 단 것·숨김·삭제 제외)
//  💎 다이아 = 방주 가입 요건 1개 충족 (방주 /join 에서 휴대폰 번호로 자동 확인)
const TIERS = [
  { key: 'bronze', name: '브론즈', icon: '🥉', posts: 0, comments: 0 },
  { key: 'silver', name: '실버', icon: '🥈', posts: 10, comments: 10 },
  { key: 'gold', name: '골드', icon: '🥇', posts: 30, comments: 30 },
  { key: 'platinum', name: '플래티넘', icon: '💠', posts: 60, comments: 60 },
  { key: 'diamond', name: '다이아', icon: '💎', posts: 100, comments: 100, ark: true },
];
function tierOf(a) {
  let t = TIERS[0];
  for (const x of TIERS) if ((a.posts || 0) >= x.posts && (a.comments || 0) >= x.comments) t = x;
  const i = TIERS.indexOf(t);
  return { ...t, idx: i, next: TIERS[i + 1] || null };
}

function mountClub(app, deps) {
  const sheets = deps.sheets || {};
  const messaging = deps.messaging || {};
  const certToken = deps.certToken || (() => '');
  const ADMIN_PASSWORD = deps.adminPassword || process.env.ADMIN_PASSWORD || '';
  const SECRET = deps.sessionSecret || process.env.SESSION_SECRET || 'jiyang-ark-secret';
  const ARK_URL = (deps.arkUrl || process.env.ARK_URL || 'https://ark.haworthia.co.kr').replace(/\/$/, '');
  const DATA_DIR = deps.dataDir || process.env.CLUB_DATA_DIR || (fs.existsSync('/data') ? '/data/club' : path.join(__dirname, '..', 'club_data'));
  const DEV = process.env.CLUB_DEV === '1';
  const PHOTO_DIR = path.join(DATA_DIR, 'photos');
  fs.mkdirSync(PHOTO_DIR, { recursive: true });

  const db = openDb(DATA_DIR);
  const _st = new Map();
  const q = (sql) => { let s = _st.get(sql); if (!s) { s = db.prepare(sql); _st.set(sql, s); } return s; };
  const now = () => Date.now();

  app.set('trust proxy', 1);

  // ---- club. 주소로 들어오면 /club 아래로 ----
  app.use((req, res, next) => {
    const host = String(req.headers.host || '').toLowerCase();
    req.clubHost = host.startsWith('club.');
    if (req.clubHost && !(req.url === '/club' || req.url.startsWith('/club/') || req.url.startsWith('/club?'))) {
      req.url = '/club' + (req.url === '/' ? '' : req.url);
    }
    next();
  });

  const r = express.Router();
  app.use('/club', r);

  r.use(express.json({ limit: '200kb' }));
  r.use(express.urlencoded({ extended: true, limit: '200kb' }));
  r.use('/media', express.static(PHOTO_DIR, { maxAge: '365d', immutable: true, fallthrough: false }));
  r.use('/static', express.static(PUBLIC, { maxAge: '1h' }));

  // ---- 쿠키·로그인 ----
  function cookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
  }
  function setCookie(req, res, token, maxAgeSec) {
    const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
    res.append('Set-Cookie', `club_s=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
  }
  const SESSION_DAYS = 180;

  r.use((req, res, next) => {
    req.B = req.clubHost ? '' : '/club';
    const tok = cookies(req).club_s;
    req.user = null; req.isAdmin = false; req.sess = null;
    if (tok && /^[0-9a-f]{64}$/.test(tok)) {
      const s = q('SELECT * FROM sessions WHERE token=?').get(tok);
      if (s && now() - s.last_at < SESSION_DAYS * DAY) {
        req.sess = s;
        req.isAdmin = !!s.admin;
        if (s.user_id) {
          const u = q('SELECT * FROM users WHERE id=?').get(s.user_id);
          if (u) req.user = u;
        }
        if (now() - s.last_at > 3600 * 1000) q('UPDATE sessions SET last_at=? WHERE token=?').run(now(), tok);
      }
    }
    Object.assign(res.locals, {
      B: req.B, me: req.user, isAdmin: req.isAdmin, ARK_URL, T, VERSION,
      level: userLevel, path: req.path, dev: DEV,
    });
    next();
  });

  function newSession(req, res, userId, admin) {
    const token = crypto.randomBytes(32).toString('hex');
    q('INSERT INTO sessions(token,user_id,admin,created_at,last_at) VALUES(?,?,?,?,?)').run(token, userId || null, admin ? 1 : 0, now(), now());
    if (req.sess) q('DELETE FROM sessions WHERE token=?').run(req.sess.token);
    setCookie(req, res, token, SESSION_DAYS * 24 * 3600);
    return token;
  }

  // 다른 사이트에서 몰래 보내는 요청 막기
  r.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.headers.origin || req.headers.referer || '';
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ ok: false, error: '잘못된 요청입니다.' }); }
      catch (e) { return res.status(403).json({ ok: false, error: '잘못된 요청입니다.' }); }
    }
    next();
  });

  function page(res, view, data) { res.render(path.join(VIEWS, view + '.ejs'), data || {}); }
  function fail(res, code, msg) { res.status(code).json({ ok: false, error: msg }); }
  function needUser(req, res) {
    if (!req.user) { fail(res, 401, '로그인이 필요합니다.'); return false; }
    if (req.user.blocked) { fail(res, 403, '이용이 제한된 계정입니다. 운영자에게 문의해 주세요.'); return false; }
    return true;
  }
  function needAdmin(req, res) { if (!req.isAdmin) { fail(res, 403, '운영자만 할 수 있습니다.'); return false; } return true; }
  function loginRedirect(req, res) { return res.redirect(req.B + '/login?next=' + encodeURIComponent(req.B + req.url)); }

  // ---- 간단한 횟수 제한 (메모리) ----
  const _hits = new Map();
  function limited(key, max, windowMs) {
    const t = now();
    const arr = (_hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) { _hits.set(key, arr); return true; }
    arr.push(t); _hits.set(key, arr);
    return false;
  }
  setInterval(() => { const t = now(); for (const [k, v] of _hits) if (!v.some((x) => t - x < 3600 * 1000)) _hits.delete(k); }, 10 * 60 * 1000).unref();

  // =============================================================
  // 방주 시트에서 품종명 가져오기 (10분 기억, 시트가 느리거나 실패해도 화면은 뜬다)
  // =============================================================
  const ark = { t: 0, official: new Map(), names: new Map(), loading: null };
  function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }
  async function refreshArk() {
    const official = new Map(); const names = new Map();
    try {
      const groups = sheets.getArkList ? await sheets.getArkList() : [];
      for (const g of groups || []) for (const v of g.품종 || []) {
        const k = T.tagKey(v.품종명); if (!k) continue;
        official.set(k, { name: v.품종명, maker: g.작출자, 모본: v.모본, 부본: v.부본, 영문명: v.영문명, 연도: v.작출연도, 등급: v.등급 });
        names.set(k, v.품종명);
      }
    } catch (e) { console.warn('[club] 방주리스트 읽기 실패:', e.message); }
    try {
      const keys = Object.keys(sheets.GRADE_TABS || {});
      for (const g of keys) {
        const list = await sheets.listVarieties(g).catch(() => []);
        for (const n of list) { const k = T.tagKey(n); if (k && !names.has(k)) names.set(k, n); }
      }
    } catch (e) { console.warn('[club] 품종명 목록 읽기 실패:', e.message); }
    if (official.size || names.size || !ark.t) { ark.official = official; ark.names = names; }
    ark.t = now();
    // 방주 등재 품종 태그는 방주 이름(띄어쓰기 포함)으로 맞춘다
    try { for (const [k, v] of ark.official) q("UPDATE tags SET label=? WHERE key=? AND merged_into=''").run(v.name, k); } catch (e) {}
  }
  async function arkData(waitMs) {
    if (now() - ark.t > 10 * 60 * 1000 && !ark.loading) {
      ark.loading = refreshArk().finally(() => { ark.loading = null; });
    }
    if (ark.loading && !ark.t && waitMs) { await withTimeout(ark.loading, waitMs).catch(() => {}); }
    return ark;
  }
  setTimeout(() => arkData(0), 20 * 1000).unref?.();

  // =============================================================
  // 태그
  // =============================================================
  function resolveTag(key) {
    let k = key; let guard = 0;
    while (k && guard++ < 10) {
      const t = q('SELECT merged_into FROM tags WHERE key=?').get(k);
      if (!t || !t.merged_into) break;
      k = t.merged_into;
    }
    return k;
  }
  function ensureTag(key, label) {
    const k = resolveTag(key);
    const ex = q('SELECT key FROM tags WHERE key=?').get(k);
    if (!ex) {
      const off = ark.names.get(k);
      q('INSERT INTO tags(key,label,created_at) VALUES(?,?,?)').run(k, off || label || k, now());
    }
    return k;
  }
  // 띄어 쓴 품종명 알아보기용: 방주 품종명이거나 이미 있는 태그
  T.setKnown((k) => ark.names.has(k) || !!q('SELECT 1 FROM tags WHERE key=?').get(k));
  // 보이는 이름: 방주 등재 품종은 방주 이름(띄어쓰기 포함) → 운영자가 정한 이름 → 처음 쓰인 이름
  function tagLabel(key) {
    const off = ark.official.get(key);
    if (off) return off.name;
    const t = q('SELECT label FROM tags WHERE key=?').get(key);
    return (t && t.label) || ark.names.get(key) || key;
  }
  function setPostTags(postId, body, plant) {
    q('DELETE FROM post_tags WHERE post_id=?').run(postId);
    const keys = new Set();
    for (const t of T.parseTags(body)) keys.add(ensureTag(t.key, t.label));
    if (plant && plant.tag_key) keys.add(ensureTag(plant.tag_key, plant.name));
    for (const k of keys) q('INSERT OR IGNORE INTO post_tags(post_id,tag_key) VALUES(?,?)').run(postId, k);
    return [...keys];
  }

  // 점수: 최근 30일 좋아요 1점 + 댓글 2점 (본인이 누른 것·단 것은 빼고)
  const SCORE_SQL = `(
      (SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id AND l.created_at>=? AND l.user_id<>p.user_id)
    + 2*(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.created_at>=? AND c.user_id<>p.user_id AND c.hidden=0 AND c.deleted=0)
  )`;
  const VISIBLE = 'p.hidden=0 AND p.deleted=0';
  function since30() { return now() - 30 * DAY; }

  // 태그 대표 게시물: 📌 지정 → 30일 점수 1위 → 최신
  function tagRep(key) {
    const t = q('SELECT * FROM tags WHERE key=?').get(key);
    if (t && t.pinned_post) {
      const p = q(`SELECT p.id FROM posts p JOIN post_tags pt ON pt.post_id=p.id WHERE p.id=? AND pt.tag_key=? AND ${VISIBLE}`).get(t.pinned_post, key);
      if (p) return { id: p.id, why: 'pin' };
    }
    const s = since30();
    const top = q(`SELECT p.id, ${SCORE_SQL} AS score FROM posts p JOIN post_tags pt ON pt.post_id=p.id
                   WHERE pt.tag_key=? AND ${VISIBLE} AND EXISTS(SELECT 1 FROM photos ph WHERE ph.post_id=p.id)
                   ORDER BY score DESC, p.id DESC LIMIT 1`).get(s, s, key);
    if (top && top.score > 0) return { id: top.id, why: 'hot', score: top.score };
    const last = q(`SELECT p.id FROM posts p JOIN post_tags pt ON pt.post_id=p.id WHERE pt.tag_key=? AND ${VISIBLE}
                    ORDER BY EXISTS(SELECT 1 FROM photos ph WHERE ph.post_id=p.id) DESC, p.id DESC LIMIT 1`).get(key);
    return last ? { id: last.id, why: 'new' } : null;
  }

  // 모든 태그의 대표 + 글 수 (도감용) — 한 번에 계산
  function allTagReps() {
    const s = since30();
    const rows = q(`
      WITH sc AS (
        SELECT pt.tag_key k, p.id pid, ${SCORE_SQL} s,
               EXISTS(SELECT 1 FROM photos ph WHERE ph.post_id=p.id) hasph
        FROM post_tags pt JOIN posts p ON p.id=pt.post_id WHERE ${VISIBLE}
      ), rk AS (
        SELECT k, pid, s, ROW_NUMBER() OVER (PARTITION BY k ORDER BY hasph DESC, s DESC, pid DESC) rn,
               COUNT(*) OVER (PARTITION BY k) n,
               MAX(pid) OVER (PARTITION BY k) lastpid
        FROM sc
      )
      SELECT t.key, t.label, t.pinned_post, rk.pid, rk.s, rk.n, rk.lastpid
      FROM rk JOIN tags t ON t.key=rk.k WHERE rk.rn=1 AND t.merged_into=''`).all(s, s);
    for (const row of rows) {
      if (row.pinned_post) {
        const ok = q(`SELECT 1 FROM posts p JOIN post_tags pt ON pt.post_id=p.id WHERE p.id=? AND pt.tag_key=? AND ${VISIBLE}`).get(row.pinned_post, row.key);
        if (ok) { row.pid = row.pinned_post; row.why = 'pin'; continue; }
      }
      row.why = row.s > 0 ? 'hot' : 'new';
    }
    return rows;
  }

  // =============================================================
  // 화면용 카드 만들기
  // =============================================================
  function userLevel(u) {
    if (!u) return '';
    if (u.ark_no) return 'ark';
    if (u.cert_n === undefined) {
      const c = q("SELECT COUNT(*) n FROM plants WHERE user_id=? AND cert_status='ok' AND deleted=0").get(u.id);
      u.cert_n = c ? c.n : 0;
    }
    return u.cert_n > 0 ? 'cert' : '';
  }
  // 회원별 활동 수 (등급 계산용) — 한 번에 여러 명
  function activity(userIds) {
    const ids = [...new Set(userIds.filter(Boolean))];
    const out = new Map(ids.map((id) => [id, { posts: 0, comments: 0 }]));
    if (!ids.length) return out;
    const ph = ids.map(() => '?').join(',');
    for (const x of q(`SELECT user_id, COUNT(*) n FROM posts WHERE hidden=0 AND deleted=0 AND user_id IN (${ph}) GROUP BY user_id`).all(...ids)) out.get(x.user_id).posts = x.n;
    for (const x of q(`SELECT c.user_id, COUNT(*) n FROM comments c JOIN posts p ON p.id=c.post_id
                       WHERE c.hidden=0 AND c.deleted=0 AND p.deleted=0 AND p.user_id<>c.user_id AND c.user_id IN (${ph}) GROUP BY c.user_id`).all(...ids)) out.get(x.user_id).comments = x.n;
    return out;
  }
  function withTiers(users) {
    const act = activity(users.map((u) => u && u.id));
    for (const u of users) if (u && u.id) { u.act = act.get(u.id); u.tier = tierOf(u.act); }
    return users;
  }

  function cards(ids, viewer) {
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    const posts = q(`SELECT * FROM posts WHERE id IN (${ph})`).all(...ids);
    const byId = new Map(posts.map((p) => [p.id, p]));
    const photos = q(`SELECT * FROM photos WHERE post_id IN (${ph}) ORDER BY post_id, ord`).all(...ids);
    const likeN = q(`SELECT post_id, COUNT(*) n FROM likes WHERE post_id IN (${ph}) GROUP BY post_id`).all(...ids);
    const cmtN = q(`SELECT post_id, COUNT(*) n FROM comments WHERE post_id IN (${ph}) AND hidden=0 AND deleted=0 GROUP BY post_id`).all(...ids);
    const mine = viewer ? q(`SELECT post_id FROM likes WHERE user_id=? AND post_id IN (${ph})`).all(viewer.id, ...ids) : [];
    const tags = q(`SELECT pt.post_id, t.key, t.label FROM post_tags pt JOIN tags t ON t.key=pt.tag_key WHERE pt.post_id IN (${ph})`).all(...ids);
    const users = new Map();
    const plants = new Map();
    for (const p of posts) {
      if (!users.has(p.user_id)) users.set(p.user_id, q('SELECT id,nick,ark_no,blocked FROM users WHERE id=?').get(p.user_id) || { id: 0, nick: '(탈퇴)' });
      if (p.plant_id && !plants.has(p.plant_id)) plants.set(p.plant_id, q('SELECT id,name,cert_status,cert_no,tag_key,deleted FROM plants WHERE id=?').get(p.plant_id));
    }
    withTiers([...users.values()]);
    const out = [];
    for (const id of ids) {
      const p = byId.get(id); if (!p) continue;
      const u = users.get(p.user_id);
      const pl = p.plant_id ? plants.get(p.plant_id) : null;
      out.push({
        id: p.id, body: p.body, created_at: p.created_at, hidden: p.hidden, user: u, lv: userLevel(u),
        photos: photos.filter((x) => x.post_id === id),
        likes: (likeN.find((x) => x.post_id === id) || {}).n || 0,
        comments: (cmtN.find((x) => x.post_id === id) || {}).n || 0,
        liked: mine.some((x) => x.post_id === id),
        tags: tags.filter((x) => x.post_id === id),
        plant: pl && !pl.deleted ? pl : null,
        mineOwn: !!(viewer && viewer.id === p.user_id),
      });
    }
    return out;
  }
  const PER = 20;
  function canSeeHidden(req) { return req.isAdmin; }

  // =============================================================
  // 화면들
  // =============================================================
  r.get('/healthz', (req, res) => res.send('ok'));
  r.get('/certificate/:id', (req, res) => res.redirect(ARK_URL + '/certificate/' + encodeURIComponent(req.params.id) + (req.query.k ? '?k=' + encodeURIComponent(req.query.k) : '')));

  // 피드
  r.get('/', async (req, res) => {
    await arkData(1500);
    const sort = ['new', 'hot', 'cert'].includes(req.query.sort) ? req.query.sort : 'new';
    const pg = Math.max(0, parseInt(req.query.page, 10) || 0);
    let rows;
    const s = since30();
    if (sort === 'hot') rows = q(`SELECT p.id, ${SCORE_SQL} sc FROM posts p WHERE ${VISIBLE} ORDER BY sc DESC, p.id DESC LIMIT ? OFFSET ?`).all(s, s, PER + 1, pg * PER);
    else if (sort === 'cert') rows = q(`SELECT p.id FROM posts p JOIN plants pl ON pl.id=p.plant_id WHERE ${VISIBLE} AND pl.cert_status='ok' AND pl.deleted=0 ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(PER + 1, pg * PER);
    else rows = q(`SELECT p.id FROM posts p WHERE ${VISIBLE} ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(PER + 1, pg * PER);
    const more = rows.length > PER;
    const list = cards(rows.slice(0, PER).map((x) => x.id), req.user);
    if (req.query.frag) return page(res, '_cards', { list, more, next: `${req.B}/?sort=${sort}&page=${pg + 1}&frag=1` });
    // 위쪽 인기 태그 줄
    const hotTags = allTagReps().sort((a, b) => (b.s - a.s) || (b.n - a.n)).slice(0, 12);
    const hotCards = cards(hotTags.map((t) => t.pid), req.user);
    page(res, 'feed', { list, more, sort, next: `${req.B}/?sort=${sort}&page=${pg + 1}&frag=1`, hotTags, hotCards, title: '' });
  });

  // 글 하나
  r.get('/p/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const p = q('SELECT * FROM posts WHERE id=? AND deleted=0').get(id);
    if (!p || (p.hidden && !canSeeHidden(req) && !(req.user && req.user.id === p.user_id))) return res.status(404), page(res, 'msg', { title: '글을 찾을 수 없습니다', msg: '지워졌거나 숨겨진 글입니다.' });
    const [c] = cards([id], req.user);
    const cmts = q(`SELECT c.*, u.nick, u.ark_no FROM comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.post_id=? AND c.deleted=0 ${req.isAdmin ? '' : 'AND c.hidden=0'} ORDER BY c.id`).all(id);
    const ws = cmts.map((x) => ({ id: x.user_id, ref: x }));
    withTiers(ws).forEach((w) => { w.ref.tier = w.tier; });
    const pins = req.isAdmin ? c.tags.map((t) => ({ key: t.key, label: t.label, pinned: (q('SELECT pinned_post FROM tags WHERE key=?').get(t.key) || {}).pinned_post === id })) : [];
    const base = `${req.protocol}://${req.get('host')}`;
    page(res, 'post', { c, cmts, pins, ogImage: c.photos[0] ? `${base}${req.B}/media/${c.photos[0].file}` : '', title: `${c.user.nick}님의 사진` });
  });

  // 글쓰기
  r.get('/write', async (req, res) => {
    if (!req.user) return loginRedirect(req, res);
    await arkData(1500);
    const plants = q('SELECT * FROM plants WHERE user_id=? AND deleted=0 ORDER BY id DESC').all(req.user.id);
    const popular = q(`SELECT t.key, t.label, COUNT(*) n FROM post_tags pt JOIN tags t ON t.key=pt.tag_key JOIN posts p ON p.id=pt.post_id
                       WHERE ${VISIBLE} AND t.merged_into='' GROUP BY t.key ORDER BY n DESC LIMIT 10`).all();
    if (popular.length < 6) for (const [k, v] of ark.official) { if (popular.length >= 10) break; if (!popular.some((x) => x.key === k)) popular.push({ key: k, label: v.name, n: 0 }); }
    let edit = null;
    if (req.query.edit) {
      edit = q('SELECT * FROM posts WHERE id=? AND user_id=? AND deleted=0').get(parseInt(req.query.edit, 10), req.user.id);
      if (edit) edit.photos = q('SELECT * FROM photos WHERE post_id=? ORDER BY ord').all(edit.id);
    }
    const preTag = req.query.tag ? T.tagWord(tagLabel(T.tagKey(req.query.tag))) : '';
    page(res, 'write', { plants, popular, pick: parseInt(req.query.plant, 10) || (edit ? edit.plant_id : 0), preTag, edit, title: edit ? '글 고치기' : '사진 올리기' });
  });

  // 태그 페이지
  r.get('/t/:key', async (req, res) => {
    await arkData(1500);
    const raw = T.tagKey(req.params.key);
    if (!raw) return res.redirect(req.B + '/dex');
    const key = resolveTag(raw);
    if (key !== raw) return res.redirect(req.B + '/t/' + encodeURIComponent(key));
    const sort = req.query.sort === 'hot' ? 'hot' : 'new';
    const pg = Math.max(0, parseInt(req.query.page, 10) || 0);
    const s = since30();
    const n = (q(`SELECT COUNT(*) n FROM post_tags pt JOIN posts p ON p.id=pt.post_id WHERE pt.tag_key=? AND ${VISIBLE}`).get(key) || {}).n || 0;
    const rows = sort === 'hot'
      ? q(`SELECT p.id, ${SCORE_SQL} sc FROM posts p JOIN post_tags pt ON pt.post_id=p.id WHERE pt.tag_key=? AND ${VISIBLE} ORDER BY sc DESC, p.id DESC LIMIT ? OFFSET ?`).all(s, s, key, 30 + 1, pg * 30)
      : q(`SELECT p.id FROM posts p JOIN post_tags pt ON pt.post_id=p.id WHERE pt.tag_key=? AND ${VISIBLE} ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(key, 30 + 1, pg * 30);
    const more = rows.length > 30;
    const list = cards(rows.slice(0, 30).map((x) => x.id), req.user);
    const rep = tagRep(key);
    const repCard = rep ? cards([rep.id], req.user)[0] : null;
    const official = ark.official.get(key) || null;
    const certN = (q(`SELECT COUNT(DISTINCT pl.id) n FROM plants pl WHERE pl.tag_key=? AND pl.cert_status='ok' AND pl.deleted=0`).get(key) || {}).n || 0;
    const growers = (q(`SELECT COUNT(DISTINCT p.user_id) n FROM posts p JOIN post_tags pt ON pt.post_id=p.id WHERE pt.tag_key=? AND ${VISIBLE}`).get(key) || {}).n || 0;
    const label = tagLabel(key);
    if (req.query.frag) return page(res, '_grid', { list, more, next: `${req.B}/t/${encodeURIComponent(key)}?sort=${sort}&page=${pg + 1}&frag=1` });
    page(res, 'tag', { key, label, word: T.tagWord(label), n, list, more, sort, rep, repCard, official, certN, growers,
      next: `${req.B}/t/${encodeURIComponent(key)}?sort=${sort}&page=${pg + 1}&frag=1`, title: '#' + T.tagWord(label) });
  });

  // 품종 도감
  r.get('/dex', async (req, res) => {
    await arkData(2500);
    const qq = T.tagKey(req.query.q || '');
    const sort = req.query.sort === 'abc' ? 'abc' : 'many';
    let tags = allTagReps();
    const repIds = tags.map((t) => t.pid);
    const repCards = new Map(cards(repIds, req.user).map((c) => [c.id, c]));
    const have = new Set(tags.map((t) => t.key));
    // 방주 등재 품종은 사진이 없어도 칸을 보여준다 (첫 사진을 기다리는 칸)
    const official = [];
    for (const [k, v] of ark.official) {
      const t = tags.find((x) => x.key === k);
      official.push({ key: k, label: v.name, maker: v.maker, n: t ? t.n : 0, rep: t ? repCards.get(t.pid) : null, why: t ? t.why : '' });
    }
    tags = tags.filter((t) => !ark.official.has(t.key)).map((t) => ({ ...t, rep: repCards.get(t.pid) }));
    const match = (x) => !qq || x.key.includes(qq);
    const sorter = sort === 'abc' ? (a, b) => String(a.label).localeCompare(String(b.label), 'ko') : (a, b) => (b.n - a.n) || String(a.label).localeCompare(String(b.label), 'ko');
    page(res, 'dex', { official: official.filter(match).sort(sorter), tags: tags.filter(match).sort(sorter), qtext: req.query.q || '', sort, totalTags: have.size, title: '품종 도감' });
  });

  // 내 온실 / 회원 온실
  r.get('/me', (req, res) => {
    if (!req.user) return loginRedirect(req, res);
    res.redirect(req.B + '/u/' + encodeURIComponent(req.user.nick));
  });
  r.get('/u/:nick', (req, res) => {
    const u = q('SELECT * FROM users WHERE nick_key=?').get(String(req.params.nick || '').toLowerCase());
    if (!u) return res.status(404), page(res, 'msg', { title: '회원을 찾을 수 없습니다', msg: '닉네임을 다시 확인해 주세요.' });
    const own = !!(req.user && req.user.id === u.id);
    const plants = q(`SELECT pl.*, (SELECT COUNT(*) FROM posts p WHERE p.plant_id=pl.id AND ${VISIBLE}) n,
                        (SELECT MAX(p.created_at) FROM posts p WHERE p.plant_id=pl.id AND ${VISIBLE}) last_at,
                        (SELECT ph.thumb FROM photos ph JOIN posts p ON p.id=ph.post_id WHERE p.plant_id=pl.id AND ${VISIBLE} ORDER BY p.id DESC, ph.ord LIMIT 1) cover
                      FROM plants pl WHERE pl.user_id=? AND pl.deleted=0 ORDER BY (pl.cert_status='ok') DESC, last_at DESC, pl.id DESC`).all(u.id);
    const pg = Math.max(0, parseInt(req.query.page, 10) || 0);
    const rows = q(`SELECT p.id FROM posts p WHERE p.user_id=? AND p.deleted=0 ${own || req.isAdmin ? '' : 'AND p.hidden=0'} ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(u.id, 31, pg * 30);
    const list = cards(rows.slice(0, 30).map((x) => x.id), req.user);
    const more = rows.length > 30;
    const next = `${req.B}/u/${encodeURIComponent(u.nick)}?page=${pg + 1}&frag=1`;
    if (req.query.frag) return page(res, '_grid', { list, more, next });
    const stats = {
      posts: (q('SELECT COUNT(*) n FROM posts WHERE user_id=? AND hidden=0 AND deleted=0').get(u.id) || {}).n || 0,
      hearts: (q('SELECT COUNT(*) n FROM likes l JOIN posts p ON p.id=l.post_id WHERE p.user_id=? AND l.user_id<>p.user_id AND p.deleted=0').get(u.id) || {}).n || 0,
    };
    withTiers([u]);
    page(res, 'user', { u, own, plants, list, more, next, stats, TIERS, title: own ? '내 온실' : `${u.nick}님의 온실` });
  });

  // 식물 하나 (성장 기록 + 족보)
  r.get('/plant/:id', (req, res) => {
    const pl = q('SELECT * FROM plants WHERE id=? AND deleted=0').get(parseInt(req.params.id, 10));
    if (!pl) return res.status(404), page(res, 'msg', { title: '식물을 찾을 수 없습니다', msg: '지워진 식물입니다.' });
    const u = q('SELECT * FROM users WHERE id=?').get(pl.user_id);
    const own = !!(req.user && req.user.id === pl.user_id);
    const rows = q(`SELECT p.id FROM posts p WHERE p.plant_id=? AND p.deleted=0 ${own || req.isAdmin ? '' : 'AND p.hidden=0'} ORDER BY p.created_at ASC`).all(pl.id);
    const list = cards(rows.map((x) => x.id), req.user);
    let info = null; try { info = pl.cert_info ? JSON.parse(pl.cert_info) : null; } catch (e) {}
    page(res, 'plant', { pl, u, own, list, info, tagWordStr: pl.tag_key ? T.tagWord(tagLabel(pl.tag_key)) : '', title: pl.name });
  });

  // 등급 안내
  r.get('/levels', (req, res) => {
    if (req.user) withTiers([req.user]);
    page(res, 'levels', { TIERS, title: '클럽 등급' });
  });

  // 로그인
  r.get('/login', (req, res) => {
    const next = String(req.query.next || '');
    page(res, 'login', { next: next.startsWith('/') && !next.startsWith('//') ? next : (req.B + '/'), title: '로그인' });
  });
  r.post('/logout', (req, res) => {
    if (req.sess) q('DELETE FROM sessions WHERE token=?').run(req.sess.token);
    setCookie(req, res, 'x', 0);
    res.redirect(req.B + '/');
  });

  // 홈 화면 설치
  r.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json').send(JSON.stringify({
      name: '하월시아 클럽 · by Jiyang', short_name: '하월시아 클럽',
      start_url: req.B + '/', scope: req.B + '/', display: 'standalone',
      background_color: '#F5F1E6', theme_color: '#1F4129', lang: 'ko',
      icons: [
        { src: req.B + '/static/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: req.B + '/static/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: req.B + '/static/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  });
  r.get('/sw.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-cache').send(
`// 하월시아 클럽 — 화면이 끊겨도 마지막으로 본 화면을 보여주는 정도만 한다
const C='club-${VERSION}';
self.addEventListener('install',e=>{self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const r=e.request; if(r.method!=='GET')return;
  const u=new URL(r.url); if(u.origin!==location.origin)return;
  if(u.pathname.includes('/media/')||u.pathname.includes('/static/')){
    e.respondWith(caches.open(C).then(c=>c.match(r).then(h=>h||fetch(r).then(res=>{if(res.ok)c.put(r,res.clone());return res;}))));return;
  }
  if(r.mode==='navigate'){
    e.respondWith(fetch(r).then(res=>{const cp=res.clone();caches.open(C).then(c=>c.put(r,cp));return res;}).catch(()=>caches.match(r).then(h=>h||new Response('<meta charset=utf-8><p style="font:16px sans-serif;padding:40px">인터넷 연결을 확인해 주세요.</p>',{headers:{'Content-Type':'text/html; charset=utf-8'}}))));
  }
});`);
  });

  // =============================================================
  // 문자 인증 가입·로그인
  // =============================================================
  const hashCode = (phone, code) => crypto.createHmac('sha256', SECRET).update('club-sms:' + phone + ':' + code).digest('hex');
  const signupToken = (phone) => {
    const exp = now() + 20 * 60 * 1000;
    const sig = crypto.createHmac('sha256', SECRET).update('club-signup:' + phone + ':' + exp).digest('hex').slice(0, 24);
    return `${phone}.${exp}.${sig}`;
  };
  const readSignup = (tok) => {
    const [phone, exp, sig] = String(tok || '').split('.');
    if (!phone || !exp || !sig || now() > +exp) return '';
    const want = crypto.createHmac('sha256', SECRET).update('club-signup:' + phone + ':' + exp).digest('hex').slice(0, 24);
    return crypto.timingSafeEqual(Buffer.from(sig.padEnd(24)), Buffer.from(want)) ? phone : '';
  };
  const smsReady = () => !!(process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET && process.env.SENDER_PHONE && messaging.sendText);

  r.post('/api/auth/send', async (req, res) => {
    const phone = T.normPhone(req.body.phone);
    if (!phone) return fail(res, 400, '휴대폰 번호를 확인해 주세요. (010으로 시작하는 번호)');
    if (limited('sms60:' + phone, 1, 60 * 1000)) return fail(res, 429, '문자를 방금 보냈습니다. 1분 뒤에 다시 눌러 주세요.');
    if (limited('smsH:' + phone, 5, 3600 * 1000)) return fail(res, 429, '한 시간에 5번까지만 보낼 수 있습니다. 잠시 뒤에 해 주세요.');
    if (limited('smsIP:' + req.ip, 15, 3600 * 1000)) return fail(res, 429, '요청이 너무 많습니다. 잠시 뒤에 해 주세요.');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    q('UPDATE sms_codes SET used=1 WHERE phone=? AND used=0').run(phone);
    q('INSERT INTO sms_codes(phone,code_hash,ip,created_at) VALUES(?,?,?,?)').run(phone, hashCode(phone, code), req.ip || '', now());
    if (smsReady()) {
      try {
        const text = `[하월시아 클럽] 인증번호 ${code}\n5분 안에 입력해 주세요.`;
        if (messaging.sendSms) await messaging.sendSms({ to: phone, text }); // 짧은 문자(SMS)가 더 싸다
        else await messaging.sendText({ to: phone, subject: '하월시아 클럽', text });
      } catch (e) {
        console.warn('[club] 인증 문자 실패:', e.message);
        return fail(res, 502, '문자 발송에 실패했습니다. 잠시 뒤에 다시 해 주세요.');
      }
      return res.json({ ok: true });
    }
    if (DEV) { console.log('[club] (시험) 인증번호', phone, code); return res.json({ ok: true, dev_code: code }); }
    return fail(res, 503, '문자 발송 설정이 아직 안 되어 있습니다. 운영자에게 알려 주세요.');
  });

  async function arkMemberCheck(u, force) {
    if (!sheets.findApprovedByPhone) return u;
    if (!force && now() - (u.ark_checked_at || 0) < DAY) return u;
    try {
      const m = await withTimeout(sheets.findApprovedByPhone(u.phone), 5000);
      const no = (m && m.회원번호) || '';
      q('UPDATE users SET ark_no=?, ark_checked_at=? WHERE id=?').run(no, now(), u.id);
      u.ark_no = no;
    } catch (e) { /* 시트가 느리면 다음 로그인 때 다시 본다 */ }
    return u;
  }

  r.post('/api/auth/verify', async (req, res) => {
    const phone = T.normPhone(req.body.phone);
    const code = T.digits(req.body.code);
    if (!phone || code.length !== 6) return fail(res, 400, '인증번호 6자리를 넣어 주세요.');
    const row = q('SELECT * FROM sms_codes WHERE phone=? AND used=0 ORDER BY id DESC LIMIT 1').get(phone);
    if (!row || now() - row.created_at > 5 * 60 * 1000) return fail(res, 400, '인증번호가 만료되었습니다. 다시 받아 주세요.');
    if (row.tries >= 5) return fail(res, 429, '5번 틀려서 막혔습니다. 인증번호를 다시 받아 주세요.');
    if (hashCode(phone, code) !== row.code_hash) {
      q('UPDATE sms_codes SET tries=tries+1 WHERE id=?').run(row.id);
      return fail(res, 400, `인증번호가 맞지 않습니다. (${4 - row.tries}번 남음)`);
    }
    q('UPDATE sms_codes SET used=1 WHERE id=?').run(row.id);
    const u = q('SELECT * FROM users WHERE phone=?').get(phone);
    if (!u) return res.json({ ok: true, signup: signupToken(phone) });
    if (u.blocked) return fail(res, 403, '이용이 제한된 계정입니다. 운영자에게 문의해 주세요.');
    newSession(req, res, u.id, req.isAdmin);
    await arkMemberCheck(u, false);
    res.json({ ok: true, nick: u.nick });
  });

  r.post('/api/auth/signup', async (req, res) => {
    const phone = readSignup(req.body.signup);
    if (!phone) return fail(res, 400, '인증 시간이 지났습니다. 처음부터 다시 해 주세요.');
    if (!req.body.agree) return fail(res, 400, '개인정보 수집·이용에 동의해 주세요.');
    const n = T.checkNick(req.body.nick);
    if (n.error) return fail(res, 400, n.error);
    if (q('SELECT 1 FROM users WHERE nick_key=?').get(n.key)) return fail(res, 409, '이미 쓰는 닉네임입니다. 다른 이름으로 해 주세요.');
    let u = q('SELECT * FROM users WHERE phone=?').get(phone);
    if (!u) {
      const info = q('INSERT INTO users(phone,nick,nick_key,created_at) VALUES(?,?,?,?)').run(phone, n.nick, n.key, now());
      u = q('SELECT * FROM users WHERE id=?').get(Number(info.lastInsertRowid));
    }
    newSession(req, res, u.id, req.isAdmin);
    await arkMemberCheck(u, true);
    res.json({ ok: true, nick: u.nick, ark: !!u.ark_no });
  });

  r.post('/api/me/edit', (req, res) => {
    if (!needUser(req, res)) return;
    const bio = String(req.body.bio || '').trim().slice(0, 120);
    let nick = req.user.nick, key = req.user.nick_key;
    if (req.body.nick !== undefined && String(req.body.nick).trim() !== req.user.nick) {
      const n = T.checkNick(req.body.nick);
      if (n.error) return fail(res, 400, n.error);
      const ex = q('SELECT id FROM users WHERE nick_key=?').get(n.key);
      if (ex && ex.id !== req.user.id) return fail(res, 409, '이미 쓰는 닉네임입니다.');
      nick = n.nick; key = n.key;
    }
    q('UPDATE users SET nick=?, nick_key=?, bio=? WHERE id=?').run(nick, key, bio, req.user.id);
    res.json({ ok: true, nick });
  });

  // =============================================================
  // 글 올리기·고치기·지우기
  // =============================================================
  const up = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, PHOTO_DIR),
      filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + (/png/i.test(file.mimetype) ? '.png' : /webp/i.test(file.mimetype) ? '.webp' : '.jpg')),
    }),
    limits: { fileSize: 12 * 1024 * 1024, files: 20, fields: 60 },
    fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype || '')),
  });
  function upAny(req, res, next) {
    up.any()(req, res, (err) => {
      if (err) return fail(res, 400, err.code === 'LIMIT_FILE_SIZE' ? '사진 한 장이 너무 큽니다. (12MB 까지)' : '사진을 올리지 못했습니다: ' + err.message);
      next();
    });
  }
  function dropFiles(files) { for (const f of files || []) fs.unlink(f.path, () => {}); }

  function pickPlant(req, body) {
    let plantId = parseInt(body.plant_id, 10) || 0;
    let plant = null;
    if (plantId) {
      plant = q('SELECT * FROM plants WHERE id=? AND user_id=? AND deleted=0').get(plantId, req.user.id);
      if (!plant) throw new Error('내 식물이 아닙니다.');
    }
    const newName = String(body.new_plant || '').trim().slice(0, 40);
    if (!plant && newName) {
      const tags = T.parseTags(body.body || '');
      const tk = T.tagKey(newName);
      const tagK = ark.names.has(tk) ? tk : (tags[0] ? tags[0].key : tk);
      const info = q('INSERT INTO plants(user_id,name,tag_key,created_at) VALUES(?,?,?,?)').run(req.user.id, newName, resolveTag(tagK), now());
      plant = q('SELECT * FROM plants WHERE id=?').get(Number(info.lastInsertRowid));
    }
    return plant;
  }

  r.post('/api/posts', upAny, async (req, res) => {
    const files = req.files || [];
    try {
      if (!needUser(req, res)) return dropFiles(files);
      await arkData(2500);
      const body = String(req.body.body || '').trim().slice(0, 2000);
      const full = {}, thumb = {};
      for (const f of files) {
        const m = /^([ft])(\d{1,2})$/.exec(f.fieldname);
        if (!m) { dropFiles([f]); continue; }
        (m[1] === 'f' ? full : thumb)[m[2]] = f;
      }
      const idx = Object.keys(full).map(Number).sort((a, b) => a - b).slice(0, 10);
      if (!idx.length && !body) { dropFiles(files); return fail(res, 400, '사진이나 글을 넣어 주세요.'); }
      if (limited('post:' + req.user.id, 30, DAY)) { dropFiles(files); return fail(res, 429, '하루에 30개까지 올릴 수 있습니다.'); }
      const result = tx(db, () => {
        const plant = pickPlant(req, req.body);
        const info = q('INSERT INTO posts(user_id,plant_id,body,created_at) VALUES(?,?,?,?)').run(req.user.id, plant ? plant.id : null, body, now());
        const pid = Number(info.lastInsertRowid);
        idx.forEach((i, ord) => {
          const f = full[i]; const t = thumb[i] || f;
          q('INSERT INTO photos(post_id,file,thumb,w,h,ord) VALUES(?,?,?,?,?,?)').run(pid, f.filename, t.filename,
            parseInt(req.body['w' + i], 10) || 0, parseInt(req.body['h' + i], 10) || 0, ord);
        });
        const used = new Set(idx.flatMap((i) => [full[i].filename, (thumb[i] || full[i]).filename]));
        dropFiles(files.filter((f) => !used.has(f.filename)));
        const tags = setPostTags(pid, body, plant);
        return { id: pid, tags, plant: plant ? plant.id : null };
      });
      res.json({ ok: true, ...result, url: `${req.B}/p/${result.id}` });
    } catch (e) {
      dropFiles(files);
      if (!res.headersSent) fail(res, 400, e.message);
    }
  });

  r.post('/api/posts/:id/edit', async (req, res) => {
    if (!needUser(req, res)) return;
    const p = q('SELECT * FROM posts WHERE id=? AND deleted=0').get(parseInt(req.params.id, 10));
    if (!p || p.user_id !== req.user.id) return fail(res, 404, '내 글이 아닙니다.');
    await arkData(2500);
    try {
      const body = String(req.body.body || '').trim().slice(0, 2000);
      tx(db, () => {
        const plant = pickPlant(req, req.body);
        q('UPDATE posts SET body=?, plant_id=?, edited_at=? WHERE id=?').run(body, plant ? plant.id : null, now(), p.id);
        setPostTags(p.id, body, plant);
      });
      res.json({ ok: true, url: `${req.B}/p/${p.id}` });
    } catch (e) { fail(res, 400, e.message); }
  });

  r.post('/api/posts/:id/delete', (req, res) => {
    if (!needUser(req, res)) return;
    const p = q('SELECT * FROM posts WHERE id=? AND deleted=0').get(parseInt(req.params.id, 10));
    if (!p || (p.user_id !== req.user.id && !req.isAdmin)) return fail(res, 404, '내 글이 아닙니다.');
    q('UPDATE posts SET deleted=1 WHERE id=?').run(p.id);
    q('UPDATE tags SET pinned_post=NULL WHERE pinned_post=?').run(p.id);
    res.json({ ok: true });
  });

  r.post('/api/posts/:id/like', (req, res) => {
    if (!needUser(req, res)) return;
    const p = q(`SELECT id FROM posts p WHERE id=? AND ${VISIBLE}`).get(parseInt(req.params.id, 10));
    if (!p) return fail(res, 404, '글이 없습니다.');
    const had = q('SELECT 1 FROM likes WHERE post_id=? AND user_id=?').get(p.id, req.user.id);
    if (had) q('DELETE FROM likes WHERE post_id=? AND user_id=?').run(p.id, req.user.id);
    else q('INSERT INTO likes(post_id,user_id,created_at) VALUES(?,?,?)').run(p.id, req.user.id, now());
    const n = q('SELECT COUNT(*) n FROM likes WHERE post_id=?').get(p.id).n;
    res.json({ ok: true, liked: !had, n });
  });

  r.post('/api/posts/:id/comments', (req, res) => {
    if (!needUser(req, res)) return;
    const p = q(`SELECT id FROM posts p WHERE id=? AND ${VISIBLE}`).get(parseInt(req.params.id, 10));
    if (!p) return fail(res, 404, '글이 없습니다.');
    const body = String(req.body.body || '').trim().slice(0, 500);
    if (!body) return fail(res, 400, '댓글을 적어 주세요.');
    if (limited('cmt:' + req.user.id, 100, DAY)) return fail(res, 429, '하루 댓글 수를 넘었습니다.');
    const info = q('INSERT INTO comments(post_id,user_id,body,created_at) VALUES(?,?,?,?)').run(p.id, req.user.id, body, now());
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });

  r.post('/api/comments/:id/delete', (req, res) => {
    if (!needUser(req, res)) return;
    const c = q('SELECT * FROM comments WHERE id=? AND deleted=0').get(parseInt(req.params.id, 10));
    if (!c || (c.user_id !== req.user.id && !req.isAdmin)) return fail(res, 404, '내 댓글이 아닙니다.');
    q('UPDATE comments SET deleted=1 WHERE id=?').run(c.id);
    res.json({ ok: true });
  });

  r.post('/api/report', (req, res) => {
    if (!needUser(req, res)) return;
    const postId = parseInt(req.body.post_id, 10) || null;
    const cmtId = parseInt(req.body.comment_id, 10) || null;
    if (!postId && !cmtId) return fail(res, 400, '무엇을 신고하는지 알 수 없습니다.');
    if (limited('rep:' + req.user.id, 20, DAY)) return fail(res, 429, '신고가 너무 많습니다.');
    q('INSERT INTO reports(post_id,comment_id,user_id,reason,created_at) VALUES(?,?,?,?,?)').run(postId, cmtId, req.user.id, String(req.body.reason || '').slice(0, 200), now());
    if (messaging.sendAdminAlert) messaging.sendAdminAlert(`[하월시아 클럽] 신고 접수\n${postId ? '글 #' + postId : '댓글 #' + cmtId}\n${String(req.body.reason || '').slice(0, 60)}`).catch(() => {});
    res.json({ ok: true });
  });

  // 태그 자동완성
  r.get('/api/tags', async (req, res) => {
    await arkData(1200);
    const k = T.tagKey(req.query.q || '');
    const out = [];
    const seen = new Set();
    const rows = k
      ? q(`SELECT t.key, t.label, COUNT(p.id) n FROM tags t LEFT JOIN post_tags pt ON pt.tag_key=t.key LEFT JOIN posts p ON p.id=pt.post_id AND ${VISIBLE}
           WHERE t.merged_into='' AND instr(t.key, ?)>0 GROUP BY t.key ORDER BY (substr(t.key,1,length(?))=?) DESC, n DESC LIMIT 12`).all(k, k, k)
      : q(`SELECT t.key, t.label, COUNT(p.id) n FROM tags t JOIN post_tags pt ON pt.tag_key=t.key JOIN posts p ON p.id=pt.post_id AND ${VISIBLE}
           WHERE t.merged_into='' GROUP BY t.key ORDER BY n DESC LIMIT 12`).all();
    for (const x of rows) { seen.add(x.key); out.push({ key: x.key, word: T.tagWord(x.label), label: x.label, n: x.n, ark: ark.official.has(x.key) }); }
    if (k) {
      const extra = [];
      for (const [kk, name] of ark.names) {
        if (seen.has(kk) || !kk.includes(k)) continue;
        extra.push({ key: kk, word: T.tagWord(name), label: name, n: 0, ark: ark.official.has(kk), pre: kk.startsWith(k) });
      }
      extra.sort((a, b) => (b.ark - a.ark) || (b.pre - a.pre) || a.label.localeCompare(b.label, 'ko'));
      out.push(...extra.slice(0, Math.max(0, 14 - out.length)));
    }
    res.json({ ok: true, list: out.slice(0, 14) });
  });

  // =============================================================
  // 내 식물 · 보증서 연결
  // =============================================================
  r.post('/api/plants', (req, res) => {
    if (!needUser(req, res)) return;
    const name = String(req.body.name || '').trim().slice(0, 40);
    if (!name) return fail(res, 400, '식물 이름을 적어 주세요.');
    if ((q('SELECT COUNT(*) n FROM plants WHERE user_id=? AND deleted=0').get(req.user.id) || {}).n >= 500) return fail(res, 400, '식물은 500개까지 등록할 수 있습니다.');
    const tk = resolveTag(T.tagKey(name));
    const info = q('INSERT INTO plants(user_id,name,tag_key,created_at) VALUES(?,?,?,?)').run(req.user.id, name, tk, now());
    res.json({ ok: true, id: Number(info.lastInsertRowid), url: `${req.B}/plant/${Number(info.lastInsertRowid)}` });
  });
  r.post('/api/plants/:id/edit', (req, res) => {
    if (!needUser(req, res)) return;
    const pl = q('SELECT * FROM plants WHERE id=? AND user_id=? AND deleted=0').get(parseInt(req.params.id, 10), req.user.id);
    if (!pl) return fail(res, 404, '내 식물이 아닙니다.');
    const name = String(req.body.name || '').trim().slice(0, 40);
    if (!name) return fail(res, 400, '이름을 적어 주세요.');
    const tk = pl.cert_status === 'ok' ? pl.tag_key : resolveTag(T.tagKey(name));
    q('UPDATE plants SET name=?, tag_key=? WHERE id=?').run(name, tk, pl.id);
    res.json({ ok: true });
  });
  r.post('/api/plants/:id/delete', (req, res) => {
    if (!needUser(req, res)) return;
    const pl = q('SELECT * FROM plants WHERE id=? AND user_id=? AND deleted=0').get(parseInt(req.params.id, 10), req.user.id);
    if (!pl) return fail(res, 404, '내 식물이 아닙니다.');
    q('UPDATE plants SET deleted=1 WHERE id=?').run(pl.id);
    q('UPDATE posts SET plant_id=NULL WHERE plant_id=?').run(pl.id); // 글은 남기고 식물 연결만 푼다
    res.json({ ok: true, url: `${req.B}/me` });
  });

  // 보증서 연결: ① 문자로 받은 구매자 전용 링크(?k=) → 바로 정품 / ② 넘버만 → 등록 번호가 같으면 바로, 아니면 운영자 확인
  function parseCertInput(s) {
    const str = String(s || '').trim();
    const m = /certificate\/([^?#\s]+)(?:\?[^#\s]*?\bk=([0-9a-fA-F]+))?/.exec(str);
    if (m) { let id = m[1]; try { id = decodeURIComponent(id); } catch (e) {} return { id: id.trim(), k: (m[2] || '').toLowerCase() }; }
    return { id: str.replace(/\s+/g, ''), k: '' };
  }
  const certKeyOf = (id) => String(id || '').replace(/[\s\-_.]/g, '').toUpperCase();

  r.post('/api/plants/:id/cert', async (req, res) => {
    if (!needUser(req, res)) return;
    const pl = q('SELECT * FROM plants WHERE id=? AND user_id=? AND deleted=0').get(parseInt(req.params.id, 10), req.user.id);
    if (!pl) return fail(res, 404, '내 식물이 아닙니다.');
    const { id, k } = parseCertInput(req.body.input);
    if (!id || id.length < 4) return fail(res, 400, '보증서 링크나 넘버를 넣어 주세요.');
    if (limited('cert:' + req.user.id, 10, 3600 * 1000)) return fail(res, 429, '한 시간에 10번까지 확인할 수 있습니다.');
    const ck = certKeyOf(id);
    const taken = q("SELECT pl.id, u.nick FROM plants pl JOIN users u ON u.id=pl.user_id WHERE pl.cert_key=? AND pl.cert_status='ok' AND pl.deleted=0 AND pl.id<>?").get(ck, pl.id);
    if (taken) return fail(res, 409, '이 넘버는 이미 다른 회원의 식물에 정품으로 연결되어 있습니다. 소유권 이전을 했다면 운영자에게 알려 주세요.');
    let info = null, auto = false, how = '';
    try {
      const plant = sheets.findById ? await withTimeout(sheets.findById(id), 8000) : null;
      if (plant) {
        const hist = String(plant['소유이력'] || '').split('\n').filter((x) => x.trim());
        info = { 고유번호: plant['고유번호'], 품종명: plant['품종명'], 등급: plant['등급'], 육종가: plant['육종가'], 육종연도: plant['육종연도'],
          모본: plant['모본'], 부본: plant['부본'], 상태: plant['상태'], 사진URL: plant['사진URL'], 이력수: hist.length, 출처: '보증서' };
        if (k && k === String(certToken(plant['고유번호']) || '').toLowerCase()) { auto = true; how = '구매자 전용 링크'; }
        else if (k && k === String(certToken(id) || '').toLowerCase()) { auto = true; how = '구매자 전용 링크'; }
      } else if (sheets.findRoyalByNumber) {
        const row = await withTimeout(sheets.findRoyalByNumber(id), 8000);
        if (row) {
          info = { 고유번호: id, 품종명: row.이름미리보기 || '', 등급: '', 출처: '등급 시트(' + row._sheet + ')' };
          if (T.digits(row.제출자연락처) && T.digits(row.제출자연락처) === req.user.phone) { auto = true; how = '정품 등록 번호 일치'; }
        }
      }
    } catch (e) {
      return fail(res, 503, '방주 장부를 읽지 못했습니다. 잠시 뒤에 다시 해 주세요.');
    }
    if (!info) return fail(res, 404, '방주에서 찾을 수 없는 넘버입니다. 보증서에 적힌 넘버를 그대로 넣어 주세요.');
    if (auto && info.상태 && !/정품/.test(info.상태)) auto = false; // 보증서가 아직 미인증이면 운영자 확인
    const status = auto ? 'ok' : 'pending';
    const vname = String(info.품종명 || '').split('\n')[0].trim();
    const tk = vname ? resolveTag(T.tagKey(vname)) : pl.tag_key;
    if (vname) ensureTag(tk, vname);
    q('UPDATE plants SET cert_no=?, cert_key=?, cert_status=?, cert_info=?, cert_note=?, cert_at=?, tag_key=? WHERE id=?')
      .run(String(info.고유번호 || id), ck, status, JSON.stringify(info), how, now(), tk || pl.tag_key, pl.id);
    // 이 식물로 올린 글들에도 품종 태그를 붙인다
    for (const p of q('SELECT * FROM posts WHERE plant_id=? AND deleted=0').all(pl.id)) setPostTags(p.id, p.body, { tag_key: tk || pl.tag_key, name: pl.name });
    if (!auto && messaging.sendAdminAlert) messaging.sendAdminAlert(`[하월시아 클럽] 보증서 연결 확인 요청\n${req.user.nick} · ${info.고유번호} ${vname}`).catch(() => {});
    res.json({ ok: true, status, how });
  });
  r.post('/api/plants/:id/cert/remove', (req, res) => {
    if (!needUser(req, res)) return;
    const pl = q('SELECT * FROM plants WHERE id=? AND user_id=? AND deleted=0').get(parseInt(req.params.id, 10), req.user.id);
    if (!pl) return fail(res, 404, '내 식물이 아닙니다.');
    q("UPDATE plants SET cert_no='', cert_key='', cert_status='', cert_info='', cert_note='', cert_at=0 WHERE id=?").run(pl.id);
    res.json({ ok: true });
  });

  // =============================================================
  // 운영자
  // =============================================================
  r.get('/admin', async (req, res) => {
    if (!req.isAdmin) return page(res, 'admin_login', { error: null, title: '운영자' });
    await arkData(1500);
    const pending = q(`SELECT pl.*, u.nick, u.phone,
        (SELECT ph.thumb FROM photos ph JOIN posts p ON p.id=ph.post_id WHERE p.plant_id=pl.id AND p.deleted=0 ORDER BY p.id DESC, ph.ord LIMIT 1) cover
      FROM plants pl JOIN users u ON u.id=pl.user_id WHERE pl.cert_status='pending' AND pl.deleted=0 ORDER BY pl.cert_at`).all();
    for (const p of pending) { try { p.info = JSON.parse(p.cert_info || '{}'); } catch (e) { p.info = {}; } }
    const reports = q(`SELECT rp.*, u.nick FROM reports rp LEFT JOIN users u ON u.id=rp.user_id WHERE rp.done=0 ORDER BY rp.id DESC LIMIT 100`).all();
    const tagRows = q(`SELECT t.key, t.label, t.pinned_post, COUNT(p.id) n FROM tags t LEFT JOIN post_tags pt ON pt.tag_key=t.key LEFT JOIN posts p ON p.id=pt.post_id AND ${VISIBLE}
                       WHERE t.merged_into='' GROUP BY t.key ORDER BY n DESC, t.label LIMIT 600`).all();
    const typos = [];
    for (let i = 0; i < tagRows.length && typos.length < 30; i++) for (let j = i + 1; j < tagRows.length && typos.length < 30; j++) {
      const a = tagRows[i], b = tagRows[j];
      if (T.nearlySame(a.key, b.key)) {
        const big = (ark.names.has(a.key) || a.n >= b.n) && !ark.names.has(b.key) ? a : (ark.names.has(b.key) ? b : (a.n >= b.n ? a : b));
        typos.push({ from: big === a ? b : a, to: big });
      }
    }
    const hidden = cards(q('SELECT id FROM posts WHERE hidden=1 AND deleted=0 ORDER BY id DESC LIMIT 50').all().map((x) => x.id), req.user);
    const stats = {
      users: q('SELECT COUNT(*) n FROM users').get().n,
      posts: q('SELECT COUNT(*) n FROM posts WHERE deleted=0').get().n,
      week: q('SELECT COUNT(*) n FROM posts WHERE deleted=0 AND created_at>=?').get(now() - 7 * DAY).n,
      certs: q("SELECT COUNT(*) n FROM plants WHERE cert_status='ok' AND deleted=0").get().n,
      ark: q("SELECT COUNT(*) n FROM users WHERE ark_no<>''").get().n,
    };
    const users = q(`SELECT u.*, (SELECT COUNT(*) FROM posts p WHERE p.user_id=u.id AND p.deleted=0) n FROM users u ORDER BY u.id DESC LIMIT 200`).all();
    page(res, 'admin', { pending, reports, tagRows, typos, hidden, stats, users, arkReady: ark.t > 0, arkOfficial: ark.official.size, arkNames: ark.names.size, title: '운영자' });
  });
  r.post('/admin/login', (req, res) => {
    if (limited('adm:' + req.ip, 10, 15 * 60 * 1000)) return page(res, 'admin_login', { error: '잠시 뒤에 다시 해 주세요.', title: '운영자' });
    const a = Buffer.from(String(req.body.password || '')); const b = Buffer.from(String(ADMIN_PASSWORD));
    if (!ADMIN_PASSWORD || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return page(res, 'admin_login', { error: '비밀번호가 올바르지 않습니다.', title: '운영자' });
    newSession(req, res, req.user ? req.user.id : null, true);
    res.redirect(req.B + '/admin');
  });
  r.post('/admin/logout', (req, res) => {
    if (req.sess) q('UPDATE sessions SET admin=0 WHERE token=?').run(req.sess.token);
    res.redirect(req.B + '/');
  });

  r.post('/api/admin/pin', (req, res) => {
    if (!needAdmin(req, res)) return;
    const key = resolveTag(T.tagKey(req.body.tag));
    const postId = parseInt(req.body.post_id, 10) || null;
    if (!q('SELECT 1 FROM tags WHERE key=?').get(key)) return fail(res, 404, '없는 태그입니다.');
    if (postId && !q('SELECT 1 FROM post_tags WHERE post_id=? AND tag_key=?').get(postId, key)) return fail(res, 400, '이 태그가 붙은 글이 아닙니다.');
    q('UPDATE tags SET pinned_post=? WHERE key=?').run(postId, key);
    res.json({ ok: true });
  });
  r.post('/api/admin/hide', (req, res) => {
    if (!needAdmin(req, res)) return;
    const id = parseInt(req.body.post_id, 10);
    q('UPDATE posts SET hidden=? WHERE id=?').run(req.body.hidden ? 1 : 0, id);
    if (req.body.hidden) q('UPDATE tags SET pinned_post=NULL WHERE pinned_post=?').run(id);
    res.json({ ok: true });
  });
  r.post('/api/admin/comment-hide', (req, res) => {
    if (!needAdmin(req, res)) return;
    q('UPDATE comments SET hidden=? WHERE id=?').run(req.body.hidden ? 1 : 0, parseInt(req.body.comment_id, 10));
    res.json({ ok: true });
  });
  r.post('/api/admin/merge', async (req, res) => {
    if (!needAdmin(req, res)) return;
    const from = resolveTag(T.tagKey(req.body.from));
    const to = resolveTag(T.tagKey(req.body.to));
    if (!from || !to) return fail(res, 400, '태그를 둘 다 적어 주세요.');
    if (from === to) return fail(res, 400, '같은 태그입니다.');
    if (!q('SELECT 1 FROM tags WHERE key=?').get(from)) return fail(res, 404, `#${req.body.from} 태그가 없습니다.`);
    await arkData(0);
    const moved = tx(db, () => {
      ensureTag(to, String(req.body.to || '').replace(/^#/, ''));
      const rows = q('SELECT post_id FROM post_tags WHERE tag_key=?').all(from);
      for (const x of rows) q('INSERT OR IGNORE INTO post_tags(post_id,tag_key) VALUES(?,?)').run(x.post_id, to);
      q('DELETE FROM post_tags WHERE tag_key=?').run(from);
      q('UPDATE plants SET tag_key=? WHERE tag_key=?').run(to, from);
      q("UPDATE tags SET merged_into=?, pinned_post=NULL WHERE key=?").run(to, from);
      q("UPDATE tags SET merged_into=? WHERE merged_into=?").run(to, from);
      return rows.length;
    });
    res.json({ ok: true, moved, to });
  });
  r.post('/api/admin/label', (req, res) => {
    if (!needAdmin(req, res)) return;
    const key = resolveTag(T.tagKey(req.body.tag));
    const label = String(req.body.label || '').trim().slice(0, 40);
    if (!label || T.tagKey(label) !== key) return fail(res, 400, '보이는 이름만 바꿀 수 있습니다. (띄어쓰기·대소문자 정도)');
    q('UPDATE tags SET label=? WHERE key=?').run(label, key);
    res.json({ ok: true });
  });
  r.post('/api/admin/cert', (req, res) => {
    if (!needAdmin(req, res)) return;
    const pl = q('SELECT * FROM plants WHERE id=? AND deleted=0').get(parseInt(req.body.plant_id, 10));
    if (!pl) return fail(res, 404, '식물이 없습니다.');
    if (req.body.action === 'approve') {
      const taken = q("SELECT id FROM plants WHERE cert_key=? AND cert_status='ok' AND deleted=0 AND id<>?").get(pl.cert_key, pl.id);
      if (taken) return fail(res, 409, '이 넘버는 이미 다른 식물에 정품으로 연결되어 있습니다.');
      q("UPDATE plants SET cert_status='ok', cert_note=?, cert_at=? WHERE id=?").run('운영자 확인', now(), pl.id);
    } else {
      q("UPDATE plants SET cert_status='rejected', cert_note=? WHERE id=?").run(String(req.body.note || '운영자 확인 불가').slice(0, 100), pl.id);
    }
    res.json({ ok: true });
  });
  r.post('/api/admin/block', (req, res) => {
    if (!needAdmin(req, res)) return;
    const id = parseInt(req.body.user_id, 10);
    q('UPDATE users SET blocked=? WHERE id=?').run(req.body.blocked ? 1 : 0, id);
    if (req.body.blocked) q('DELETE FROM sessions WHERE user_id=? AND admin=0').run(id);
    res.json({ ok: true });
  });
  r.post('/api/admin/report-done', (req, res) => {
    if (!needAdmin(req, res)) return;
    q('UPDATE reports SET done=1 WHERE id=?').run(parseInt(req.body.id, 10));
    res.json({ ok: true });
  });
  r.post('/api/admin/ark-refresh', async (req, res) => {
    if (!needAdmin(req, res)) return;
    await refreshArk();
    res.json({ ok: true, official: ark.official.size, names: ark.names.size });
  });

  r.use((req, res) => { res.status(404); page(res, 'msg', { title: '페이지가 없습니다', msg: '주소를 다시 확인해 주세요.' }); });
  r.use((err, req, res, next) => {
    console.error('[club] 오류:', err);
    if (res.headersSent) return;
    res.status(500);
    if (req.path.startsWith('/api/')) return res.json({ ok: false, error: '서버 오류: ' + err.message });
    page(res, 'msg', { title: '잠깐 문제가 생겼습니다', msg: '다시 시도해 주세요.' });
  });

  // ---- 매일 데이터베이스 사본 (14일치) ----
  const BK = path.join(DATA_DIR, 'backups');
  function backup() {
    try {
      fs.mkdirSync(BK, { recursive: true });
      const f = path.join(BK, 'club-' + T.ymd(now()).replace(/\./g, '-') + '.db');
      if (!fs.existsSync(f)) db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
      const list = fs.readdirSync(BK).filter((x) => /^club-.*\.db$/.test(x)).sort();
      while (list.length > 14) fs.unlinkSync(path.join(BK, list.shift()));
    } catch (e) { console.warn('[club] 백업 실패:', e.message); }
  }
  setTimeout(backup, 4 * 60 * 1000).unref();
  setInterval(backup, 6 * 3600 * 1000).unref();

  // 방주 가입 신청(/join)에서 쓰는 것: 휴대폰 번호로 클럽 활동 확인
  function statsByPhone(phone) {
    const u = q('SELECT * FROM users WHERE phone=?').get(T.normPhone(phone));
    if (!u) return { found: false, posts: 0, comments: 0, tier: tierOf({}) };
    withTiers([u]);
    return { found: true, nick: u.nick, posts: u.act.posts, comments: u.act.comments, tier: u.tier, ark: !!u.tier.ark, blocked: !!u.blocked };
  }

  console.log('🌿 하월시아 클럽이 켜졌습니다. 데이터: ' + DATA_DIR);
  return { db, router: r, refreshArk, statsByPhone, TIERS };
}

module.exports = { mountClub, TIERS, tierOf };
