// =============================================================
// club/event.js — 🏆 활동왕 이벤트 (사장님 결정 2026-11-17)
//  - 점수: 사진 글 3점(하루 3개까지) + 남의 글 댓글 1점(5글자 이상, 하루 10개까지, 같은 글엔 하루 1개)
//  - 지운 글·숨긴 글·숨긴 댓글은 빠짐 · 운영자가 고른 회원·차단 회원 빠짐
//  - 같은 점수면 그 점수에 먼저 닿은 사람이 앞
//  - 마감 때 1등 점수가 150점 미만이면 앞의 상품 2개(마성·마카롱)는 없고, 1위부터 한 칸씩 내려 받음
//  - 시작 = 공지하는 날 0시 (운영자가 켜는 날, 운영자 화면에서 고칠 수 있음)
//  - 설정은 kv 표 'event', 마감 뒤 결과는 kv 'event_final' 에 한 번 고정 (운영자 「다시 계산」으로만 바뀜)
// =============================================================
const KST = 9 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;

// KST 날짜 'YYYY-MM-DD' ↔ ms
function kstDayStart(ymd) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - KST : 0; }
function kstYmd(ms) { return ms ? new Date(ms + KST).toISOString().slice(0, 10) : ''; }
const dayNo = (ms) => Math.floor((ms + KST) / DAY);

const DEFAULTS = {
  on: false,
  title: '연말 활동왕',
  start: 0,
  end: kstDayStart('2026-12-31') + DAY - 1,
  announce: '1월 2일',
  prizes: ['마성', '마카롱', '미스틱', '적립금 20만원', '적립금 10만원', '적립금 10만원', '적립금 10만원', '적립금 10만원', '적립금 10만원', '적립금 10만원'],
  minTop: 150,
  voidN: 2,
  postPt: 3, cmtPt: 1, postDay: 3, cmtDay: 10, cmtMin: 5,
  exclude: [],
};

// 댓글이 점수가 되는지: 띄어쓰기 빼고 5글자 이상, 한 글자만 되풀이(ㅋㅋㅋㅋㅋ, !!!!!)는 안 됨
function goodComment(body, min) {
  const s = Array.from(String(body || '').replace(/\s+/g, ''));
  if (s.length < min) return false;
  return new Set(s).size > 1;
}

