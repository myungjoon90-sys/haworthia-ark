// =============================================================
// club/text.js — 해시태그·글 표시·전화번호 같은 글자 처리
// =============================================================

// 태그 열쇠: 띄어쓰기·기호·대소문자를 무시한다  (#미카엘의 심장 = #미카엘의심장 = #미카엘의-심장)
function tagKey(s) {
  return String(s || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40);
}
// 글 안에 넣는 태그 글자: 띄어쓰기·기호를 뺀 모양 (대소문자는 살림)
function tagWord(s) {
  return String(s || '').normalize('NFC').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 40);
}

// 글에서 #태그 뽑기 (# 다음 띄어쓰기·문장부호 전까지)
//  - 띄어 쓴 품종명도 알아본다: "#미카엘의 심장" → 뒤 1~3 낱말을 붙인 「미카엘의심장」이
//    방주 품종명이나 이미 있는 태그면 그것으로 (가장 긴 것 먼저)
const HASH_RE = /#([\p{L}\p{N}_]{1,40})/gu;
const NEXT_WORDS = /^(?:[ \t]+[\p{L}\p{N}_]{1,20}){1,3}/u;
let knownFn = null;
function setKnown(fn) { knownFn = fn; }
function hashSpans(body) {
  const s = String(body || '');
  const out = [];
  for (const m of s.matchAll(HASH_RE)) {
    let end = m.index + m[0].length;
    let label = m[1];
    let key = tagKey(m[1]);
    if (knownFn) {
      const more = NEXT_WORDS.exec(s.slice(end));
      if (more) {
        const words = more[0].split(/[ \t]+/).filter(Boolean);
        for (let n = words.length; n >= 1; n--) {
          const cand = tagKey(m[1] + words.slice(0, n).join(''));
          if (cand.length <= 40 && knownFn(cand)) {
            const phrase = [m[1]].concat(words.slice(0, n));
            // 원문에서 그 구간 길이 찾기
            let pos = end, w = 0;
            while (w < n) { const mm = /^[ \t]+([\p{L}\p{N}_]{1,20})/u.exec(s.slice(pos)); if (!mm) break; pos += mm[0].length; w++; }
            end = pos; label = phrase.join(' '); key = cand;
            break;
          }
        }
      }
    }
    out.push({ start: m.index, end, key, label, num: /^\d+$/.test(key) });
  }
  // 앞의 태그가 뒤로 늘어나 다음 #과 겹치면 겹친 것은 버린다
  const clean = [];
  for (const x of out) { if (clean.length && x.start < clean[clean.length - 1].end) continue; clean.push(x); }
  return clean;
}
function parseTags(body) {
  const out = [];
  const seen = new Set();
  for (const sp of hashSpans(body)) {
    if (!sp.key || sp.num || seen.has(sp.key)) continue; // 숫자만 있는 태그(#1, #2025)는 품종명이 아니라서 뺀다
    seen.add(sp.key);
    out.push({ key: sp.key, label: sp.label });
    if (out.length >= 10) break;
  }
  return out;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 글 본문 → 화면용 HTML (태그는 태그 페이지로 가는 링크, 줄바꿈 살림)
//  - 글자를 먼저 조각내고 조각마다 따로 escape 해서 &#39; 같은 것이 태그로 오인되지 않게 한다
function renderBody(body, base) {
  const s = String(body || '');
  let out = '';
  let last = 0;
  for (const sp of hashSpans(s)) {
    out += esc(s.slice(last, sp.start));
    const raw = s.slice(sp.start, sp.end);
    out += (sp.key && !sp.num) ? `<a class="htag" href="${base}/t/${encodeURIComponent(sp.key)}">${esc(raw)}</a>` : esc(raw);
    last = sp.end;
  }
  out += esc(s.slice(last));
  return out.replace(/\r?\n/g, '<br>');
}

function digits(s) { return String(s || '').replace(/[^0-9]/g, ''); }
// 한국 휴대폰만 (010…)
function normPhone(s) {
  let d = digits(s);
  if (d.startsWith('82')) d = '0' + d.slice(2);
  return /^01[016789]\d{7,8}$/.test(d) ? d : '';
}
function maskPhone(p) {
  const d = digits(p);
  if (d.length < 8) return d;
  return d.slice(0, 3) + '-****-' + d.slice(-4);
}
// 실명 가리기: 김철수 → 김**
function maskName(n) {
  const s = String(n || '').trim();
  if (!s) return '';
  return s[0] + '*'.repeat(Math.max(1, Math.min(3, s.length - 1)));
}

// 닉네임: 2~16자, 글자·숫자·_ . 만
function checkNick(n) {
  const s = String(n || '').normalize('NFC').trim();
  if (s.length < 2 || s.length > 16) return { error: '닉네임은 2~16자로 정해 주세요.' };
  if (!/^[\p{L}\p{N}_.]+$/u.test(s)) return { error: '닉네임에는 글자·숫자·_ . 만 쓸 수 있습니다. (띄어쓰기 안 됨)' };
  if (/^(admin|관리자|운영자|지양|jiyang|방주|ark)/i.test(s)) return { error: '운영자로 오해될 수 있는 닉네임은 쓸 수 없습니다.' };
  return { nick: s, key: s.toLowerCase() };
}

function timeAgo(ms, now) {
  const d = Math.max(0, (now || Date.now()) - ms);
  const m = Math.floor(d / 60000);
  if (m < 1) return '방금';
  if (m < 60) return m + '분 전';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '시간 전';
  const day = Math.floor(h / 24);
  if (day < 7) return day + '일 전';
  return ymd(ms);
}
function ymd(ms) {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '.');
}

// 두 태그 열쇠가 한 글자만 다른지 (오타 후보 찾기)
function nearlySame(a, b) {
  if (a === b) return false;
  const la = [...a], lb = [...b];
  if (Math.abs(la.length - lb.length) > 1) return false;
  if (Math.min(la.length, lb.length) < 3) return false;
  // 편집 거리 1 이하
  let i = 0, j = 0, diff = 0;
  while (i < la.length && j < lb.length) {
    if (la[i] === lb[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (la.length > lb.length) i++;
    else if (la.length < lb.length) j++;
    else { i++; j++; }
  }
  return diff + (la.length - i) + (lb.length - j) <= 1;
}

module.exports = { tagKey, tagWord, parseTags, hashSpans, setKnown, renderBody, esc, digits, normPhone, maskPhone, maskName, checkNick, timeAgo, ymd, nearlySame };
