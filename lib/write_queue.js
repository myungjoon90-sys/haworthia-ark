// 구글 시트가 쓰기를 거절할 때(파일 잠금 · 권한 · 일시 장애) 손님 신청을 서버에 먼저 보관하고,
// 시트가 다시 열리면 자동으로 시트에 기록합니다. — v33 (2026-11-21)
// 영어로 나오던 구글 오류 문구도 여기서 한국어로 바꿉니다.
const fs = require('fs');
const path = require('path');

function errCode(err) {
  if (!err) return 0;
  const c = err.code || err.status || (err.response && err.response.status) || 0;
  const n = parseInt(c, 10);
  return Number.isFinite(n) ? n : 0;
}

// 손님 잘못이 아니라 시트/구글 쪽 문제인지 (이때만 보관했다가 나중에 다시 씀)
function isSheetTrouble(err) {
  if (!err) return false;
  const code = errCode(err);
  const msg = String(err.message || '');
  if (code === 403 || code === 401 || code === 429 || code >= 500) return true;
  if (/does not have permission|PERMISSION_DENIED|forbidden|insufficient|Quota exceeded|rateLimit|backendError|unavailable/i.test(msg)) return true;
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timeout/i.test(msg)) return true;
  return false;
}

// 화면에 보일 오류 문구 (한국어). 우리가 만든 한국어 문구는 그대로 둡니다.
function korErr(err) {
  if (!err) return '';
  const msg = String(err.message || err || '');
  const code = errCode(err);
  if (/[가-힣]/.test(msg)) return msg;
  if (code === 403 || /does not have permission|PERMISSION_DENIED|forbidden/i.test(msg)) {
    return '구글 시트에 기록할 수 없는 상태입니다. (시트 파일이 잠겨 있거나 서버 계정의 편집 권한이 없습니다)';
  }
  if (code === 401) return '구글 시트 로그인 정보가 만료되었습니다. (서버 계정 키를 확인해 주세요)';
  if (code === 404 || /Requested entity was not found|not found/i.test(msg)) return '구글 시트를 찾을 수 없습니다. (시트 주소 또는 탭 이름을 확인해 주세요)';
  if (code === 429 || /Quota exceeded|rateLimit/i.test(msg)) return '구글 시트 요청이 잠시 많습니다. 1분 뒤 다시 시도해 주세요.';
  if (code >= 500 || /backendError|unavailable|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timeout/i.test(msg)) {
    return '구글 서버와 연결이 잠시 원활하지 않습니다. 잠시 후 다시 시도해 주세요.';
  }
  if (/LIMIT_FILE_SIZE|File too large/i.test(msg)) return '사진 용량이 너무 큽니다. 더 작은 사진으로 다시 올려 주세요.';
  return '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' + (msg ? ' (' + msg.slice(0, 120) + ')' : '');
}

function makeWriteQueue({ dataDir, file = 'sheet_pending.json' }) {
  const FILE = path.join(dataDir, file);
  const state = { lastError: '', lastTry: 0, lastOk: 0, running: false };

  function load() {
    try { const v = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function save(list) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
    fs.renameSync(tmp, FILE);
  }
  function put(kind, data, why) {
    const list = load();
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind, at: Date.now(), tries: 0, why: why || '', data };
    list.push(item);
    save(list);
    return item;
  }
  const list = () => load();

  // handlers: { royal: async (data) => {...}, join: async (data) => {...} }
  async function flush(handlers) {
    if (state.running) return { done: 0, left: load().length, busy: true };
    const start = load();
    if (!start.length) return { done: 0, left: 0 };
    state.running = true;
    state.lastTry = Date.now();
    const keep = [];
    let done = 0;
    try {
      for (let i = 0; i < start.length; i++) {
        const it = start[i];
        const h = handlers[it.kind];
        if (!h) { keep.push(it); continue; }
        try {
          await h(it.data);
          done++;
        } catch (e) {
          it.tries = (it.tries || 0) + 1;
          it.why = korErr(e);
          state.lastError = it.why;
          keep.push(it);
          // 시트가 아직 막혀 있으면 나머지는 다음 차례에 (같은 오류를 여러 번 내지 않음)
          if (isSheetTrouble(e)) { keep.push(...start.slice(i + 1)); break; }
        }
      }
    } finally {
      // 기록하는 사이 새로 들어온 신청은 그대로 남김
      const ids = new Set(start.map((x) => x.id));
      const added = load().filter((x) => !ids.has(x.id));
      save(keep.concat(added));
      if (done) { state.lastOk = Date.now(); if (!keep.length) state.lastError = ''; }
      state.running = false;
    }
    return { done, left: load().length };
  }

  return { put, list, flush, state, FILE };
}

module.exports = { makeWriteQueue, isSheetTrouble, korErr };
