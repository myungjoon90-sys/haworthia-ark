// =============================================================
// club/notify.js — 알림 (클럽 안 🔔 목록) + 폰 알림 (웹 푸시, 문자 아님 · 무료)
//  - 알림 종류: like ♥ · comment 댓글 · follow 팔로우 · newpost 팔로우한 사람 새 사진 · diary 성장일기 30일
//  - 폰 알림 열쇠(VAPID)는 처음 켤 때 저절로 만들어 데이터베이스에 둔다 (Railway 변수로 덮어쓸 수도 있음)
//  - 아이폰은 iOS 16.4 이상 + 홈 화면에 클럽을 놓은 뒤에만 폰 알림을 켤 수 있다 (애플 규칙)
// =============================================================
const webpush = require('web-push');

const DAY = 24 * 3600 * 1000;

function makeNotify({ db, q, T, I18N, DEV }) {
  const now = () => Date.now();

  // ---- 폰 알림 열쇠 ----
  function vapid() {
    if (process.env.CLUB_VAPID_PUBLIC && process.env.CLUB_VAPID_PRIVATE) {
      return { publicKey: process.env.CLUB_VAPID_PUBLIC, privateKey: process.env.CLUB_VAPID_PRIVATE };
    }
    const row = q("SELECT v FROM kv WHERE k='vapid'").get();
    if (row) { try { return JSON.parse(row.v); } catch (e) { /* 아래에서 새로 */ } }
    const k = webpush.generateVAPIDKeys();
    q("INSERT OR REPLACE INTO kv(k,v) VALUES('vapid',?)").run(JSON.stringify(k));
    return k;
  }
  const KEYS = vapid();
  // 애플·구글이 연락처로 보는 값. https 주소나 mailto: 여야 한다
  const SUBJECT = process.env.CLUB_PUSH_SUBJECT || 'https://club.haworthia.co.kr';
  webpush.setVapidDetails(SUBJECT, KEYS.publicKey, KEYS.privateKey);

  // 시험 모드: 실제로 보내지 않고 만든 요청을 모아 둔다 (/club/_pushlog)
  const pushLog = [];

  // ---- 알림 문구 (받는 사람 언어로) ----
  function snippet(s, n) {
    const x = String(s || '').replace(/\s+/g, ' ').trim();
    return x.length > n ? x.slice(0, n) + '…' : x;
  }
  // url 은 클럽 안 상대 주소 — 폰의 알림 담당(서비스 워커)이 자기 주소(club. 또는 ark…/club/)에 붙여 연다
  function textOf(n, lang) {
    const t = I18N.makeT(lang || 'ko');
    const nick = n.actor_nick || '';
    switch (n.kind) {
      case 'comment': return { title: t('{nick}님이 댓글을 남겼습니다.', { nick }), body: snippet(n.comment_body, 80), url: `p/${n.post_id}#c${n.comment_id}` };
      case 'like': return { title: t('{nick}님이 회원님의 게시물을 좋아합니다.', { nick }), body: snippet(n.post_body, 60), url: `p/${n.post_id}` };
      case 'follow': return { title: t('{nick}님이 회원님을 팔로우합니다.', { nick }), body: t('온실 바로가기'), url: `u/${encodeURIComponent(nick)}` };
      case 'newpost': return { title: t('{nick}님의 새 사진', { nick }), body: snippet(n.post_body, 80), url: `p/${n.post_id}` };
      case 'diary': {
        const word = T.tagWord(n.tag_label || n.tag_key || '');
        return { title: t('#{tag} 마지막 기록 후 {n}일', { tag: word, n: n.days || 30 }), body: t('한 달 전 사진과 비교할 수 있도록 오늘의 모습을 기록해 주세요.'), url: `write?tag=${encodeURIComponent(word)}` };
      }
      default: return { title: t('하월시아 클럽'), body: '', url: 'noti' };
    }
  }

  // 알림 한 줄에 필요한 이름·글 내용 붙이기
  function hydrate(n) {
    if (n.actor_id) { const a = q('SELECT nick FROM users WHERE id=?').get(n.actor_id); n.actor_nick = a ? a.nick : ''; }
    if (n.post_id) { const p = q('SELECT body FROM posts WHERE id=?').get(n.post_id); n.post_body = p ? p.body : ''; }
    if (n.comment_id) { const c = q('SELECT body FROM comments WHERE id=?').get(n.comment_id); n.comment_body = c ? c.body : ''; }
    if (n.tag_key) { const tg = q('SELECT label FROM tags WHERE key=?').get(n.tag_key); n.tag_label = tg ? tg.label : n.tag_key; }
    return n;
  }

  // ---- 폰 알림 보내기 ----
  const likeThrottle = new Map(); // ♥ 폰 알림은 같은 글에 30분에 한 번만
  async function pushTo(userId, payload) {
    const subs = q('SELECT * FROM push_subs WHERE user_id=?').all(userId);
    if (!subs.length) return 0;
    const unread = unreadCount(userId);
    const body = JSON.stringify(Object.assign({ badge: unread }, payload));
    let sent = 0;
    for (const s of subs) {
      const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        if (DEV) {
          // 진짜 요청을 만들어만 본다 (암호화·서명까지) — 바깥으로는 안 보냄
          const d = webpush.generateRequestDetails(sub, body, { TTL: 24 * 3600 });
          pushLog.push({ user_id: userId, endpoint: s.endpoint, payload: JSON.parse(body), headers: d.headers, bodyLen: d.body.length });
          if (pushLog.length > 200) pushLog.shift();
        } else {
          await webpush.sendNotification(sub, body, { TTL: 24 * 3600, urgency: 'normal' });
        }
        q('UPDATE push_subs SET last_ok=?, fails=0 WHERE id=?').run(now(), s.id);
        sent++;
      } catch (e) {
        const code = e && e.statusCode;
        if (code === 404 || code === 410) q('DELETE FROM push_subs WHERE id=?').run(s.id); // 폰에서 알림을 끄거나 앱을 지움
        else {
          q('UPDATE push_subs SET fails=fails+1 WHERE id=?').run(s.id);
          q('DELETE FROM push_subs WHERE id=? AND fails>=10').run(s.id);
          console.warn('[club] 폰 알림 실패:', code || '', e && e.message);
        }
      }
    }
    return sent;
  }

  // ---- 알림 넣기 ----
  // opts: { actor, post, comment, tag, ukey, days }
  function add(userId, kind, opts) {
    opts = opts || {};
    if (!userId || (opts.actor && opts.actor === userId)) return false; // 내가 한 일은 알리지 않음
    const u = q('SELECT id, lang, blocked FROM users WHERE id=?').get(userId);
    if (!u) return false;
    if (opts.actor) { const a = q('SELECT blocked FROM users WHERE id=?').get(opts.actor); if (!a || a.blocked) return false; }
    const ukey = opts.ukey || null;
    const info = q('INSERT OR IGNORE INTO notifs(user_id,kind,actor_id,post_id,comment_id,tag_key,ukey,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(userId, kind, opts.actor || null, opts.post || null, opts.comment || null, opts.tag || null, ukey, now());
    if (!info.changes) return false;
    // 폰 알림
    if (kind === 'like') {
      const k = userId + ':' + opts.post;
      const last = likeThrottle.get(k) || 0;
      if (now() - last < 30 * 60 * 1000) return true;
      likeThrottle.set(k, now());
    }
    const n = hydrate({ kind, actor_id: opts.actor, post_id: opts.post, comment_id: opts.comment, tag_key: opts.tag, days: opts.days });
    const txt = textOf(n, u.lang || 'ko');
    pushTo(userId, Object.assign(txt, { tag: kind + ':' + (opts.post || opts.tag || opts.actor || '') })).catch(() => {});
    return true;
  }
  function remove(ukey) { if (ukey) q('DELETE FROM notifs WHERE ukey=?').run(ukey); }

  function unreadCount(userId) {
    return (q(`SELECT COUNT(*) n FROM notifs n LEFT JOIN posts p ON p.id=n.post_id
               WHERE n.user_id=? AND n.read_at=0 AND (n.post_id IS NULL OR (p.deleted=0 AND p.hidden=0))`).get(userId) || {}).n || 0;
  }

  // 목록 (♥ 은 글마다 한 줄로 묶음)
  function list(userId, limit) {
    const rows = q(`SELECT n.* FROM notifs n LEFT JOIN posts p ON p.id=n.post_id
                    WHERE n.user_id=? AND (n.post_id IS NULL OR (p.deleted=0 AND p.hidden=0))
                    ORDER BY n.id DESC LIMIT ?`).all(userId, limit || 120);
    const out = [];
    const likeAt = new Map();
    for (const r of rows) {
      if (r.kind === 'like') {
        const g = likeAt.get(r.post_id);
        if (g) { g.others++; if (!r.read_at) g.unread = true; continue; }
        const item = hydrate(Object.assign({}, r, { others: 0, unread: !r.read_at }));
        likeAt.set(r.post_id, item); out.push(item);
      } else {
        out.push(hydrate(Object.assign({}, r, { unread: !r.read_at })));
      }
    }
    // 사진 하나씩 (글 썸네일)
    for (const n of out) {
      if (n.post_id) { const ph = q('SELECT thumb FROM photos WHERE post_id=? ORDER BY ord LIMIT 1').get(n.post_id); n.thumb = ph ? ph.thumb : ''; }
    }
    return out.slice(0, 60);
  }
  function markRead(userId) { q('UPDATE notifs SET read_at=? WHERE user_id=? AND read_at=0').run(now(), userId); }

  // ---- 폰 알림 켜기·끄기 ----
  function subscribe(userId, sub, ua) {
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000) return false;
    const k = sub.keys || {};
    if (!k.p256dh || !k.auth || String(k.p256dh).length > 200 || String(k.auth).length > 100) return false;
    q(`INSERT INTO push_subs(user_id,endpoint,p256dh,auth,ua,created_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, ua=excluded.ua, fails=0`)
      .run(userId, sub.endpoint, String(k.p256dh), String(k.auth), String(ua || '').slice(0, 200), now());
    // 한 사람 기기 10대까지 (오래된 것부터 정리)
    q('DELETE FROM push_subs WHERE user_id=? AND id NOT IN (SELECT id FROM push_subs WHERE user_id=? ORDER BY id DESC LIMIT 10)').run(userId, userId);
    return true;
  }
  function unsubscribe(userId, endpoint) { q('DELETE FROM push_subs WHERE user_id=? AND endpoint=?').run(userId, String(endpoint || '')); }
  function subCount(userId) { return (q('SELECT COUNT(*) n FROM push_subs WHERE user_id=?').get(userId) || {}).n || 0; }

  // ---- 성장일기 30일 알림: 매일 오전 10시(한국) 한 번 ----
  //  같은 품종으로 마지막 사진을 올린 지 30일 넘은 사람에게, 하루 한 품종만, 같은 마지막 기록엔 한 번만
  function diaryReminders() {
    const t = now();
    const rows = q(`SELECT p.user_id, pt.tag_key, MAX(p.created_at) last_at, MAX(p.id) last_id
                    FROM posts p JOIN post_tags pt ON pt.post_id=p.id JOIN users u ON u.id=p.user_id
                    WHERE p.deleted=0 AND p.hidden=0 AND u.blocked=0 AND EXISTS(SELECT 1 FROM photos ph WHERE ph.post_id=p.id)
                    GROUP BY p.user_id, pt.tag_key
                    HAVING last_at <= ? AND last_at > ?
                    ORDER BY last_at DESC`).all(t - 30 * DAY, t - 60 * DAY);
    const done = new Set();
    let n = 0;
    for (const r of rows) {
      if (done.has(r.user_id)) continue;
      const ukey = `diary:${r.user_id}:${r.tag_key}:${r.last_id}`;
      if (q('SELECT 1 FROM notifs WHERE ukey=?').get(ukey)) continue;
      const days = Math.floor((t - r.last_at) / DAY);
      if (add(r.user_id, 'diary', { tag: r.tag_key, ukey, days })) { done.add(r.user_id); n++; }
    }
    return n;
  }
  function kstHour(ms) { return new Date(ms + 9 * 3600 * 1000).getUTCHours(); }
  function startDiaryJob() {
    const tick = () => {
      try {
        const today = T.ymd(now());
        const last = (q("SELECT v FROM kv WHERE k='diary_run'").get() || {}).v;
        if (kstHour(now()) === 10 && last !== today) {
          q("INSERT OR REPLACE INTO kv(k,v) VALUES('diary_run',?)").run(today);
          const n = diaryReminders();
          if (n) console.log('[club] 성장일기 알림', n, '명');
        }
      } catch (e) { console.warn('[club] 성장일기 알림 실패:', e.message); }
    };
    setInterval(tick, 10 * 60 * 1000).unref();
    setTimeout(tick, 60 * 1000).unref();
  }

  return { publicKey: KEYS.publicKey, add, remove, unreadCount, list, markRead, subscribe, unsubscribe, subCount, diaryReminders, startDiaryJob, textOf, hydrate, pushLog, pushTo };
}

module.exports = { makeNotify };