function makeEvent({ q, now }) {
  now = now || Date.now;
  let cache = null; // { key, at, rows }

  function cfg() {
    let c = {};
    try { c = JSON.parse((q("SELECT v FROM kv WHERE k='event'").get() || {}).v || '{}'); } catch (e) { c = {}; }
    return Object.assign({}, DEFAULTS, c);
  }
  function save(c) {
    q("INSERT OR REPLACE INTO kv(k,v) VALUES('event',?)").run(JSON.stringify(c));
    cache = null;
  }
  function clearFinal() { q("DELETE FROM kv WHERE k='event_final'").run(); cache = null; }

  // 점수 계산 (start ~ min(end, 지금))
  function compute(c) {
    const t1 = Math.min(c.end, now());
    if (!c.start || t1 < c.start) return [];
    const excl = new Set((c.exclude || []).map(Number));
    for (const u of q('SELECT id FROM users WHERE blocked=1').all()) excl.add(u.id);
    const S = new Map();
    const get = (id) => { let s = S.get(id); if (!s) { s = { userId: id, pts: 0, posts: 0, cmts: 0, lastAt: 0, dp: new Map(), dc: new Map(), dpc: new Set() }; S.set(id, s); } return s; };
    const posts = q(`SELECT p.id, p.user_id, p.created_at FROM posts p
                     WHERE p.deleted=0 AND p.hidden=0 AND p.created_at>=? AND p.created_at<=?
                       AND EXISTS(SELECT 1 FROM photos ph WHERE ph.post_id=p.id) ORDER BY p.created_at, p.id`).all(c.start, t1);
    const cmts = q(`SELECT c.id, c.user_id, c.post_id, c.body, c.created_at FROM comments c JOIN posts p ON p.id=c.post_id
                    WHERE c.deleted=0 AND c.hidden=0 AND p.deleted=0 AND p.hidden=0 AND p.user_id<>c.user_id
                      AND c.created_at>=? AND c.created_at<=? ORDER BY c.created_at, c.id`).all(c.start, t1);
    // 글과 댓글을 시간 순서로 섞어서 (같은 점수에 먼저 닿은 사람을 가리려고)
    const evs = posts.map((p) => ({ t: p.created_at, kind: 'p', x: p })).concat(cmts.map((m) => ({ t: m.created_at, kind: 'c', x: m })))
      .sort((a, b) => a.t - b.t || (a.kind === b.kind ? a.x.id - b.x.id : a.kind === 'p' ? -1 : 1));
    for (const e of evs) {
      if (excl.has(e.x.user_id)) continue;
      const s = get(e.x.user_id), d = dayNo(e.t);
      if (e.kind === 'p') {
        const n = s.dp.get(d) || 0; if (n >= c.postDay) continue;
        s.dp.set(d, n + 1); s.posts++; s.pts += c.postPt; s.lastAt = e.t;
      } else {
        if (!goodComment(e.x.body, c.cmtMin)) continue;
        const n = s.dc.get(d) || 0; if (n >= c.cmtDay) continue;
        const k = d + ':' + e.x.post_id; if (s.dpc.has(k)) continue;
        s.dc.set(d, n + 1); s.dpc.add(k); s.cmts++; s.pts += c.cmtPt; s.lastAt = e.t;
      }
    }
    const rows = [...S.values()].filter((s) => s.pts > 0).sort((a, b) => b.pts - a.pts || a.lastAt - b.lastAt || a.userId - b.userId);
    const nick = new Map();
    if (rows.length) {
      const ids = rows.map((r) => r.userId), ph = ids.map(() => '?').join(',');
      for (const u of q(`SELECT id, nick FROM users WHERE id IN (${ph})`).all(...ids)) nick.set(u.id, u.nick);
    }
    return rows.map((r, i) => ({ rank: i + 1, userId: r.userId, nick: nick.get(r.userId) || '', pts: r.pts, posts: r.posts, cmts: r.cmts, lastAt: r.lastAt }));
  }

  // 상품 붙이기: 1등 점수가 minTop 미만이면 앞의 voidN 개 상품은 없음 → 1위부터 한 칸씩 내려 받음
  function award(rows, c) {
    const top = rows[0] ? rows[0].pts : 0;
    const voided = c.minTop > 0 && c.voidN > 0 && top < c.minTop;
    const prizes = voided ? c.prizes.slice(c.voidN) : c.prizes.slice();
    return { top, voided, prizes, rows: rows.map((r, i) => Object.assign({}, r, { prize: prizes[i] || '' })) };
  }

  function state() {
    const c = cfg();
    const t = now();
    const phase = !c.start || t < c.start ? 'soon' : t <= c.end ? 'live' : 'done';
    let rows, at;
    if (phase === 'done') {
      let f = null;
      try { f = JSON.parse((q("SELECT v FROM kv WHERE k='event_final'").get() || {}).v || 'null'); } catch (e) { f = null; }
      if (!f || f.end !== c.end || f.start !== c.start) {
        f = { start: c.start, end: c.end, at: t, rows: compute(c) };
        q("INSERT OR REPLACE INTO kv(k,v) VALUES('event_final',?)").run(JSON.stringify(f));
      }
      rows = f.rows; at = f.at;
    } else {
      const key = JSON.stringify(c);
      if (!cache || cache.key !== key || t - cache.at > 60 * 1000) cache = { key, at: t, rows: compute(c) };
      rows = cache.rows; at = cache.at;
    }
    const a = award(rows, c);
    return Object.assign({ cfg: c, phase, at, daysLeft: Math.max(0, dayNo(c.end) - dayNo(t)) }, a);   // 달력 날짜로 D-day (마감일 당일 = 0)
  }

  // 내 자리 + 선물 받는 자리까지 몇 점
  function mine(st, userId) {
    if (!userId) return null;
    const me = st.rows.find((r) => r.userId === userId) || null;
    const slots = st.prizes.length;
    const last = st.rows[slots - 1] || null;
    if (me && me.rank <= slots) return { me, inPrize: true, need: 0 };
    const need = last ? last.pts - (me ? me.pts : 0) + 1 : Math.max(1, st.cfg.cmtPt);
    const ps = Math.floor(need / st.cfg.postPt), cs = need - ps * st.cfg.postPt;
    return { me, inPrize: false, need, ps, cs, slots };
  }

  // 같은 상품끼리 묶어서 보여주기: [{from,to,label}]
  function groups(prizes) {
    const out = [];
    prizes.forEach((p, i) => { const g = out[out.length - 1]; if (g && g.label === p) g.to = i + 1; else out.push({ from: i + 1, to: i + 1, label: p }); });
    return out;
  }

  return { cfg, save, clearFinal, state, mine, groups, compute, award, goodComment, kstDayStart, kstYmd, DEFAULTS };
}

module.exports = { makeEvent, goodComment, kstDayStart, kstYmd };
