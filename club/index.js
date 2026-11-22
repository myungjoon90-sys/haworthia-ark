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
const I18N = require('./i18n');
const { makeNotify } = require('./notify');
const { makeShop } = require('./shop');
const { makeEvent } = require('./event');
const I18N_DICT = require('./i18n_dict');
const qrcode = require('qrcode-generator');

const VIEWS = path.join(__dirname, 'views');
const PUBLIC = path.join(__dirname, 'public');
const VERSION = 'club-10';  // v32c PC 사진 넘김 화살표 — 폰이 새 club.js·css 를 받도록

// ---- 활동 등급 (사장님 결정 2026-11-15 보석형 · 2026-11-16 기준 바꿈: 실버 10/20 · 골드 30/60 · 플래티넘 70/140 · 다이아 150/300) ----
//  글 = 숨김·삭제 안 된 내 글 / 댓글 = 남의 글에 단 댓글 (내 글에 단 것·숨김·삭제 제외)
//  💎 다이아 = 방주 가입 요건 1개 충족 (방주 /join 에서 휴대폰 번호로 자동 확인)
const TIERS = [
  { key: 'bronze', name: '브론즈', icon: '🥉', posts: 0, comments: 0 },
  { key: 'silver', name: '실버', icon: '🥈', posts: 10, comments: 20 },
  { key: 'gold', name: '골드', icon: '🥇', posts: 30, comments: 60 },
  { key: 'platinum', name: '플래티넘', icon: '💠', posts: 70, comments: 140 },
  { key: 'diamond', name: '다이아', icon: '💎', posts: 150, comments: 300, ark: true },
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
  // 알림·폰 알림 (notify.js) · 「지양에서 판매 중」 (shop.js) — v29
  const notify = makeNotify({ db, q, T, I18N, DEV });
  const shop = makeShop({ q, T, DEV });
  const ev = makeEvent({ q, now });
  // 운영자가 적은 글(이벤트 이름·상품)은 번역표에 있을 때만 바꿈 — 나머지는 적은 그대로
  const tfOf = (t) => (x) => (I18N_DICT[x] ? t(x) : x);
  // 피드 맨 위 이벤트 띠 (켜져 있고 시작한 뒤에만)
  function eventBand(req) {
    const c = ev.cfg();
    if (!c.on) return null;
    const st = ev.state();
    if (st.phase === 'soon') return null;
    const my = req.user ? ev.mine(st, req.user.id) : null;
    return { phase: st.phase, cfg: c, groups: ev.groups(st.cfg.prizes), myRank: my && my.me ? my.me.rank : 0, endYmd: ev.kstYmd(c.end) };
  }

  app.set('trust proxy', 1);

  // ---- 커뮤니티 주소(community. / club.)로 들어오면 /club 아래로 ----
  //  CLUB_HOSTS: 커뮤니티로 볼 주소 앞부분 (기본 community., club.)
  //  CLUB_URL  : 대표 주소 (예: https://community.haworthia.co.kr). 넣으면 방주 주소의 /club 은 그리로 넘긴다
  const CLUB_HOSTS = String(process.env.CLUB_HOSTS || 'community.,club.').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const CLUB_URL = String(process.env.CLUB_URL || '').replace(/\/$/, '');
  app.use((req, res, next) => {
    const host = String(req.headers.host || '').toLowerCase();
    req.clubHost = CLUB_HOSTS.some((p) => host.startsWith(p));
    const inClub = req.url === '/club' || req.url.startsWith('/club/') || req.url.startsWith('/club?');
    if (req.clubHost && !inClub) {
      req.url = '/club' + (req.url === '/' ? '' : req.url);
    } else if (!req.clubHost && inClub && CLUB_URL && req.method === 'GET' && !req.url.startsWith('/club/media/') && !req.url.startsWith('/club/static/')) {
      return res.redirect(301, CLUB_URL + (req.url.slice(5) || '/'));
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
    // ---- 화면 언어: ?lang= → 쿠키 → 폰·브라우저 언어 ----
    const ql = String(req.query.lang || '');
    if (req.method === 'GET' && I18N.CODES.includes(ql)) {
      const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
      res.append('Set-Cookie', `club_lang=${ql}; Path=/; SameSite=Lax; Max-Age=${365 * 24 * 3600}${secure ? '; Secure' : ''}`);
      const u = new URL(req.originalUrl, 'http://x'); u.searchParams.delete('lang');
      return res.redirect((u.pathname + (u.search || '')) || '/');
    }
    const cl = cookies(req).club_lang;
    req.lang = I18N.CODES.includes(cl) ? cl : I18N.fromAcceptLanguage(req.headers['accept-language']);
    req.t = I18N.makeT(req.lang, MISSING);
    res.locals.t = req.t;
    if (req.user && req.user.lang !== req.lang && req.method === 'GET') { q('UPDATE users SET lang=? WHERE id=?').run(req.lang, req.user.id); req.user.lang = req.lang; }
    res.locals.notiN = req.user ? notify.unreadCount(req.user.id) : 0;
    Object.assign(res.locals, {
      B: req.B, me: req.user, isAdmin: req.isAdmin, ARK_URL, T, VERSION,
      level: userLevel, path: req.path, dev: DEV,
      lang: req.lang, LANGS: I18N.LANGS, COUNTRIES: I18N.COUNTRIES,
      ago: (ms) => I18N.timeAgo(ms, req.lang, T.ymd),
      spLabel: (x) => spLabel(x, req.lang),
      jsDict: jsDict(req.lang),
      kakaoOn: kakaoOn(),
    });
    next();
  });
  // 번역이 빠진 문장 모으기 (시험 모드에서 /club/_missing 으로 확인)
  const MISSING = DEV ? new Set() : null;
  // 화면 스크립트(club.js)에서 쓰는 문장
  const JS_KEYS = ['불러오는 중…', '더 보기', '주소를 복사했습니다.', '실패했습니다.', '사진은 10장까지 올릴 수 있습니다.', '대표', '삭제',
    '{n}/10장', '새 식물 이름을 입력해 주세요.', '저장하는 중…', '저장', '사진 또는 내용을 입력해 주세요.', '올리는 중… {p}%', '등록', '서버 응답 오류',
    '인터넷 연결을 확인해 주세요.', '올리는 중…', '보내는 중…', '인증번호 받기', '시험 모드: 인증번호 {code}', '방주 멤버로 확인되었습니다 ✦',
    '보증서 확인 중…', '보증서 연결하기', '🛡 정품으로 연결되었습니다 ({how})', '연결 신청이 접수되었습니다. 운영자 확인 후 🛡 배지가 붙습니다.',
    '아래 공유 버튼 → 「홈 화면에 추가」', '새 태그로 입력', '국가를 먼저 선택해 주세요.', '게시물 {n}개', '품종명', '휴대폰 번호', '구매자 전용 링크', '정품 등록 번호 일치',
    '＋ 팔로우', '팔로잉', '휴대폰 알림이 설정되었습니다.', '휴대폰 알림이 해제되었습니다.', '이 기기는 알림을 지원하지 않습니다.', '알림을 받으려면 권한 허용이 필요합니다. 휴대폰 설정에서 허용해 주세요.',
    '켜기', '끄기', '켜는 중…', '만드는 중…', '사진이 저장되었습니다.', '주소를 복사했습니다.', '사진을 만들지 못했습니다.',
    '{n}일 성장일기', '{n}일의 변화', '▼ {n}일 뒤', '기록 {n}개', '사진으로 보는 하월시아 성장 기록', '하월시아 클럽', '닫기',
    '자르기', '사진 자르기 {i}/{n}', '다음', '완료', '원래대로', '끌어서 위치 조정 · 두 손가락으로 크기 조정', '끌어서 위치 조정 · 휠로 크기 조정',
    '이전 사진', '다음 사진', '확인란에 「탈퇴」를 입력해 주세요.', '정말 탈퇴하시겠습니까? 삭제된 정보는 복구할 수 없습니다.', '탈퇴'];
  const _jsCache = {};
  function jsDict(lang) {
    if (lang === 'ko') return {};
    if (_jsCache[lang]) return _jsCache[lang];
    const t = I18N.makeT(lang, null); const o = {};
    for (const k of JS_KEYS) { const v = t(k); if (v !== k) o[k] = v; }
    return (_jsCache[lang] = o);
  }

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
      try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ ok: false, error: req.t ? req.t('잘못된 요청입니다.') : '잘못된 요청입니다.' }); }
      catch (e) { return res.status(403).json({ ok: false, error: '잘못된 요청입니다.' }); }
    }
    next();
  });

  function page(res, view, data) {
    data = data || {};
    const t = res.locals.t;
    if (t) { if (data.title && !data.rawTitle) data.title = t(data.title); if (data.msg) data.msg = t(data.msg); }
    res.render(path.join(VIEWS, view + '.ejs'), data);
  }
  // 오류 문구도 손님 언어로 (번역표에 있으면)
  function fail(res, code, msg) { const t = res.locals.t; res.status(code).json({ ok: false, error: t ? t(msg) : msg }); }
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
    // 종: 글쓴이·운영자가 직접 고른 글이 아니면 품종 태그→종 연결로 자동
    const row = q('SELECT species_src FROM posts WHERE id=?').get(postId);
    if (!row || row.species_src !== 'user') {
      q("UPDATE posts SET species=?, species_src='auto' WHERE id=?").run(autoSpecies([plant && plant.tag_key, ...keys]), postId);
    }
    return [...keys];
  }

  // =============================================================
  // 종 (만상·옥선·바디아·스프링복스 … + ETC) — 사장님 결정 2026-11-16
  //  - 품종 태그마다 종을 운영자가 한 번 정해 두면 글의 종이 자동으로 정해진다
  //  - 글쓴이가 직접 고를 수도 있다 (species_src='user' 는 자동으로 안 바뀜)
  //  - 종이 없는 글 = ETC
  // =============================================================
  function speciesList() { return q('SELECT * FROM species ORDER BY ord, id').all(); }
  function speciesName(id) { const x = id ? q('SELECT name FROM species WHERE id=?').get(id) : null; return x ? x.name : 'ETC'; }
  function spLabel(x, lang) {
    if (!x) return lang === 'ko' || !lang ? 'ETC' : I18N.makeT(lang)('ETC');
    const v = lang === 'en' ? x.name_en : lang === 'zh-Hans' ? x.name_zhs : lang === 'zh-Hant' ? x.name_zht : '';
    return v || x.name;
  }
  function spLabelById(id, lang) { return spLabel(id ? q('SELECT * FROM species WHERE id=?').get(id) : null, lang); }
  function autoSpecies(keys) {
    for (const k of keys) {
      if (!k) continue;
      const t = q('SELECT species FROM tags WHERE key=?').get(resolveTag(k));
      if (t && t.species && q('SELECT 1 FROM species WHERE id=?').get(t.species)) return t.species;
    }
    return null;
  }
  function postTagKeys(postId) {
    const p = q('SELECT plant_id FROM posts WHERE id=?').get(postId);
    const pl = p && p.plant_id ? q('SELECT tag_key FROM plants WHERE id=?').get(p.plant_id) : null;
    return [pl && pl.tag_key, ...q('SELECT tag_key FROM post_tags WHERE post_id=?').all(postId).map((x) => x.tag_key)];
  }
  // 글쓰기 화면에서 고른 종: species_pick='user' 일 때만 그대로 쓴다 ('auto' 면 서버가 다시 계산)
  function applyPickedSpecies(postId, body) {
    if (String(body.species_pick || '') !== 'user') return;
    const v = String(body.species || '');
    if (v === 'etc') return q("UPDATE posts SET species=NULL, species_src='user' WHERE id=?").run(postId);
    const n = parseInt(v, 10);
    if (n && q('SELECT 1 FROM species WHERE id=?').get(n)) q("UPDATE posts SET species=?, species_src='user' WHERE id=?").run(n, postId);
  }
  // 품종→종 연결을 바꾸면, 직접 고르지 않은 예전 글도 다시 계산
  function recomputeSpeciesForTag(key) {
    const ids = q("SELECT p.id FROM posts p JOIN post_tags pt ON pt.post_id=p.id WHERE pt.tag_key=? AND p.species_src<>'user' AND p.deleted=0").all(key).map((x) => x.id);
    const viaPlant = q("SELECT p.id FROM posts p JOIN plants pl ON pl.id=p.plant_id WHERE pl.tag_key=? AND p.species_src<>'user' AND p.deleted=0").all(key).map((x) => x.id);
    const all = [...new Set([...ids, ...viaPlant])];
    for (const id of all) q("UPDATE posts SET species=?, species_src='auto' WHERE id=?").run(autoSpecies(postTagKeys(id)), id);
    return all.length;
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

  // =============================================================
  // 성장일기 — 같은 사람이 같은 품종 태그로 올린 사진을 날짜순으로 이어 붙인다 (사장님 요청 2026-11-16)
  //  · 사진 있는 글만 · 숨긴 글은 본인·운영자만
  //  · 지금 글이 「내 식물」에 연결돼 있으면, 다른 개체(다른 식물)에 연결된 글은 뺀다 (같은 품종 여러 개 키우는 경우)
  // =============================================================
  function diaryOf(userId, key, viewer, opt) {
    opt = opt || {};
    const seeHidden = !!(viewer && (viewer.id === userId || opt.admin));
    const args = [userId, key];
    let plantCond = '';
    if (opt.plantId) { plantCond = 'AND (p.plant_id IS NULL OR p.plant_id=?)'; args.push(opt.plantId); }
    const rows = q(`SELECT p.id, p.created_at, p.body, p.hidden FROM posts p JOIN post_tags pt ON pt.post_id=p.id
                    WHERE p.user_id=? AND pt.tag_key=? AND p.deleted=0 ${seeHidden ? '' : 'AND p.hidden=0'} ${plantCond}
                      AND EXISTS(SELECT 1 FROM photos ph WHERE ph.post_id=p.id)
                    ORDER BY p.created_at, p.id LIMIT 300`).all(...args);
    if (!rows.length) return [];
    const first = rows[0].created_at;
    const ph = rows.map(() => '?').join(',');
    const ids = rows.map((x) => x.id);
    const photos = q(`SELECT post_id, file, thumb, w, h, ord FROM photos WHERE post_id IN (${ph}) ORDER BY post_id, ord`).all(...ids);
    const likeN = new Map(q(`SELECT post_id, COUNT(*) n FROM likes WHERE post_id IN (${ph}) GROUP BY post_id`).all(...ids).map((x) => [x.post_id, x.n]));
    const cmtN = new Map(q(`SELECT post_id, COUNT(*) n FROM comments WHERE post_id IN (${ph}) AND hidden=0 AND deleted=0 GROUP BY post_id`).all(...ids).map((x) => [x.post_id, x.n]));
    let prev = null;
    return rows.map((x) => {
      const ps = photos.filter((y) => y.post_id === x.id);
      const e = {
        id: x.id, created_at: x.created_at, body: x.body, hidden: x.hidden,
        day: Math.floor((dayStart(x.created_at) - dayStart(first)) / DAY),
        gap: prev === null ? null : Math.floor((dayStart(x.created_at) - dayStart(prev)) / DAY),
        photos: ps, likes: likeN.get(x.id) || 0, comments: cmtN.get(x.id) || 0,
      };
      prev = x.created_at;
      return e;
    });
  }
  // 한국 날짜 기준 하루 시작 (D+ 셈을 날짜로)
  function dayStart(ms) { const k = ms + 9 * 3600 * 1000; return k - (k % DAY); }
  // 핀에 붙이는 「🌱 기록 N」 숫자 — 같은 사람 · 첫 태그 · 사진 있는 글 수
  function diaryCount(userId, key) {
    return (q(`SELECT COUNT(*) n FROM posts p JOIN post_tags pt ON pt.post_id=p.id WHERE p.user_id=? AND pt.tag_key=? AND ${VISIBLE}
               AND EXISTS(SELECT 1 FROM photos ph WHERE ph.post_id=p.id)`).get(userId, key) || {}).n || 0;
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
        species: p.species || null, speciesName: speciesName(p.species),
        mineOwn: !!(viewer && viewer.id === p.user_id),
      });
      const last = out[out.length - 1];
      last.diaryN = last.tags.length && last.photos.length ? diaryCount(p.user_id, last.tags[0].key) : 0;
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

  // 피드 — 핀터레스트형 사진 벽돌판 (사장님 결정 2026-11-16)
  //  위 칩: 전체 + 인기 품종 → 누르면 그 품종만 (?t=열쇠) · 정렬 최신/인기(30일)
  const PIN_PER = 30;
  r.get('/', async (req, res) => {
    await arkData(1500);
    const sort = ['new', 'hot', 'cert', 'follow'].includes(req.query.sort) ? req.query.sort : 'new';
    if (sort === 'follow' && !req.user) return loginRedirect(req, res);
    const pg = Math.max(0, parseInt(req.query.page, 10) || 0);
    const tk = req.query.t ? resolveTag(T.tagKey(req.query.t)) : '';
    const spList = speciesList();
    const sq = String(req.query.s || '');
    const sp = sq === 'etc' ? 'etc' : (spList.find((x) => String(x.id) === sq) ? parseInt(sq, 10) : '');
    const s = since30();
    const J = tk ? 'JOIN post_tags pt ON pt.post_id=p.id AND pt.tag_key=?' : '';
    const jp = tk ? [tk] : [];
    let W = '';
    if (sp === 'etc') W = ' AND p.species IS NULL';
    else if (sp) { W = ' AND p.species=?'; jp.push(sp); }
    let rows;
    if (sort === 'hot') rows = q(`SELECT p.id, ${SCORE_SQL} sc FROM posts p ${J} WHERE ${VISIBLE}${W} ORDER BY sc DESC, p.id DESC LIMIT ? OFFSET ?`).all(s, s, ...jp, PIN_PER + 1, pg * PIN_PER);
    else if (sort === 'follow') rows = q(`SELECT p.id FROM posts p ${J} WHERE ${VISIBLE}${W} AND p.user_id IN (SELECT followee_id FROM follows WHERE follower_id=?) ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(...jp, req.user.id, PIN_PER + 1, pg * PIN_PER);
    else if (sort === 'cert') rows = q(`SELECT p.id FROM posts p ${J} JOIN plants pl ON pl.id=p.plant_id WHERE ${VISIBLE}${W} AND pl.cert_status='ok' AND pl.deleted=0 ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(...jp, PIN_PER + 1, pg * PIN_PER);
    else rows = q(`SELECT p.id FROM posts p ${J} WHERE ${VISIBLE}${W} ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(...jp, PIN_PER + 1, pg * PIN_PER);
    const more = rows.length > PIN_PER;
    const list = cards(rows.slice(0, PIN_PER).map((x) => x.id), req.user);
    const qs = (o) => '?' + Object.entries(Object.assign({ sort, t: tk, s: sp }, o)).filter(([k, v]) => v !== '' && v != null && !(k === 'sort' && v === 'new')).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    const next = `${req.B}/${qs({ page: pg + 1, frag: 1 })}`;
    if (req.query.frag) return page(res, '_pins', { list, more, next, target: 'feedlist' });
    // 위 칩: 종 (만상·옥선…) + ETC
    const followN = req.user ? (q('SELECT COUNT(*) n FROM follows WHERE follower_id=?').get(req.user.id) || {}).n || 0 : 0;
    const evBand = !tk && !sp && pg === 0 ? eventBand(req) : null;
    page(res, 'feed', { list, more, sort, tk, followN, tkLabel: tk ? tagLabel(tk) : '', sp, spList, spName: sp ? spLabelById(sp === 'etc' ? null : sp, req.lang) : '', next, title: '', evBand, tf: tfOf(res.locals.t) });
  });

  // 글 하나
  // 조회수 — 같은 사람이 같은 날 여러 번 열어도 1번. 글쓴이 본인·검색 로봇·링크 미리보기는 세지 않음
  const viewSeen = new Set(); let viewDay = '';
  const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|kakaotalk-scrap|Slackbot|Twitterbot|WhatsApp|TelegramBot|Discordbot|HeadlessChrome|Lighthouse|curl|wget|python|node-fetch|axios/i;
  function countView(req, p) {
    try {
      const ua = String(req.get('user-agent') || '');
      if (!ua || BOT_UA.test(ua)) return;
      if (req.user && req.user.id === p.user_id) return;
      const day = T.ymd(now());
      if (day !== viewDay) { viewSeen.clear(); viewDay = day; }
      const who = req.user ? 'u' + req.user.id : 'a' + crypto.createHash('sha1').update(String(req.ip || '') + '|' + ua).digest('base64').slice(0, 12);
      const k = p.id + ':' + who;
      if (viewSeen.has(k)) return;
      if (viewSeen.size > 200000) viewSeen.clear();
      viewSeen.add(k);
      q('UPDATE posts SET views=views+1 WHERE id=?').run(p.id);
    } catch (e) { /* 조회수는 실패해도 화면은 그대로 */ }
  }

  r.get('/p/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const p = q('SELECT * FROM posts WHERE id=? AND deleted=0').get(id);
    if (!p || (p.hidden && !canSeeHidden(req) && !(req.user && req.user.id === p.user_id))) return res.status(404), page(res, 'msg', { title: '게시물을 찾을 수 없습니다', msg: '삭제되었거나 숨김 처리된 게시물입니다.' });
    if (!p.hidden) countView(req, p);
    const [c] = cards([id], req.user);
    const cmts = q(`SELECT c.*, u.nick, u.ark_no FROM comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.post_id=? AND c.deleted=0 ${req.isAdmin ? '' : 'AND c.hidden=0'} ORDER BY c.id`).all(id);
    const ws = cmts.map((x) => ({ id: x.user_id, ref: x }));
    withTiers(ws).forEach((w) => { w.ref.tier = w.tier; });
    const pins = req.isAdmin ? c.tags.map((t) => ({ key: t.key, label: t.label, pinned: (q('SELECT pinned_post FROM tags WHERE key=?').get(t.key) || {}).pinned_post === id })) : [];
    const base = `${req.protocol}://${req.get('host')}`;
    // 아래에 같은 품종 사진 더 (핀터레스트의 「비슷한 사진」)
    let moreTag = null, moreList = [];
    if (c.tags.length) {
      moreTag = c.tags[0];
      const ids = q(`SELECT p.id FROM posts p JOIN post_tags pt ON pt.post_id=p.id WHERE pt.tag_key=? AND p.id<>? AND ${VISIBLE}
                     AND EXISTS(SELECT 1 FROM photos ph WHERE ph.post_id=p.id) ORDER BY p.id DESC LIMIT 12`).all(moreTag.key, id).map((x) => x.id);
      moreList = cards(ids, req.user);
    }
    c.speciesLabel = spLabelById(c.species, req.lang);
    // 성장일기: 이 글의 태그마다 같은 사람 기록이 2개 이상이면 붙인다 (기록 많은 태그 먼저, 최대 2개)
    const diaries = c.photos.length ? c.tags.map((tg) => {
      const entries = diaryOf(p.user_id, tg.key, req.user, { plantId: p.plant_id || 0, admin: req.isAdmin });
      return { key: tg.key, label: tg.label, entries, cur: entries.findIndex((e) => e.id === id) };
    }).filter((d) => d.entries.length >= 2 && d.cur >= 0).sort((a, b) => b.entries.length - a.entries.length).slice(0, 2) : [];
    const followingAuthor = !!(req.user && q('SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?').get(req.user.id, p.user_id));
    page(res, 'post', { c, cmts, pins, moreTag, moreList, diaries, followingAuthor, spList: speciesList(), ogImage: c.photos[0] ? `${base}${req.B}/media/${c.photos[0].file}` : '',
      title: req.t('{nick}님의 사진', { nick: c.user.nick }), rawTitle: true });
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
    const spMap = {};
    for (const t of q('SELECT key, species FROM tags WHERE species IS NOT NULL').all()) spMap[t.key] = t.species;
    for (const t of q("SELECT key, merged_into FROM tags WHERE merged_into<>''").all()) { const to = resolveTag(t.key); if (spMap[to]) spMap[t.key] = spMap[to]; }
    page(res, 'write', { plants, popular, spList: speciesList(), spMap, pick: parseInt(req.query.plant, 10) || (edit ? edit.plant_id : 0), preTag, edit, title: edit ? '게시물 수정' : '사진 등록' });
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
    if (req.query.frag) return page(res, '_pins', { list, more, target: 'gridlist', next: `${req.B}/t/${encodeURIComponent(key)}?sort=${sort}&page=${pg + 1}&frag=1` });
    const tagSp = (q('SELECT species FROM tags WHERE key=?').get(key) || {}).species || null;
    const shopOff = !!(q('SELECT shop_off FROM tags WHERE key=?').get(key) || {}).shop_off;
    const forSale = shop.enabled && !shopOff ? shop.match(key) : { list: [], n: 0 };
    forSale.list.forEach((x) => { x.url = shop.link(x.no); });
    page(res, 'tag', { key, label, forSale, word: T.tagWord(label), n, list, more, sort, rep, repCard, official, certN, growers, tagSp, tagSpName: tagSp ? spLabelById(tagSp, req.lang) : '',
      next: `${req.B}/t/${encodeURIComponent(key)}?sort=${sort}&page=${pg + 1}&frag=1`, title: '#' + T.tagWord(label), rawTitle: true });
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
    // (방주 등재 품종을 따로 앞세우지 않는다 — 일반 손님에게 방주를 강조하지 않기로 함)
    tags = tags.map((t) => ({ ...t, rep: repCards.get(t.pid) }));
    const match = (x) => !qq || x.key.includes(qq);
    const sorter = sort === 'abc' ? (a, b) => String(a.label).localeCompare(String(b.label), 'ko') : (a, b) => (b.n - a.n) || String(a.label).localeCompare(String(b.label), 'ko');
    page(res, 'dex', { tags: tags.filter(match).sort(sorter), qtext: req.query.q || '', sort, totalTags: have.size, title: '품종 도감' });
  });

  // 내 온실 / 회원 온실
  // 닉네임을 바꾼 회원: 예전 주소로 들어오면 지금 주소로 넘긴다 (뒤에 붙은 /d/품종 · ?page 그대로)
  function oldNickRedirect(req, res) {
    const k = String(req.params.nick || '').toLowerCase();
    const h = q('SELECT u.nick FROM nick_history h JOIN users u ON u.id=h.user_id WHERE h.old_key=?').get(k);
    if (!h) return false;
    const rest = req.path.replace(/^\/u\/[^/]+/, '');
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(301, `${req.B}/u/${encodeURIComponent(h.nick)}${rest}${qs}`);
    return true;
  }

  r.get('/me', (req, res) => {
    if (!req.user) return loginRedirect(req, res);
    res.redirect(req.B + '/u/' + encodeURIComponent(req.user.nick));
  });
  r.get('/u/:nick', (req, res) => {
    const u = q('SELECT * FROM users WHERE nick_key=?').get(String(req.params.nick || '').toLowerCase());
    if (!u && oldNickRedirect(req, res)) return;
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
    if (req.query.frag) return page(res, '_pins', { list, more, next, target: 'gridlist' });
    const stats = {
      posts: (q('SELECT COUNT(*) n FROM posts WHERE user_id=? AND hidden=0 AND deleted=0').get(u.id) || {}).n || 0,
      hearts: (q('SELECT COUNT(*) n FROM likes l JOIN posts p ON p.id=l.post_id WHERE p.user_id=? AND l.user_id<>p.user_id AND p.deleted=0').get(u.id) || {}).n || 0,
    };
    withTiers([u]);
    const vis = own || req.isAdmin ? 'p.deleted=0' : VISIBLE;
    const diaries = q(`SELECT pt.tag_key key, t.label, COUNT(*) n, MIN(p.created_at) first_at, MAX(p.created_at) last_at, MAX(p.id) last_id
                       FROM posts p JOIN post_tags pt ON pt.post_id=p.id JOIN tags t ON t.key=pt.tag_key
                       WHERE p.user_id=? AND ${vis} AND EXISTS(SELECT 1 FROM photos ph WHERE ph.post_id=p.id)
                       GROUP BY pt.tag_key HAVING n>=2 ORDER BY last_at DESC LIMIT 40`).all(u.id);
    for (const d of diaries) {
      d.cover = (q('SELECT thumb FROM photos WHERE post_id=? ORDER BY ord LIMIT 1').get(d.last_id) || {}).thumb || '';
      d.days = Math.floor((dayStart(d.last_at) - dayStart(d.first_at)) / DAY);
    }
    const nickNext = own ? nickNextAt(u) : 0;
    const fol = followCounts(u.id);
    const iFollow = !!(req.user && !own && q('SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?').get(req.user.id, u.id));
    page(res, 'user', { u, own, plants, list, more, next, stats, TIERS, diaries, fol, iFollow, nickLocked: nickNext > now(), nickNextDate: nickNext ? T.ymd(nickNext) : '',
      title: own ? '내 온실' : req.t('{nick}님의 온실', { nick: u.nick }), rawTitle: !own });
  });

  // 성장일기 전체 — 한 사람 · 한 품종 · 날짜순 타임라인
  r.get('/u/:nick/d/:key', async (req, res) => {
    const u = q('SELECT * FROM users WHERE nick_key=?').get(String(req.params.nick || '').toLowerCase());
    if (!u && oldNickRedirect(req, res)) return;
    if (!u) return res.status(404), page(res, 'msg', { title: '회원을 찾을 수 없습니다', msg: '닉네임을 다시 확인해 주세요.' });
    const key = resolveTag(T.tagKey(req.params.key));
    if (!key) return res.status(404), page(res, 'msg', { title: '페이지가 없습니다', msg: '주소를 다시 확인해 주세요.' });
    if (key !== T.tagKey(req.params.key)) return res.redirect(301, `${req.B}/u/${encodeURIComponent(u.nick)}/d/${encodeURIComponent(key)}`);
    await arkData(1500);
    const label = tagLabel(key);
    const entries = diaryOf(u.id, key, req.user, { admin: req.isAdmin });
    if (!entries.length) return res.status(404), page(res, 'msg', { title: '아직 기록이 없습니다', msg: '이 품종으로 등록된 사진이 없습니다.' });
    const order = req.query.order === 'new' ? 'new' : 'old';
    withTiers([u]);
    const own = !!(req.user && req.user.id === u.id);
    // 카드에 넣는 짧은 글: #품종(띄어 쓴 「#미카엘의 심장」 까지) 빼고 16자, 낱말 중간에서 안 자름
    const noteOf = (body) => {
      const s0 = String(body || ''); let txt = '', last = 0;
      for (const sp of T.hashSpans(s0)) { txt += s0.slice(last, sp.start) + ' '; last = sp.end; }
      txt = (txt + s0.slice(last)).replace(/\s+/g, ' ').trim();
      if (txt.length <= 16) return txt;
      const cut = txt.slice(0, 16); const sp = cut.lastIndexOf(' ');
      return (sp >= 8 ? cut.slice(0, sp) : cut) + '…';
    };
    // 🎬 공유 카드 (본인만): 사진·날짜·D+ · 짧은 글 — 폰에서 그림으로 만든다
    let card = null;
    if (own && entries.length >= 2) {
      const pickIdx = (n, k) => { if (n <= k) return [...Array(n).keys()]; const out = []; for (let i = 0; i < k; i++) out.push(Math.round(i * (n - 1) / (k - 1))); return [...new Set(out)]; };
      const ent = (e) => ({ src: `${req.B}/media/${e.photos[0].file}`, day: e.day, date: T.ymd(e.created_at), note: noteOf(e.body) });
      const url = `${clubOrigin(req)}/u/${encodeURIComponent(u.nick)}/d/${encodeURIComponent(key)}`;
      card = { nick: u.nick, tag: T.tagWord(label), span: entries[entries.length - 1].day, total: entries.length,
        first: ent(entries[0]), last: ent(entries[entries.length - 1]), tl: pickIdx(entries.length, 4).map((i) => ent(entries[i])),
        url, host: url.replace(/^https?:\/\//, '').split('/')[0], qr: `${req.B}/qr.svg?u=${encodeURIComponent(url)}`,
        L: { days: req.t('{n}일 성장일기', { n: entries[entries.length - 1].day }), change: req.t('{n}일의 변화', { n: entries[entries.length - 1].day }),
          after: req.t('▼ {n}일 뒤', { n: entries[entries.length - 1].day }), count: req.t('기록 {n}개', { n: entries.length }),
          foot: req.t('사진으로 보는 하월시아 성장 기록'), club: req.t('하월시아 클럽'), diary: req.t('성장일기') } };
    }
    page(res, 'diary', { u, own, card, key, label, word: T.tagWord(label), entries: order === 'new' ? entries.slice().reverse() : entries, total: entries.length,
      span: entries[entries.length - 1].day, first: entries[0], last: entries[entries.length - 1], order,
      ogImage: entries[entries.length - 1].photos[0] ? `${req.protocol}://${req.get('host')}${req.B}/media/${entries[entries.length - 1].photos[0].file}` : '',
      title: req.t('{nick}님의 #{tag} 성장일기', { nick: u.nick, tag: T.tagWord(label) }), rawTitle: true });
  });

  // 식물 하나 (성장 기록 + 족보)
  r.get('/plant/:id', (req, res) => {
    const pl = q('SELECT * FROM plants WHERE id=? AND deleted=0').get(parseInt(req.params.id, 10));
    if (!pl) return res.status(404), page(res, 'msg', { title: '식물을 찾을 수 없습니다', msg: '삭제된 식물입니다.' });
    const u = q('SELECT * FROM users WHERE id=?').get(pl.user_id);
    const own = !!(req.user && req.user.id === pl.user_id);
    const rows = q(`SELECT p.id FROM posts p WHERE p.plant_id=? AND p.deleted=0 ${own || req.isAdmin ? '' : 'AND p.hidden=0'} ORDER BY p.created_at ASC`).all(pl.id);
    const list = cards(rows.map((x) => x.id), req.user);
    let info = null; try { info = pl.cert_info ? JSON.parse(pl.cert_info) : null; } catch (e) {}
    page(res, 'plant', { pl, u, own, list, info, tagWordStr: pl.tag_key ? T.tagWord(tagLabel(pl.tag_key)) : '', title: pl.name, rawTitle: true });
  });

  // 🛡 방주 안내방 (클럽 안 화면 — 버튼을 누를 때만 방주 사이트로)
  r.get('/ark', async (req, res) => {
    await arkData(1500);
    let mine = [];
    if (req.user) {
      withTiers([req.user]);
      mine = q(`SELECT pl.*, (SELECT ph.thumb FROM photos ph JOIN posts p ON p.id=ph.post_id WHERE p.plant_id=pl.id AND ${VISIBLE} ORDER BY p.id DESC, ph.ord LIMIT 1) cover
                FROM plants pl WHERE pl.user_id=? AND pl.deleted=0 AND pl.cert_status IN ('ok','pending') ORDER BY pl.cert_status='ok' DESC, pl.id DESC`).all(req.user.id);
    }
    const certTotal = (q("SELECT COUNT(*) n FROM plants WHERE cert_status='ok' AND deleted=0").get() || {}).n || 0;
    const official = [...ark.official.entries()].map(([k, v]) => {
      const rep = tagRep(k);
      const c = rep ? cards([rep.id], req.user)[0] : null;
      return { key: k, name: v.name, maker: v.maker, thumb: c && c.photos[0] ? c.photos[0].thumb : '' };
    });
    page(res, 'ark', { mine, certTotal, official, TIERS, title: '방주' });
  });

  // 등급 안내
  r.get('/levels', (req, res) => {
    if (req.user) withTiers([req.user]);
    page(res, 'levels', { TIERS, title: '클럽 등급' });
  });

  // 로그인
  r.get('/login', (req, res) => {
    const next = String(req.query.next || '');
    const k = readKakao(req.query.k) ? String(req.query.k) : '';
    page(res, 'login', { next: next.startsWith('/') && !next.startsWith('//') ? next : (req.B + '/'), defCountry: I18N.DEF_COUNTRY[req.lang] || '', title: '로그인',
      kakaoTok: k, kerr: String(req.query.kerr || '') });
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
      id: req.B + '/', description: '하월시아 사진 커뮤니티 — 내 식물 사진·성장일기·품종 도감 (by 지양하월시아)',
      categories: ['lifestyle', 'social'],
      start_url: req.B + '/', scope: req.B + '/', display: 'standalone',
      background_color: '#F5F1E6', theme_color: '#1F4129', lang: 'ko',
      icons: [
        { src: req.B + '/static/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: req.B + '/static/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: req.B + '/static/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  });
  // 안드로이드 앱(TWA) 확인 파일: https://club.haworthia.co.kr/.well-known/assetlinks.json
  //  Railway 변수 CLUB_TWA_PACKAGE (앱 패키지 이름) + CLUB_TWA_SHA256 (Play Console 「앱 서명」의 SHA-256, 여러 개면 쉼표)
  r.get('/.well-known/assetlinks.json', (req, res) => {
    const pkg = String(process.env.CLUB_TWA_PACKAGE || '').trim();
    const fps = String(process.env.CLUB_TWA_SHA256 || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (!pkg || !fps.length) return res.status(404).json([]);
    res.json([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fps } }]);
  });
  r.get('/sw.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-cache').send(
`// 하월시아 클럽 — 화면이 끊겨도 마지막으로 본 화면을 보여주는 정도만 한다
const C='club-${VERSION}';
self.addEventListener('install',e=>{self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
// 폰 알림 (v29)
self.addEventListener('push',e=>{
  let d={}; try{d=e.data?e.data.json():{};}catch(x){d={title:'Haworthia Club',body:e.data?e.data.text():''};}
  const url=new URL(d.url||'noti',self.registration.scope).href;
  const jobs=[self.registration.showNotification(d.title||'Haworthia Club',{body:d.body||'',icon:'${req.B}/static/icon-192.png',badge:'${req.B}/static/icon-192.png',tag:d.tag||undefined,data:{url}})];
  if(typeof d.badge==='number'&&self.navigator&&self.navigator.setAppBadge){jobs.push((d.badge?self.navigator.setAppBadge(d.badge):self.navigator.clearAppBadge()).catch(()=>{}));}
  e.waitUntil(Promise.all(jobs));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=(e.notification.data&&e.notification.data.url)||self.registration.scope;
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{
    for(const c of cs){ if(c.url.startsWith(self.registration.scope)&&'focus' in c){ return c.focus().then(w=>(w||c).navigate?(w||c).navigate(url):null).catch(()=>clients.openWindow(url)); } }
    return clients.openWindow(url);
  }));
});
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
  // 카카오 회원번호를 휴대폰 확인 전까지 잠깐 들고 다니는 표 (20분, 서명)
  const KAKAO = {
    key: () => process.env.CLUB_KAKAO_REST_KEY || '', secret: () => process.env.CLUB_KAKAO_SECRET || '',
    auth: () => (process.env.CLUB_KAKAO_AUTH || 'https://kauth.kakao.com').replace(/\/$/, ''),
    api: () => (process.env.CLUB_KAKAO_API || 'https://kapi.kakao.com').replace(/\/$/, ''),
  };
  function kakaoOn() { return !!KAKAO.key(); }
  const kakaoToken = (kid) => {
    const exp = now() + 20 * 60 * 1000;
    const sig = crypto.createHmac('sha256', SECRET).update('club-kakao:' + kid + ':' + exp).digest('hex').slice(0, 24);
    return `${kid}.${exp}.${sig}`;
  };
  const readKakao = (tok) => {
    const [kid, exp, sig] = String(tok || '').split('.');
    if (!/^\d{1,20}$/.test(kid || '') || !exp || !sig || now() > +exp) return '';
    const want = crypto.createHmac('sha256', SECRET).update('club-kakao:' + kid + ':' + exp).digest('hex').slice(0, 24);
    return sig.length === 24 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) ? kid : '';
  };
  const smsReady = () => !!(process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET && process.env.SENDER_PHONE && messaging.sendText);

  // 나라 + 번호 → 저장 열쇠 (한국 = 010…, 해외 = +나라번호 + 번호) · 보낼 번호 · 나라번호
  const CC = new Set(I18N.COUNTRIES.map((c) => c.code));
  function phoneOf(body) {
    const cc = String(body.country || '82').replace(/\D/g, '') || '82';
    const raw = String(body.phone || '');
    if (raw.trim().startsWith('+')) {
      // +82 10… 처럼 나라번호까지 쓴 경우
      const d = T.digits(raw);
      if (d.startsWith('82')) return phoneOf({ country: '82', phone: '0' + d.slice(2).replace(/^0/, '') });
      for (const c of [...CC].sort((a, b) => b.length - a.length)) if (d.startsWith(c)) return phoneOf({ country: c, phone: d.slice(c.length) });
      return null;
    }
    if (cc === '82') { const k = T.normPhone(raw); return k ? { key: k, to: k, country: '82', intl: false } : null; }
    if (!CC.has(cc)) return null;
    const nat = T.digits(raw).replace(/^0+/, '');
    if (nat.length < 6 || nat.length > 14) return null;
    return { key: '+' + cc + nat, to: nat, country: cc, intl: true };
  }

  r.post('/api/auth/send', async (req, res) => {
    const pk = phoneOf(req.body);
    if (!pk) return fail(res, 400, '휴대폰 번호를 확인해 주세요.');
    const phone = pk.key;
    if (limited('sms60:' + phone, 1, 60 * 1000)) return fail(res, 429, '인증번호를 방금 보냈습니다. 1분 후 다시 시도해 주세요.');
    if (limited('smsH:' + phone, 5, 3600 * 1000)) return fail(res, 429, '1시간에 5회까지 보낼 수 있습니다. 잠시 후 다시 시도해 주세요.');
    if (limited('smsIP:' + req.ip, 15, 3600 * 1000)) return fail(res, 429, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    // 해외 문자는 비싸니 하루 전체 상한 (Railway 변수 CLUB_INTL_DAILY_MAX, 기본 100건)
    if (pk.intl && limited('intlDay', parseInt(process.env.CLUB_INTL_DAILY_MAX, 10) || 100, DAY)) return fail(res, 429, '오늘 해외 인증 문자 발송량이 많아 일시 중단되었습니다. 내일 다시 시도해 주세요.');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    q('UPDATE sms_codes SET used=1 WHERE phone=? AND used=0').run(phone);
    q('INSERT INTO sms_codes(phone,code_hash,ip,created_at) VALUES(?,?,?,?)').run(phone, hashCode(phone, code), req.ip || '', now());
    if (smsReady()) {
      try {
        // 한국 번호 = 한국어 / 해외 번호 = 영문 (솔라피 해외 SMS 는 「해외 발송 권한」 승인을 받아야 나간다)
        const text = (pk.intl ? I18N.SMS_TEXT.intl : I18N.SMS_TEXT.ko).replace('{code}', code);
        // 짧은 문자(SMS)가 더 싸다. 보내는 번호: CLUB_SENDER_PHONE (솔라피에 등록된 번호) → 없으면 방주와 같은 SENDER_PHONE
        if (messaging.sendSms) await messaging.sendSms({ to: pk.to, text, from: process.env.CLUB_SENDER_PHONE || '', country: pk.intl ? pk.country : '' });
        else await messaging.sendText({ to: phone, subject: '하월시아 클럽', text });
      } catch (e) {
        console.warn('[club] 인증 문자 실패:', e.message);
        return fail(res, 502, '문자 발송에 실패했습니다. 잠시 후 다시 시도해 주세요.');
      }
      return res.json({ ok: true });
    }
    if (DEV) { console.log('[club] (시험) 인증번호', phone, code, pk.intl ? '해외 ' + pk.country : ''); return res.json({ ok: true, dev_code: code, sent_to: pk.intl ? '+' + pk.country + ' ' + pk.to : phone }); }
    return fail(res, 503, '문자 발송 설정이 완료되지 않았습니다. 운영자에게 문의해 주세요.');
  });

  async function arkMemberCheck(u, force) {
    if (!sheets.findApprovedByPhone || String(u.phone).startsWith('+')) return u; // 방주 명부는 한국 번호만
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
    const pk = phoneOf(req.body);
    const phone = pk ? pk.key : '';
    const code = T.digits(req.body.code);
    if (!phone || code.length !== 6) return fail(res, 400, '인증번호 6자리를 입력해 주세요.');
    const row = q('SELECT * FROM sms_codes WHERE phone=? AND used=0 ORDER BY id DESC LIMIT 1').get(phone);
    if (!row || now() - row.created_at > 5 * 60 * 1000) return fail(res, 400, '인증번호가 만료되었습니다. 다시 요청해 주세요.');
    if (row.tries >= 5) return fail(res, 429, '5회 잘못 입력하여 차단되었습니다. 인증번호를 다시 요청해 주세요.');
    if (hashCode(phone, code) !== row.code_hash) {
      q('UPDATE sms_codes SET tries=tries+1 WHERE id=?').run(row.id);
      return fail(res, 400, req.t('인증번호가 맞지 않습니다. ({n}번 남음)', { n: 4 - row.tries }));
    }
    q('UPDATE sms_codes SET used=1 WHERE id=?').run(row.id);
    const u = q('SELECT * FROM users WHERE phone=?').get(phone);
    if (!u) return res.json({ ok: true, signup: signupToken(phone) });
    if (u.blocked) return fail(res, 403, '이용이 제한된 계정입니다. 운영자에게 문의해 주세요.');
    // 카카오로 처음 들어온 분: 이 번호의 계정에 카카오를 이어 둠 → 다음부터는 카카오 버튼만
    const kid = readKakao(req.body.kakao);
    if (kid && !q('SELECT 1 FROM users WHERE kakao_id=? AND id<>?').get(kid, u.id)) q('UPDATE users SET kakao_id=? WHERE id=?').run(kid, u.id);
    newSession(req, res, u.id, req.isAdmin);
    await arkMemberCheck(u, false);
    res.json({ ok: true, nick: u.nick });
  });

  r.post('/api/auth/signup', async (req, res) => {
    const phone = readSignup(req.body.signup);
    if (!phone) return fail(res, 400, '인증 시간이 초과되었습니다. 처음부터 다시 진행해 주세요.');
    if (!req.body.agree) return fail(res, 400, '개인정보 수집·이용에 동의해 주세요.');
    const n = T.checkNick(req.body.nick);
    if (n.error) return fail(res, 400, n.error);
    if (q('SELECT 1 FROM users WHERE nick_key=?').get(n.key)) return fail(res, 409, '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해 주세요.');
    if (oldNickTaken(n.key, 0)) return fail(res, 409, '최근 다른 회원이 사용한 닉네임이므로 현재 사용할 수 없습니다.');
    let u = q('SELECT * FROM users WHERE phone=?').get(phone);
    if (!u) {
      const kid = readKakao(req.body.kakao);
      const kk = kid && !q('SELECT 1 FROM users WHERE kakao_id=?').get(kid) ? kid : '';
      const info = q('INSERT INTO users(phone,nick,nick_key,created_at,kakao_id) VALUES(?,?,?,?,?)').run(phone, n.nick, n.key, now(), kk);
      u = q('SELECT * FROM users WHERE id=?').get(Number(info.lastInsertRowid));
    }
    newSession(req, res, u.id, req.isAdmin);
    await arkMemberCheck(u, true);
    res.json({ ok: true, nick: u.nick, ark: !!u.ark_no });
  });

  // =============================================================
  // 카카오 로그인 (사장님 B안, 2026-11-17)
  //  - Railway 변수 CLUB_KAKAO_REST_KEY (+ 「Client Secret」을 켰으면 CLUB_KAKAO_SECRET) 가 있어야 버튼이 보임
  //  - 카카오 회원번호만 받음 (동의 항목 없음). 처음 한 번은 휴대폰 번호로 확인해서 계정을 이어 둠
  //  - 카카오 토큰은 저장하지 않음
  // =============================================================
  function safeNext(n, d) { n = String(n || ''); return n.startsWith('/') && !n.startsWith('//') ? n : d; }
  function originOf(req) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    return proto + '://' + req.headers.host;
  }
  const kakaoRedirect = (req) => originOf(req) + req.B + '/auth/kakao/callback';
  r.get('/auth/kakao', (req, res) => {
    if (!kakaoOn()) return res.redirect(req.B + '/login');
    const mode = req.query.mode === 'link' && req.user ? 'link' : 'login';
    const st = { s: crypto.randomBytes(16).toString('hex'), n: safeNext(req.query.next, req.B + '/'), m: mode };
    const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') || req.secure;
    res.append('Set-Cookie', `club_ks=${encodeURIComponent(JSON.stringify(st))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`);
    const u = new URL(KAKAO.auth() + '/oauth/authorize');
    u.searchParams.set('client_id', KAKAO.key());
    u.searchParams.set('redirect_uri', kakaoRedirect(req));
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('state', st.s);
    res.redirect(u.toString());
  });
  r.get('/auth/kakao/callback', async (req, res) => {
    let st = {};
    try { st = JSON.parse(cookies(req).club_ks || '{}'); } catch (e) { st = {}; }
    res.append('Set-Cookie', 'club_ks=x; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    const back = st.m === 'link' ? req.B + '/settings' : req.B + '/login';
    if (!st.s || st.s !== String(req.query.state || '')) return page(res, 'msg', { title: '다시 시도해 주세요', msg: '카카오 로그인 시간이 초과되었습니다. 카카오 로그인 버튼을 다시 눌러 주세요.' });
    if (req.query.error) return res.redirect(back + '?kerr=cancel');
    let kid = '';
    try {
      const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: KAKAO.key(), redirect_uri: kakaoRedirect(req), code: String(req.query.code || '') });
      if (KAKAO.secret()) body.set('client_secret', KAKAO.secret());
      const tr = await withTimeout(fetch(KAKAO.auth() + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body }), 8000);
      const tj = await tr.json();
      if (!tr.ok || !tj.access_token) throw new Error('token ' + tr.status + ' ' + (tj.error_code || tj.error || ''));
      const mr = await withTimeout(fetch(KAKAO.api() + '/v2/user/me', { headers: { Authorization: 'Bearer ' + tj.access_token } }), 8000);
      const mj = await mr.json();
      if (!mr.ok || !mj.id) throw new Error('me ' + mr.status);
      kid = String(mj.id);
    } catch (e) {
      console.warn('[club] 카카오 로그인 실패:', e.message);
      return res.redirect(back + '?kerr=fail');
    }
    const found = q('SELECT * FROM users WHERE kakao_id=?').get(kid);
    if (st.m === 'link' && req.user) {
      if (found && found.id !== req.user.id) return res.redirect(req.B + '/settings?kerr=used');
      q('UPDATE users SET kakao_id=? WHERE id=?').run(kid, req.user.id);
      return res.redirect(req.B + '/settings?k=linked');
    }
    if (found) {
      if (found.blocked) return page(res, 'msg', { title: '이용 제한', msg: '이용이 제한된 계정입니다. 운영자에게 문의해 주세요.' });
      newSession(req, res, found.id, req.isAdmin);
      await arkMemberCheck(found, false);
      return res.redirect(st.n || req.B + '/');
    }
    // 처음 카카오로 온 분 → 휴대폰 번호로 한 번만 확인 (같은 사람이 계정을 두 개 만들지 않도록)
    res.redirect(req.B + '/login?k=' + encodeURIComponent(kakaoToken(kid)) + '&next=' + encodeURIComponent(st.n || req.B + '/'));
  });

  // ---- ⚙ 설정 (휴대폰 번호 · 카카오 연결 · 개인정보처리방침 · 탈퇴) ----
  r.get('/settings', (req, res) => {
    if (!req.user) return loginRedirect(req, res);
    page(res, 'settings', { title: '설정', phoneMasked: T.maskPhone(req.user.phone), kakaoLinked: !!req.user.kakao_id, k: String(req.query.k || ''), kerr: String(req.query.kerr || '') });
  });
  r.post('/api/me/kakao-unlink', (req, res) => {
    if (!needUser(req, res)) return;
    q("UPDATE users SET kakao_id='' WHERE id=?").run(req.user.id);
    res.json({ ok: true });
  });

  // ---- 회원 탈퇴 (구글 플레이 정책: 앱 안 + 웹 주소 둘 다) ----
  //  주소 /leave = 웹에서 탈퇴하는 곳 (로그인 → 확인 → 바로 지움). 지운 것은 되돌릴 수 없음
  function deleteUser(uid) {
    const files = [];
    tx(db, () => {
      const pids = q('SELECT id FROM posts WHERE user_id=?').all(uid).map((x) => x.id);
      for (const pid of pids) {
        for (const ph of q('SELECT file, thumb FROM photos WHERE post_id=?').all(pid)) files.push(ph.file, ph.thumb);
        const cids = q('SELECT id FROM comments WHERE post_id=?').all(pid).map((x) => x.id);
        for (const cid of cids) { q('DELETE FROM notifs WHERE comment_id=?').run(cid); q('DELETE FROM reports WHERE comment_id=?').run(cid); }
        q('DELETE FROM comments WHERE post_id=?').run(pid);
        q('DELETE FROM photos WHERE post_id=?').run(pid);
        q('DELETE FROM post_tags WHERE post_id=?').run(pid);
        q('DELETE FROM likes WHERE post_id=?').run(pid);
        q('DELETE FROM notifs WHERE post_id=?').run(pid);
        q('DELETE FROM reports WHERE post_id=?').run(pid);
        q('UPDATE tags SET pinned_post=NULL WHERE pinned_post=?').run(pid);
      }
      q('DELETE FROM posts WHERE user_id=?').run(uid);
      for (const c of q('SELECT id FROM comments WHERE user_id=?').all(uid)) { q('DELETE FROM notifs WHERE comment_id=?').run(c.id); q('DELETE FROM reports WHERE comment_id=?').run(c.id); }
      q('DELETE FROM comments WHERE user_id=?').run(uid);
      q('DELETE FROM likes WHERE user_id=?').run(uid);
      q('DELETE FROM follows WHERE follower_id=? OR followee_id=?').run(uid, uid);
      q('DELETE FROM notifs WHERE user_id=? OR actor_id=?').run(uid, uid);
      q('DELETE FROM push_subs WHERE user_id=?').run(uid);
      q('DELETE FROM plants WHERE user_id=?').run(uid);
      q('DELETE FROM nick_history WHERE user_id=?').run(uid);
      q('DELETE FROM reports WHERE user_id=?').run(uid);
      const u = q('SELECT phone FROM users WHERE id=?').get(uid);
      if (u) q('DELETE FROM sms_codes WHERE phone=?').run(u.phone);
      q('DELETE FROM sessions WHERE user_id=?').run(uid);
      q('DELETE FROM users WHERE id=?').run(uid);
      // 이벤트: 빼기 목록·마감 결과에서도 지움
      try {
        const c = ev.cfg();
        if ((c.exclude || []).includes(uid)) { c.exclude = c.exclude.filter((x) => x !== uid); ev.save(c); }
        const f = q("SELECT v FROM kv WHERE k='event_final'").get();
        if (f) { const j = JSON.parse(f.v); j.rows = (j.rows || []).filter((r) => r.userId !== uid).map((r, i) => Object.assign(r, { rank: i + 1 })); q("UPDATE kv SET v=? WHERE k='event_final'").run(JSON.stringify(j)); }
      } catch (e) { /* 이벤트 기록은 없어도 됨 */ }
    });
    for (const f of files) if (f && !f.includes('/') && !f.includes('..')) fs.unlink(path.join(PHOTO_DIR, f), () => {});
    return files.length;
  }
  r.get('/leave', (req, res) => {
    if (!req.user) return loginRedirect(req, res);
    const n = (q('SELECT COUNT(*) n FROM posts WHERE user_id=? AND deleted=0').get(req.user.id) || {}).n || 0;
    const c = (q('SELECT COUNT(*) n FROM comments WHERE user_id=? AND deleted=0').get(req.user.id) || {}).n || 0;
    page(res, 'leave', { title: '회원 탈퇴', postN: n, cmtN: c });
  });
  r.get('/bye', (req, res) => page(res, 'msg', { title: '탈퇴가 완료되었습니다', msg: '그동안 하월시아 클럽을 이용해 주셔서 감사합니다.' }));
  r.post('/api/me/leave', (req, res) => {
    if (!req.user) return fail(res, 401, '로그인이 필요합니다.');
    if (String(req.body.confirm || '').trim() !== '탈퇴') return fail(res, 400, '확인란에 「탈퇴」를 입력해 주세요.');
    const uid = req.user.id, nick = req.user.nick;
    const nf = deleteUser(uid);
    console.log('[club] 회원 탈퇴:', uid, '사진 파일', nf, '개 지움');
    setCookie(req, res, 'x', 0);
    res.json({ ok: true, bye: nick });
  });

  // ---- 개인정보처리방침 (누구나 볼 수 있음 — 구글 플레이 등록 주소) ----
  const PRIVACY_DEF = { company: '지양하월시아', officer: '', email: '', tel: '', since: '2026-11-17' };
  function privacyCfg() {
    let c = {};
    try { c = JSON.parse((q("SELECT v FROM kv WHERE k='privacy'").get() || {}).v || '{}'); } catch (e) { c = {}; }
    return Object.assign({}, PRIVACY_DEF, c);
  }
  r.get('/privacy', (req, res) => {
    page(res, 'privacy', { title: '개인정보처리방침', pv: privacyCfg(), kakaoOn: kakaoOn(), siteUrl: originOf(req) + req.B });
  });
  r.post('/api/admin/privacy', (req, res) => {
    if (!needAdmin(req, res)) return;
    const c = privacyCfg();
    for (const k of ['company', 'officer', 'email', 'tel', 'since']) if (req.body[k] !== undefined) c[k] = String(req.body[k] || '').trim().slice(0, 80);
    if (c.since && !/^\d{4}-\d{2}-\d{2}$/.test(c.since)) return fail(res, 400, '시행일은 2026-11-17 형식으로 입력해 주세요.');
    q("INSERT OR REPLACE INTO kv(k,v) VALUES('privacy',?)").run(JSON.stringify(c));
    res.json({ ok: true });
  });

  // 다른 회원이 90일 안에 버린 닉네임은 못 씀 (사칭 막기 — 옛 주소도 그 회원에게 넘어가고 있음)
  function oldNickTaken(key, myId) {
    return !!q('SELECT 1 FROM nick_history WHERE old_key=? AND user_id<>? AND changed_at>?').get(key, myId || 0, now() - 90 * DAY);
  }
  // 닉네임은 3개월(90일)에 한 번만 바꿀 수 있다 (사장님 결정 2026-11-16). 가입 때 정한 건 셈하지 않음 → 첫 변경은 바로 가능
  const NICK_GAP = 90 * DAY;
  function nickNextAt(u) { return u && u.nick_changed_at ? u.nick_changed_at + NICK_GAP : 0; }
  r.post('/api/me/edit', (req, res) => {
    if (!needUser(req, res)) return;
    // 보낸 것만 바꾼다 (예전엔 닉네임만 바꿔도 소개가 지워졌음)
    const bio = req.body.bio !== undefined ? String(req.body.bio || '').trim().slice(0, 120) : (req.user.bio || '');
    let nick = req.user.nick, key = req.user.nick_key, changed = false;
    if (req.body.nick !== undefined && String(req.body.nick).trim() !== req.user.nick) {
      const until = nickNextAt(req.user);
      if (until > now()) return fail(res, 429, req.t('닉네임은 3개월에 한 번만 변경할 수 있습니다. {date}부터 다시 변경할 수 있습니다.', { date: T.ymd(until) }));
      const n = T.checkNick(req.body.nick);
      if (n.error) return fail(res, 400, n.error);
      const ex = q('SELECT id FROM users WHERE nick_key=?').get(n.key);
      if (ex && ex.id !== req.user.id) return fail(res, 409, '이미 사용 중인 닉네임입니다.');
      if (oldNickTaken(n.key, req.user.id)) return fail(res, 409, '최근 다른 회원이 사용한 닉네임이므로 현재 사용할 수 없습니다.');
      nick = n.nick; key = n.key; changed = true;
    }
    if (changed) {
      tx(db, () => {
        q('UPDATE users SET nick=?, nick_key=?, bio=?, nick_changed_at=? WHERE id=?').run(nick, key, bio, now(), req.user.id);
        // 예전 주소 → 새 주소 (옛 닉네임을 기억). 내 옛 닉네임으로 되돌아오면 그 줄은 지움
        if (req.user.nick_key !== key) q('INSERT OR REPLACE INTO nick_history(old_key,user_id,changed_at) VALUES(?,?,?)').run(req.user.nick_key, req.user.id, now());
        q('DELETE FROM nick_history WHERE old_key=?').run(key);
      });
    }
    else q('UPDATE users SET bio=? WHERE id=?').run(bio, req.user.id);
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
      if (err) return fail(res, 400, err.code === 'LIMIT_FILE_SIZE' ? '사진 한 장이 너무 큽니다. (12MB 까지)' : req.t('사진을 등록하지 못했습니다: {e}', { e: err.message }));
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
      if (!idx.length && !body) { dropFiles(files); return fail(res, 400, '사진 또는 내용을 입력해 주세요.'); }
      if (limited('post:' + req.user.id, 30, DAY)) { dropFiles(files); return fail(res, 429, '하루 30개까지 등록할 수 있습니다.'); }
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
        applyPickedSpecies(pid, req.body);
        const sp = q('SELECT species FROM posts WHERE id=?').get(pid).species;
        return { id: pid, tags, plant: plant ? plant.id : null, species: sp, speciesName: speciesName(sp) };
      });
      res.json({ ok: true, ...result, url: `${req.B}/p/${result.id}` });
      if (idx.length) {
        const author = req.user.id, pid = result.id;
        setImmediate(() => {
          try {
            for (const f of q('SELECT follower_id FROM follows WHERE followee_id=?').all(author)) notify.add(f.follower_id, 'newpost', { actor: author, post: pid, ukey: `np:${pid}:${f.follower_id}` });
          } catch (e) { console.warn('[club] 새 사진 알림 실패:', e.message); }
        });
      }
    } catch (e) {
      dropFiles(files);
      if (!res.headersSent) fail(res, 400, e.message);
    }
  });

  r.post('/api/posts/:id/edit', async (req, res) => {
    if (!needUser(req, res)) return;
    const p = q('SELECT * FROM posts WHERE id=? AND deleted=0').get(parseInt(req.params.id, 10));
    if (!p || p.user_id !== req.user.id) return fail(res, 404, '본인의 게시물이 아닙니다.');
    await arkData(2500);
    try {
      const body = String(req.body.body || '').trim().slice(0, 2000);
      tx(db, () => {
        const plant = pickPlant(req, req.body);
        q('UPDATE posts SET body=?, plant_id=?, edited_at=? WHERE id=?').run(body, plant ? plant.id : null, now(), p.id);
        if (String(req.body.species_pick || '') === 'auto') q("UPDATE posts SET species_src='auto' WHERE id=?").run(p.id);
        setPostTags(p.id, body, plant);
        applyPickedSpecies(p.id, req.body);
      });
      res.json({ ok: true, url: `${req.B}/p/${p.id}` });
    } catch (e) { fail(res, 400, e.message); }
  });

  r.post('/api/posts/:id/delete', (req, res) => {
    if (!needUser(req, res)) return;
    const p = q('SELECT * FROM posts WHERE id=? AND deleted=0').get(parseInt(req.params.id, 10));
    if (!p || (p.user_id !== req.user.id && !req.isAdmin)) return fail(res, 404, '본인의 게시물이 아닙니다.');
    q('UPDATE posts SET deleted=1 WHERE id=?').run(p.id);
    q('UPDATE tags SET pinned_post=NULL WHERE pinned_post=?').run(p.id);
    res.json({ ok: true });
  });

  r.post('/api/posts/:id/like', (req, res) => {
    if (!needUser(req, res)) return;
    const p = q(`SELECT id, user_id FROM posts p WHERE id=? AND ${VISIBLE}`).get(parseInt(req.params.id, 10));
    if (!p) return fail(res, 404, '게시물이 없습니다.');
    const had = q('SELECT 1 FROM likes WHERE post_id=? AND user_id=?').get(p.id, req.user.id);
    const lk = `like:${p.id}:${req.user.id}`;
    if (had) { q('DELETE FROM likes WHERE post_id=? AND user_id=?').run(p.id, req.user.id); notify.remove(lk); }
    else { q('INSERT INTO likes(post_id,user_id,created_at) VALUES(?,?,?)').run(p.id, req.user.id, now()); notify.add(p.user_id, 'like', { actor: req.user.id, post: p.id, ukey: lk }); }
    const n = q('SELECT COUNT(*) n FROM likes WHERE post_id=?').get(p.id).n;
    res.json({ ok: true, liked: !had, n });
  });

  r.post('/api/posts/:id/comments', (req, res) => {
    if (!needUser(req, res)) return;
    const p = q(`SELECT id, user_id FROM posts p WHERE id=? AND ${VISIBLE}`).get(parseInt(req.params.id, 10));
    if (!p) return fail(res, 404, '게시물이 없습니다.');
    const body = String(req.body.body || '').trim().slice(0, 500);
    if (!body) return fail(res, 400, '댓글을 입력해 주세요.');
    if (limited('cmt:' + req.user.id, 100, DAY)) return fail(res, 429, '하루 댓글 작성 한도를 초과했습니다.');
    const info = q('INSERT INTO comments(post_id,user_id,body,created_at) VALUES(?,?,?,?)').run(p.id, req.user.id, body, now());
    const cid = Number(info.lastInsertRowid);
    notify.add(p.user_id, 'comment', { actor: req.user.id, post: p.id, comment: cid, ukey: `cmt:${cid}` });
    res.json({ ok: true, id: cid });
  });

  r.post('/api/comments/:id/delete', (req, res) => {
    if (!needUser(req, res)) return;
    const c = q('SELECT * FROM comments WHERE id=? AND deleted=0').get(parseInt(req.params.id, 10));
    if (!c || (c.user_id !== req.user.id && !req.isAdmin)) return fail(res, 404, '본인의 댓글이 아닙니다.');
    q('UPDATE comments SET deleted=1 WHERE id=?').run(c.id);
    notify.remove(`cmt:${c.id}`);
    res.json({ ok: true });
  });

  // =============================================================
  // 팔로우 (v29)
  // =============================================================
  function followCounts(uid) {
    return {
      followers: (q('SELECT COUNT(*) n FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.followee_id=? AND u.blocked=0').get(uid) || {}).n || 0,
      following: (q('SELECT COUNT(*) n FROM follows f JOIN users u ON u.id=f.followee_id WHERE f.follower_id=? AND u.blocked=0').get(uid) || {}).n || 0,
    };
  }
  r.post('/api/follow', (req, res) => {
    if (!needUser(req, res)) return;
    const u = q('SELECT id, nick FROM users WHERE nick_key=? AND blocked=0').get(String(req.body.nick || '').toLowerCase());
    if (!u) return fail(res, 404, '회원을 찾을 수 없습니다');
    if (u.id === req.user.id) return fail(res, 400, '본인은 팔로우할 수 없습니다.');
    const had = q('SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?').get(req.user.id, u.id);
    const fk = `follow:${u.id}:${req.user.id}`;
    const want = req.body.on === undefined ? !had : !!req.body.on;
    if (want && !had) {
      if (limited('follow:' + req.user.id, 300, DAY)) return fail(res, 429, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
      q('INSERT INTO follows(follower_id,followee_id,created_at) VALUES(?,?,?)').run(req.user.id, u.id, now());
      notify.add(u.id, 'follow', { actor: req.user.id, ukey: fk });
    } else if (!want && had) {
      q('DELETE FROM follows WHERE follower_id=? AND followee_id=?').run(req.user.id, u.id);
      notify.remove(fk);
    }
    const fc = followCounts(u.id);
    res.json({ ok: true, following: want, followers: fc.followers, followingN: fc.following });
  });
  // 팔로워 · 팔로잉 목록
  r.get('/u/:nick/follows', (req, res) => {
    const u = q('SELECT * FROM users WHERE nick_key=?').get(String(req.params.nick || '').toLowerCase());
    if (!u && oldNickRedirect(req, res)) return;
    if (!u) return res.status(404), page(res, 'msg', { title: '회원을 찾을 수 없습니다', msg: '닉네임을 다시 확인해 주세요.' });
    const tab = req.query.tab === 'following' ? 'following' : 'followers';
    const rows = tab === 'followers'
      ? q('SELECT u.* FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.followee_id=? AND u.blocked=0 ORDER BY f.created_at DESC LIMIT 300').all(u.id)
      : q('SELECT u.* FROM follows f JOIN users u ON u.id=f.followee_id WHERE f.follower_id=? AND u.blocked=0 ORDER BY f.created_at DESC LIMIT 300').all(u.id);
    withTiers(rows);
    const mine = req.user ? new Set(q('SELECT followee_id id FROM follows WHERE follower_id=?').all(req.user.id).map((x) => x.id)) : new Set();
    rows.forEach((x) => { x.iFollow = mine.has(x.id); });
    page(res, 'follows', { u, tab, rows, fol: followCounts(u.id), title: req.t('{nick}님의 온실', { nick: u.nick }), rawTitle: true });
  });

  // =============================================================
  // 알림 (v29) — 🔔 목록 · 폰 알림 켜기/끄기
  // =============================================================
  r.get('/noti', (req, res) => {
    if (!req.user) return loginRedirect(req, res);
    const list = notify.list(req.user.id);
    notify.markRead(req.user.id);
    res.locals.notiN = 0;
    page(res, 'noti', { list, pushKey: notify.publicKey, subN: notify.subCount(req.user.id), title: '알림' });
  });
  r.post('/api/push/sub', (req, res) => {
    if (!needUser(req, res)) return;
    if (limited('pushsub:' + req.user.id, 30, DAY)) return fail(res, 429, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    if (!notify.subscribe(req.user.id, req.body.sub, req.headers['user-agent'])) return fail(res, 400, '잘못된 요청입니다.');
    // 켜자마자 한 번 보내서 폰에서 확인되게
    const t = I18N.makeT(req.user.lang || req.lang);
    notify.pushTo(req.user.id, { title: t('휴대폰 알림이 설정되었습니다.'), body: t('댓글·좋아요·팔로우 소식을 휴대폰 알림으로 보내 드립니다.'), url: 'noti', tag: 'welcome' }).catch(() => {});
    res.json({ ok: true, n: notify.subCount(req.user.id) });
  });
  r.post('/api/push/unsub', (req, res) => {
    if (!needUser(req, res)) return;
    notify.unsubscribe(req.user.id, req.body.endpoint);
    res.json({ ok: true, n: notify.subCount(req.user.id) });
  });
  if (DEV) {
    r.get('/_pushlog', (req, res) => res.json(notify.pushLog));
    r.post('/_diaryrun', (req, res) => res.json({ ok: true, n: notify.diaryReminders() }));
    r.post('/_shoprefresh', async (req, res) => { await shop.refresh(); res.json({ ok: true, n: shop.state.items.length, error: shop.state.error, complete: shop.state.complete }); });
  }

  // 공유 카드에 넣는 QR (클럽 주소만)
  function clubOrigin(req) { return CLUB_URL || `${req.protocol}://${req.get('host')}${req.B}`; }
  r.get('/qr.svg', (req, res) => {
    const u = String(req.query.u || '');
    const okHost = [clubOrigin(req), `${req.protocol}://${req.get('host')}`].some((o) => u.startsWith(o + '/'));
    if (!okHost || u.length > 400 || /[^\x21-\x7e]/.test(u)) return res.status(400).send('bad');
    const qr = qrcode(0, 'M'); qr.addData(u); qr.make();
    const svg = qr.createSvgTag({ cellSize: 8, margin: 2 }).replace(/fill="black"/g, 'fill="#1F4129"').replace(/fill="#000000"/g, 'fill="#1F4129"');
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
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
    if (!name) return fail(res, 400, '식물 이름을 입력해 주세요.');
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
    if (!name) return fail(res, 400, '이름을 입력해 주세요.');
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
    if (!id || id.length < 4) return fail(res, 400, '보증서 링크 또는 넘버를 입력해 주세요.');
    if (limited('cert:' + req.user.id, 10, 3600 * 1000)) return fail(res, 429, '1시간에 10회까지 확인할 수 있습니다.');
    const ck = certKeyOf(id);
    const taken = q("SELECT pl.id, u.nick FROM plants pl JOIN users u ON u.id=pl.user_id WHERE pl.cert_key=? AND pl.cert_status='ok' AND pl.deleted=0 AND pl.id<>?").get(ck, pl.id);
    if (taken) return fail(res, 409, '이 넘버는 이미 다른 회원의 식물에 정품으로 연결되어 있습니다. 소유권을 이전하셨다면 운영자에게 문의해 주세요.');
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
      return fail(res, 503, '방주 장부를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
    if (!info) return fail(res, 404, '방주에 등록되지 않은 넘버입니다. 보증서에 적힌 넘버를 그대로 입력해 주세요.');
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
    const tagRows = q(`SELECT t.key, t.label, t.pinned_post, t.species, COUNT(p.id) n FROM tags t LEFT JOIN post_tags pt ON pt.tag_key=t.key LEFT JOIN posts p ON p.id=pt.post_id AND ${VISIBLE}
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
    const spList = speciesList().map((x) => ({ ...x, n: q('SELECT COUNT(*) n FROM posts WHERE species=? AND deleted=0').get(x.id).n }));
    const etcN = q('SELECT COUNT(*) n FROM posts WHERE species IS NULL AND deleted=0').get().n;
    // 🛒 판매 연결: 품종 태그마다 판매중 상품 수 (많은 순 40개)
    const shopRows = shop.enabled ? q("SELECT key, label, shop_off FROM tags WHERE merged_into=''").all()
      .map((tg) => ({ key: tg.key, label: tg.label, off: !!tg.shop_off, n: shop.match(tg.key).n })).filter((x) => x.n > 0)
      .sort((x, y) => y.n - x.n).slice(0, 40) : [];
    const shopInfo = { enabled: shop.enabled, n: shop.state.items.length, at: shop.state.at, error: shop.state.error, complete: shop.state.complete, url: shop.SHOP_URL };
    const pushN = (q('SELECT COUNT(DISTINCT user_id) n FROM push_subs').get() || {}).n || 0;
    // 🏆 이벤트: 설정 + 지금 순위 20명 (연락용 번호는 운영자만)
    const evc = ev.cfg(), evs = ev.state();
    const evTop = evs.rows.slice(0, 20).map((r) => Object.assign({}, r, { phone: (q('SELECT phone FROM users WHERE id=?').get(r.userId) || {}).phone || '' }));
    const evEx = (evc.exclude || []).length ? q(`SELECT id, nick FROM users WHERE id IN (${evc.exclude.map(() => '?').join(',')})`).all(...evc.exclude) : [];
    const evAdm = { cfg: evc, phase: evs.phase, voided: evs.voided, top: evs.top, prizes: evs.prizes, at: evs.at, rows: evTop, ex: evEx, startYmd: ev.kstYmd(evc.start), endYmd: ev.kstYmd(evc.end) };
    page(res, 'admin', { evAdm, privacyAdm: privacyCfg(), pending, reports, tagRows, typos, hidden, stats, users, spList, etcN, shopRows, shopInfo, pushN, arkReady: ark.t > 0, arkOfficial: ark.official.size, arkNames: ark.names.size, title: '운영자' });
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
    if (!from || !to) return fail(res, 400, '태그 두 개를 모두 입력해 주세요.');
    if (from === to) return fail(res, 400, '같은 태그입니다.');
    if (!q('SELECT 1 FROM tags WHERE key=?').get(from)) return fail(res, 404, `#${req.body.from} 태그가 없습니다.`);
    await arkData(0);
    const moved = tx(db, () => {
      ensureTag(to, String(req.body.to || '').replace(/^#/, ''));
      const rows = q('SELECT post_id FROM post_tags WHERE tag_key=?').all(from);
      for (const x of rows) q('INSERT OR IGNORE INTO post_tags(post_id,tag_key) VALUES(?,?)').run(x.post_id, to);
      q('DELETE FROM post_tags WHERE tag_key=?').run(from);
      q('UPDATE plants SET tag_key=? WHERE tag_key=?').run(to, from);
      q('UPDATE tags SET species=COALESCE(species,(SELECT species FROM tags WHERE key=?)) WHERE key=?').run(from, to);
      q("UPDATE tags SET merged_into=?, pinned_post=NULL WHERE key=?").run(to, from);
      q("UPDATE tags SET merged_into=? WHERE merged_into=?").run(to, from);
      return rows.length;
    });
    recomputeSpeciesForTag(to);
    res.json({ ok: true, moved, to });
  });
  // 종 목록 고치기: add / rename / move / delete
  r.post('/api/admin/species', (req, res) => {
    if (!needAdmin(req, res)) return;
    const a = String(req.body.action || '');
    const id = parseInt(req.body.id, 10) || 0;
    const name = String(req.body.name || req.body.value || '').trim().slice(0, 20);
    if (a === 'add') {
      if (!name) return fail(res, 400, '종 이름을 입력해 주세요.');
      if (/^etc$/i.test(name)) return fail(res, 400, 'ETC 는 따로 만들지 않아도 맨 끝에 항상 있습니다.');
      if (q('SELECT 1 FROM species WHERE name=?').get(name)) return fail(res, 409, '이미 있는 종입니다.');
      const mx = (q('SELECT MAX(ord) m FROM species').get() || {}).m || 0;
      q('INSERT INTO species(name,ord,created_at) VALUES(?,?,?)').run(name, mx + 1, now());
      return res.json({ ok: true });
    }
    const sp = q('SELECT * FROM species WHERE id=?').get(id);
    if (!sp) return fail(res, 404, '없는 종입니다.');
    if (a === 'i18n') {
      // "English / 简体 / 繁體" 를 / 로 나눠 받는다
      const parts = String(req.body.value || req.body.names || '').split('/').map((x) => x.trim().slice(0, 40));
      q('UPDATE species SET name_en=?, name_zhs=?, name_zht=? WHERE id=?').run(parts[0] || '', parts[1] || '', parts[2] || parts[1] || '', id);
    } else if (a === 'rename') {
      if (!name) return fail(res, 400, '이름을 입력해 주세요.');
      q('UPDATE species SET name=? WHERE id=?').run(name, id);
    } else if (a === 'move') {
      const list = speciesList(); const i = list.findIndex((x) => x.id === id); const j = i + (parseInt(req.body.dir, 10) < 0 ? -1 : 1);
      if (j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; list.forEach((x, k) => q('UPDATE species SET ord=? WHERE id=?').run(k + 1, x.id)); }
    } else if (a === 'delete') {
      tx(db, () => {
        q('UPDATE tags SET species=NULL WHERE species=?').run(id);
        q("UPDATE posts SET species=NULL WHERE species=?").run(id);
        q('DELETE FROM species WHERE id=?').run(id);
      });
    } else return fail(res, 400, '알 수 없는 동작입니다.');
    res.json({ ok: true });
  });
  // 품종 태그 → 종 연결 (직접 고르지 않은 예전 글도 함께 바뀜)
  // 🛒 판매 연결: 지금 다시 읽기 · 품종마다 끄기/켜기
  // 🏆 활동왕 이벤트 화면 (꺼져 있으면 운영자만 미리 보기)
  r.get('/event', (req, res) => {
    const c = ev.cfg();
    if (!c.on && !req.isAdmin) return res.redirect(req.B + '/');
    const st = ev.state();
    const my = req.user ? ev.mine(st, req.user.id) : null;
    const show = st.rows.slice(0, Math.max(10, st.prizes.length));
    const meRow = my && my.me && my.me.rank > show.length ? my.me : null;
    page(res, 'event', { st, my, show, meRow, groups: ev.groups(c.prizes), voidGroups: ev.groups(c.prizes.slice(0, c.voidN)), startYmd: ev.kstYmd(c.start), endYmd: ev.kstYmd(c.end),
      tf: tfOf(res.locals.t), title: c.title, rawTitle: false });
  });
  r.post('/api/admin/event', (req, res) => {
    if (!needAdmin(req, res)) return;
    const a = String(req.body.action || '');
    const c = ev.cfg();
    const todayStart = ev.kstDayStart(ev.kstYmd(now()));
    if (a === 'on') { c.on = true; if (!c.start) c.start = todayStart; ev.save(c); return res.json({ ok: true, start: ev.kstYmd(c.start) }); }
    if (a === 'off') { c.on = false; ev.save(c); return res.json({ ok: true }); }
    if (a === 'recalc') { ev.clearFinal(); return res.json({ ok: true }); }
    if (a === 'exclude' || a === 'include') {
      const id = parseInt(req.body.user_id, 10);
      const set = new Set((c.exclude || []).map(Number));
      if (a === 'exclude') set.add(id); else set.delete(id);
      c.exclude = [...set]; ev.save(c); ev.clearFinal(); return res.json({ ok: true });
    }
    if (a === 'save') {
      const b = req.body;
      const num = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      const title = String(b.title || '').trim().slice(0, 40);
      if (!title) return fail(res, 400, '이벤트 이름을 입력해 주세요.');
      // 시작일을 비우면: 켜져 있으면 지금 시작일 그대로(없으면 오늘), 꺼져 있으면 켜는 날
      const start = b.start ? ev.kstDayStart(b.start) : (c.on ? (c.start || todayStart) : 0);
      const endDay = ev.kstDayStart(b.end);
      if (b.start && !start) return fail(res, 400, '시작일은 2026-11-17 형식으로 입력해 주세요.');
      if (!endDay) return fail(res, 400, '마감일은 2026-12-31 형식으로 입력해 주세요.');
      const end = endDay + 24 * 3600 * 1000 - 1;
      if (start && end <= start) return fail(res, 400, '마감일은 시작일 이후여야 합니다.');
      const prizes = String(b.prizes || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 30);
      if (!prizes.length) return fail(res, 400, '상품을 한 줄에 하나씩 입력해 주세요 (1위부터).');
      Object.assign(c, {
        title, start, end, prizes, announce: String(b.announce || '').trim().slice(0, 40),
        minTop: num(b.minTop, 0, 100000, 150), voidN: num(b.voidN, 0, prizes.length, 2),
        postPt: num(b.postPt, 1, 100, 3), cmtPt: num(b.cmtPt, 0, 100, 1), postDay: num(b.postDay, 1, 50, 3), cmtDay: num(b.cmtDay, 0, 200, 10), cmtMin: num(b.cmtMin, 1, 50, 5),
      });
      ev.save(c); ev.clearFinal();
      return res.json({ ok: true });
    }
    fail(res, 400, '알 수 없는 동작입니다.');
  });
  r.post('/api/admin/shop', async (req, res) => {
    if (!needAdmin(req, res)) return;
    const a = String(req.body.action || '');
    if (a === 'refresh') { await shop.refresh(); return res.json({ ok: !shop.state.error, n: shop.state.items.length, error: shop.state.error }); }
    if (a === 'toggle') {
      const key = T.tagKey(req.body.tag || '');
      const tg = q('SELECT key, shop_off FROM tags WHERE key=?').get(key);
      if (!tg) return fail(res, 404, '없는 태그입니다.');
      q('UPDATE tags SET shop_off=? WHERE key=?').run(tg.shop_off ? 0 : 1, key);
      return res.json({ ok: true, off: !tg.shop_off });
    }
    fail(res, 400, '알 수 없는 동작입니다.');
  });

  r.post('/api/admin/tag-species', (req, res) => {
    if (!needAdmin(req, res)) return;
    const key = resolveTag(T.tagKey(req.body.tag));
    if (!q('SELECT 1 FROM tags WHERE key=?').get(key)) return fail(res, 404, '없는 태그입니다.');
    const v = String(req.body.species || '');
    const id = parseInt(v, 10) || null;
    if (id && !q('SELECT 1 FROM species WHERE id=?').get(id)) return fail(res, 404, '없는 종입니다.');
    q('UPDATE tags SET species=? WHERE key=?').run(id, key);
    const n = recomputeSpeciesForTag(key);
    res.json({ ok: true, updated: n, name: speciesName(id) });
  });
  // 글 하나의 종을 운영자가 고치기
  r.post('/api/admin/post-species', (req, res) => {
    if (!needAdmin(req, res)) return;
    const pid = parseInt(req.body.post_id, 10);
    if (!q('SELECT 1 FROM posts WHERE id=?').get(pid)) return fail(res, 404, '없는 글입니다.');
    const v = String(req.body.species || '');
    if (v === 'auto') { q("UPDATE posts SET species_src='auto' WHERE id=?").run(pid); q("UPDATE posts SET species=? WHERE id=?").run(autoSpecies(postTagKeys(pid)), pid); }
    else applyPickedSpecies(pid, { species_pick: 'user', species: v });
    res.json({ ok: true });
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

  if (DEV) r.get('/_missing', (req, res) => res.json([...MISSING].sort()));

  r.use((req, res) => { res.status(404); page(res, 'msg', { title: '페이지가 없습니다', msg: '주소를 다시 확인해 주세요.' }); });
  r.use((err, req, res, next) => {
    console.error('[club] 오류:', err);
    if (res.headersSent) return;
    res.status(500);
    if (req.path.startsWith('/api/')) return res.json({ ok: false, error: '서버 오류: ' + err.message });
    page(res, 'msg', { title: '일시적인 오류가 발생했습니다', msg: '다시 시도해 주세요.' });
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
      // 개인정보처리방침에 적은 대로: 인증 문자 기록 30일, 안 쓰는 로그인 180일 뒤 지움
      q('DELETE FROM sms_codes WHERE created_at<?').run(now() - 30 * DAY);
      q('DELETE FROM sessions WHERE last_at<?').run(now() - SESSION_DAYS * DAY);
    } catch (e) { console.warn('[club] 백업 실패:', e.message); }
  }
  setTimeout(backup, 4 * 60 * 1000).unref();
  notify.startDiaryJob();
  shop.start();
  setInterval(backup, 6 * 3600 * 1000).unref();

  // 방주 가입 신청(/join)에서 쓰는 것: 휴대폰 번호로 클럽 활동 확인
  function statsByPhone(phone) {
    const u = q('SELECT * FROM users WHERE phone=?').get(T.normPhone(phone));
    if (!u) return { found: false, posts: 0, comments: 0, tier: tierOf({}) };
    withTiers([u]);
    return { found: true, nick: u.nick, posts: u.act.posts, comments: u.act.comments, tier: u.tier, ark: !!u.tier.ark, blocked: !!u.blocked };
  }

  // 방주 갤러리(/list)용: 품종 태그마다 대표 사진 = 같은 이름 태그 게시물 중 조회수가 가장 많은 글의 첫 사진
  // 조회수가 같으면 좋아요 → 댓글 → 최근 글 순. 숨김·삭제 글, 이용 제한 회원 글은 뺌. 5분 동안 기억
  let topCache = { t: 0, map: new Map() };
  function topPhotosByTag() {
    if (now() - topCache.t < 5 * 60 * 1000) return topCache.map;
    const rows = q(`SELECT pt.tag_key k, p.id, p.views, p.created_at, u.nick,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) lk,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND c.deleted=0 AND c.hidden=0) cm,
        (SELECT ph.file FROM photos ph WHERE ph.post_id=p.id ORDER BY ph.ord, ph.id LIMIT 1) file,
        (SELECT ph.thumb FROM photos ph WHERE ph.post_id=p.id ORDER BY ph.ord, ph.id LIMIT 1) thumb
      FROM post_tags pt JOIN posts p ON p.id=pt.post_id JOIN users u ON u.id=p.user_id
      WHERE ${VISIBLE} AND u.blocked=0 AND EXISTS(SELECT 1 FROM photos ph WHERE ph.post_id=p.id)`).all();
    const to = new Map(), seen = new Map(), map = new Map();
    const better = (a, b) => a.views !== b.views ? a.views > b.views : a.lk !== b.lk ? a.lk > b.lk : a.cm !== b.cm ? a.cm > b.cm : a.created_at > b.created_at;
    for (const r0 of rows) {
      if (!to.has(r0.k)) to.set(r0.k, resolveTag(r0.k));
      const k = to.get(r0.k);
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k).add(r0.id);
      const cur = map.get(k);
      if (!cur || better(r0, cur)) map.set(k, Object.assign({}, r0, { k }));
    }
    for (const [k, v] of map) v.n = seen.get(k).size;
    topCache = { t: now(), map };
    return map;
  }
  const clubBase = () => CLUB_URL || '/club';
  const tagLink = (key) => clubBase() + '/t/' + encodeURIComponent(key);
  const postLink = (id) => clubBase() + '/p/' + id;

  console.log('🌿 하월시아 클럽이 켜졌습니다. 데이터: ' + DATA_DIR);
  return { db, router: r, refreshArk, statsByPhone, topPhotosByTag, tagLink, postLink, TIERS };
}

module.exports = { mountClub, TIERS, tierOf };
