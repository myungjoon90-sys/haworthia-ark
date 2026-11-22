// =============================================================
// lib/gallery_pending.js — 갤러리 사진: 구글 시트가 쓰기를 막아도 사진이 바로 보이게 (v29.1, 2026-11-16)
//  - 관리자 「🖼 갤러리 사진」에서 올렸는데 시트가 거절하면(예: 403 The caller does not have permission)
//    사진 주소를 서버 파일(/data/gallery_pending.json)에 먼저 적어 두고, 공개 갤러리·관리자 화면에 바로 보여 준다
//  - 30분마다(켜진 뒤 1분에 한 번 먼저) 시트에 다시 적어 본다 → 성공하면 서버 쪽 기록은 지운다
//  - 시트에 없는 새 품종도 같은 방식 (풀리면 줄 추가)
//  - 시트 D열에 사람이 직접 다른 주소를 적어도, 서버에 기다리는 사진이 있으면 그것이 먼저 보인다 (시트로 옮겨지면 끝)
// =============================================================
const fs = require('fs');
const path = require('path');

function makeGalleryPending({ sheets, dataDir }) {
  const FILE = path.join(dataDir, 'gallery_pending.json');
  let items = [];
  try { items = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!Array.isArray(items)) items = []; } catch (e) { items = []; }
  const save = () => { try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(items, null, 1)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.warn('[갤러리] 대기 목록 저장 실패:', e.message); } };
  const keyOf = (maker, name) => `${String(maker || '').trim()}|${String(name || '').trim()}`;
  const state = { lastTry: 0, lastError: '' };

  // 구글이 준 오류를 알아보기 쉽게 (로그에는 원문 그대로)
  function explain(err) {
    const g = (err && err.response && err.response.data && err.response.data.error) || {};
    const raw = { code: err && err.code, status: g.status, message: g.message || (err && err.message), details: g.details, errors: err && err.errors };
    console.error('[갤러리] 구글 시트 쓰기 거절:', JSON.stringify(raw));
    const msg = String(raw.message || '');
    if (/protected cell|protected/i.test(msg)) return '시트 「방주리스트」 탭이 보호(잠금)되어 있습니다';
    if (/quota|storage/i.test(msg)) return '구글 드라이브 저장공간이 가득 차서 시트를 고칠 수 없습니다';
    if (raw.code === 403 || raw.status === 'PERMISSION_DENIED') return '구글 시트가 쓰기를 거절했습니다';
    return /[가-힣]/.test(msg) ? msg : '구글 시트에 쓰지 못했습니다';
  }
  const isRowMismatch = (err) => /줄이 바뀌었습니다/.test(String(err && err.message));

  function put(p) {
    const k = keyOf(p.maker, p.name);
    const i = items.findIndex((x) => keyOf(x.maker, x.name) === k);
    const rec = { maker: String(p.maker || '').trim(), name: String(p.name || '').trim(), desc: p.desc || '', url: p.url || '', isNew: !!p.isNew, at: Date.now(), why: p.why || '' };
    if (i >= 0) { rec.isNew = items[i].isNew && rec.isNew; if (!rec.url) rec.url = items[i].url; if (!rec.desc) rec.desc = items[i].desc; items[i] = rec; } else items.push(rec);
    save();
    return rec;
  }
  function list() { return items.slice(); }

  // 공개 갤러리 (작출자별 묶음)에 대기 사진·새 품종 얹기
  function applyGroups(groups) {
    if (!items.length) return groups;
    const out = (groups || []).map((g) => ({ 작출자: g.작출자, 품종: (g.품종 || []).map((v) => Object.assign({}, v)) }));
    for (const it of items) {
      let g = out.find((x) => x.작출자 === it.maker);
      const v = g && g.품종.find((x) => x.품종명 === it.name);
      if (v) { if (it.url) v.사진URL = it.url; continue; }
      if (!it.isNew) continue;
      if (!g) { g = { 작출자: it.maker || '지양하월시아', 품종: [] }; out.push(g); }
      g.품종.push({ 품종명: it.name, 설명: it.desc || '', 사진URL: it.url || '', 영문명: '', 작출연도: '', 모본: '', 부본: '', 등급: '' });
    }
    return out;
  }
  // 관리자 줄 목록에 얹기 (⏳ 표시용 pending)
  function applyRows(rows) {
    const out = (rows || []).map((r) => Object.assign({}, r));
    for (const it of items) {
      const r = out.find((x) => x.작출자 === it.maker && x.품종명 === it.name);
      if (r) { if (it.url) r.사진URL = it.url; r.pending = true; continue; }
      if (it.isNew) out.push({ row: 0, 작출자: it.maker, 품종명: it.name, 설명: it.desc || '', 사진URL: it.url || '', pending: true });
    }
    return out;
  }

  // 시트로 옮기기 (성공한 것은 서버 기록에서 지움)
  async function flush(rawList, rawSet, rawAdd) {
    if (!items.length) return { moved: 0, left: 0 };
    state.lastTry = Date.now();
    let moved = 0;
    let rows;
    try { rows = await rawList(); } catch (e) { state.lastError = explain(e); return { moved: 0, left: items.length, error: state.lastError }; }
    for (const it of items.slice()) {
      try {
        const r = rows.find((x) => x.작출자 === it.maker && x.품종명 === it.name);
        if (r) { if (it.url) await rawSet(r.row, r.품종명, it.url); }
        else if (it.isNew) await rawAdd({ 작출자: it.maker, 품종명: it.name, 설명: it.desc, 사진URL: it.url });
        else continue; // 시트에서 그 품종이 지워졌으면 기다림 (관리자 화면에 남아 보임)
        items = items.filter((x) => x !== it); moved++;
      } catch (e) {
        if (/이미 방주리스트에/.test(String(e.message))) { items = items.filter((x) => x !== it); continue; }
        state.lastError = explain(e);
        break; // 하나가 막히면 나머지도 막혀 있을 것 — 다음 차례에
      }
    }
    save();
    if (moved) console.log('[갤러리] 서버에 기다리던 사진', moved, '개를 시트로 옮김');
    return { moved, left: items.length, error: items.length ? state.lastError : '' };
  }

  return { put, list, applyGroups, applyRows, flush, explain, isRowMismatch, state, FILE };
}

module.exports = { makeGalleryPending };
