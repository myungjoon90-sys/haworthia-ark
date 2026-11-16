// =============================================================
// club/shop.js — 「지양하월시아에서 판매 중」 (품종 페이지 아래 작은 카드)
//  - 아임웹 상품 목록 API 에서 판매중(sale) 상품만 30분마다 읽어 둔다
//  - 품종 태그와 상품 이름을 띄어쓰기·대소문자 무시하고 비교 (#미카엘의심장 ↔ 「미카엘의 심장 3번」)
//  - Railway 변수 CLUB_IMWEB_KEY · CLUB_IMWEB_SECRET 가 있어야 켜진다 (없으면 조용히 꺼짐)
//  - 상품 주소: CLUB_SHOP_URL(기본 https://haworthia.co.kr) + /shop_view?idx=상품번호 (팔림 _feed_link 와 같은 모양)
//  - 아임웹 부르는 방법은 팔림 app.py 에서 실제로 쓰는 것과 같게 맞춤 (2026-11-16 확인):
//      토큰 GET https://api.imweb.me/v2/auth?key=&secret= → access_token
//      목록 GET https://api.imweb.me/v2/shop/products?limit=100&offset=쪽&page=쪽 (머리 access-token) → data.list, data.pagenation.total_page
// =============================================================
const DAY = 24 * 3600 * 1000;

function makeShop({ q, T, DEV }) {
  const KEY = process.env.CLUB_IMWEB_KEY || '';
  const SECRET = process.env.CLUB_IMWEB_SECRET || '';
  const API = (process.env.CLUB_IMWEB_API || 'https://api.imweb.me').replace(/\/$/, ''); // 시험 때만 바꿈
  const SHOP_URL = (process.env.CLUB_SHOP_URL || 'https://haworthia.co.kr').replace(/\/$/, '');
  const enabled = !!(KEY && SECRET);

  const state = { items: [], at: 0, error: '', pages: 0, complete: true, running: false };
  // 껐다 켜도 바로 보이게 마지막 목록을 데이터베이스에 둔다
  try {
    const row = q("SELECT v FROM kv WHERE k='shop_cache'").get();
    if (row) Object.assign(state, JSON.parse(row.v), { running: false });
  } catch (e) { /* 처음 */ }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function getJson(url, headers) {
    const res = await fetch(url, { headers: Object.assign({ Accept: 'application/json' }, headers || {}), signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { throw new Error('아임웹 응답을 읽지 못함 (' + res.status + ')'); }
  }
  async function token() {
    const j = await getJson(`${API}/v2/auth?key=${encodeURIComponent(KEY)}&secret=${encodeURIComponent(SECRET)}`);
    if (j.code !== 200 || !j.access_token) throw new Error('아임웹 토큰 실패: ' + (j.msg || j.code || ''));
    return j.access_token;
  }

  // 판매중인지: 상태 sale · 가격 있음 · (재고를 쓰는 상품이면) 재고 1개 이상
  function onSale(p) {
    if (p.prod_status && p.prod_status !== 'sale') return false;
    if (p.price_none === true || p.price_none === 'Y') return false;
    if (!(Number(p.price) > 0)) return false;
    const st = p.stock;
    if (st && typeof st === 'object' && !Array.isArray(st)) {
      const use = st.stock_use === true || st.stock_use === 'Y';
      const n = st.stock_no_option !== undefined ? Number(st.stock_no_option) : (st.stock_count !== undefined ? Number(st.stock_count) : NaN);
      if (use && !Number.isNaN(n) && n <= 0) return false;
    }
    return true;
  }

  async function refresh() {
    if (!enabled || state.running) return state;
    state.running = true;
    try {
      const tok = await token();
      const all = []; let first = null; let page = 1; let complete = false;
      for (; page <= 40; page++) {
        const j = await getJson(`${API}/v2/shop/products?prod_status=sale&limit=100&offset=${page}&page=${page}`, { 'access-token': tok });
        const d = j && j.data;
        const lst = (d && !Array.isArray(d) ? d.list : d) || [];
        if (!Array.isArray(lst) || !lst.length) { complete = true; break; }
        if (first !== null && lst[0] && lst[0].no === first) { complete = false; break; } // 같은 쪽이 되풀이됨
        if (first === null && lst[0]) first = lst[0].no;
        all.push(...lst);
        const pg = (d && (d.pagenation || d.pagination)) || {};
        const tp = parseInt(pg.total_page, 10) || 0;
        if ((tp && page >= tp) || (!tp && lst.length < 100)) { complete = true; break; }
        await sleep(DEV ? 0 : 1100);
      }
      const items = [];
      const seen = new Set();
      for (const p of all) {
        if (!p || p.no == null || seen.has(p.no) || !onSale(p)) continue;
        seen.add(p.no);
        const img = Array.isArray(p.image_url) ? p.image_url[0] : (typeof p.image_url === 'string' ? p.image_url : '');
        items.push({ no: p.no, name: String(p.name || '').slice(0, 80), key: T.tagKey(p.name || ''), price: Number(p.price) || 0, img: img || '', t: Number(p.add_time) || 0 });
      }
      Object.assign(state, { items, at: Date.now(), error: '', pages: page, complete });
      q("INSERT OR REPLACE INTO kv(k,v) VALUES('shop_cache',?)").run(JSON.stringify({ items, at: state.at, error: '', pages: page, complete }));
    } catch (e) {
      state.error = String(e.message || e).slice(0, 200);
      console.warn('[club] 판매 목록 읽기 실패:', state.error);
    } finally { state.running = false; }
    return state;
  }

  // 품종 열쇠로 판매중 상품 찾기 (짧은 이름은 엉뚱한 상품까지 잡혀서 2글자 이상만)
  function match(key) {
    if (!enabled || !key || key.length < 2) return { list: [], n: 0 };
    const list = state.items.filter((x) => x.key.includes(key)).sort((a, b) => (b.t - a.t) || (b.no - a.no));
    return { list: list.slice(0, 20), n: list.length };
  }
  const link = (no) => `${SHOP_URL}/shop_view?idx=${encodeURIComponent(no)}`;

  function start() {
    if (!enabled) return;
    setTimeout(() => refresh().catch(() => {}), DEV ? 200 : 20 * 1000).unref();
    setInterval(() => refresh().catch(() => {}), 30 * 60 * 1000).unref();
  }
  return { enabled, state, refresh, match, link, start, SHOP_URL };
}

module.exports = { makeShop };
