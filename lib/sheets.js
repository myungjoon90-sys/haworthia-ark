// =============================================================
// lib/sheets.js — 구글 시트 읽기/쓰기
//  - GOOGLE_SERVICE_ACCOUNT_JSON 환경변수(서비스 계정 키 JSON 전체)로 인증
//  - 1행(제목줄)을 읽어 열 순서가 바뀌어도 동작하도록 처리
// =============================================================

const { google } = require('googleapis');

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Plants';

// 시트에서 사용하는 열 제목 목록 (README의 표와 동일)
const COLUMNS = [
  '고유번호', '품종명', '육종가', '육종연도', '모본', '부본',
  'DNA마커', '사진URL', '소유자', '소유이력', '발급일', '관리자메시지', '상태', '등급',
];

let _client = null;

// ---- 읽기 캐시 (45초) : 페이지를 오갈 때마다 시트 전체를 다시 읽지 않도록 ----
const _cache = new Map();
const CACHE_MS = 45 * 1000;
function cacheGet(key) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  return null;
}
function cacheSet(key, v) { _cache.set(key, { t: Date.now(), v }); }
function cacheClear() { _cache.clear(); }

// 서비스 계정 인증 (최초 1회만 생성해서 재사용)
async function getClient() {
  if (_client) return _client;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 환경변수가 비어 있습니다. (구글 서비스 계정 키 JSON을 넣어주세요)');
  if (!SHEET_ID) throw new Error('SHEET_ID 환경변수가 비어 있습니다. (구글 시트 주소의 ID 부분)');

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 값이 올바른 JSON이 아닙니다. JSON 파일 내용 전체를 그대로 붙여넣었는지 확인하세요.');
  }
  // Railway 환경변수에 붙여넣을 때 개행(\n)이 문자 그대로 들어간 경우 보정
  if (credentials.private_key && credentials.private_key.indexOf('\\n') !== -1) {
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
  });
  const authClient = await auth.getClient();
  _authClient = authClient;
  _client = google.sheets({ version: 'v4', auth: authClient });
  return _client;
}

// 드라이브 클라이언트 (일일 시트 사본 백업용)
let _authClient = null;
async function getDrive() {
  if (!_authClient) await getClient();
  return google.drive({ version: 'v3', auth: _authClient });
}

// 매일 1회: 구글 드라이브의 백업 폴더(BACKUP_FOLDER_ID)에 시트 전체 사본 생성, 최근 30개만 보관
async function runDriveBackup() {
  const folder = (process.env.BACKUP_FOLDER_ID || '').trim();
  if (!folder) return { skipped: '폴더 미설정' };
  const drive = await getDrive();
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST
  const name = `방주시트백업 ${today}`;
  const listRes = await drive.files.list({
    q: `'${folder}' in parents and name contains '방주시트백업' and trashed=false`,
    fields: 'files(id,name)',
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = (listRes.data.files || []);
  if (files.some((f) => f.name === name)) return { skipped: '오늘 백업 이미 있음' };
  await drive.files.copy({
    fileId: SHEET_ID,
    requestBody: { name, parents: [folder] },
    supportsAllDrives: true,
  });
  // 오래된 백업 정리 (이름의 날짜 역순으로 30개 초과분 삭제)
  const sorted = files.slice().sort((a, b) => b.name.localeCompare(a.name));
  for (const f of sorted.slice(29)) {
    try { await drive.files.delete({ fileId: f.id, supportsAllDrives: true }); } catch (e) {}
  }
  return { ok: true, name };
}

// 시트 전체(제목줄 포함)를 2차원 배열로 읽기
async function readAll() {
  const hit = cacheGet('ALL:' + SHEET_NAME);
  if (hit) return hit;
  const api = await getClient();
  const res = await api.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1:Z10000`,
  });
  const v = res.data.values || [];
  cacheSet('ALL:' + SHEET_NAME, v);
  return v;
}

// 제목줄 → { 열제목: 열인덱스 } 매핑
function headerMap(headerRow) {
  const map = {};
  (headerRow || []).forEach((h, i) => {
    const key = String(h || '').trim();
    if (key) map[key] = i;
  });
  return map;
}

// 모든 데이터 행을 객체 배열로 반환. 각 객체에 _rowNumber(시트상의 실제 행 번호) 포함
async function getAllRows() {
  const values = await readAll();
  if (values.length < 1) return [];
  const map = headerMap(values[0]);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i];
    if (!raw || raw.every((c) => String(c || '').trim() === '')) continue;
    const obj = { _rowNumber: i + 1 };
    COLUMNS.forEach((col) => {
      const idx = map[col];
      obj[col] = idx === undefined ? '' : String(raw[idx] === undefined ? '' : raw[idx]);
    });
    rows.push(obj);
  }
  return rows;
}

// 고유번호로 개체 1건 찾기 (공백/대소문자 차이 허용)
async function findById(id) {
  const target = String(id || '').trim().toUpperCase();
  if (!target) return null;
  const rows = await getAllRows();
  return rows.find((r) => String(r['고유번호'] || '').trim().toUpperCase() === target) || null;
}

// 새 행 추가 (제목줄의 실제 열 순서에 맞춰 배치)
async function appendRow(form) {
  const api = await getClient();
  const values = await readAll();
  const map = headerMap(values[0] || []);
  const width = Math.max(...Object.values(map).map((v) => v + 1), COLUMNS.length);
  const row = new Array(width).fill('');
  COLUMNS.forEach((col) => {
    const idx = map[col];
    if (idx !== undefined && form[col] !== undefined) row[idx] = form[col];
  });
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  cacheClear();
}

// 특정 행(rowNumber)의 일부 칸만 수정 (예: 소유자/발급일 자동 기록)
async function updateRow(rowNumber, updates) {
  const api = await getClient();
  const values = await readAll();
  const map = headerMap(values[0] || []);
  const data = [];
  Object.keys(updates).forEach((col) => {
    const idx = map[col];
    if (idx === undefined) return;
    const colLetter = columnLetter(idx + 1);
    data.push({
      range: `${SHEET_NAME}!${colLetter}${rowNumber}`,
      values: [[updates[col]]],
    });
  });
  if (data.length === 0) return;
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  cacheClear();
}

// 1 → A, 2 → B ... 27 → AA 열 문자 변환
function columnLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

module.exports = { getAllRows, findById, appendRow, updateRow };

// =============================================================
// 로얄넘버 정품 등록 (고객 제출) 관련 함수 — 원본 엑셀 그대로 방식
//  - 명준님이 쓰시던 엑셀을 구글 시트에 "그 모양 그대로" 올려두면,
//    서버가 모든 등급 탭을 뒤져서 셀 안 텍스트에 들어있는 JY 넘버를 찾아냅니다.
//  - 매칭된 행의 K~N 열(제출자명/제출자연락처/제출일/등록상태)에만 기록하고
//    기존 데이터(A~I열)는 절대 건드리지 않습니다.
//  - 검색 대상 탭: ROYAL_SHEET_NAMES 환경변수(쉼표로 구분)로 지정.
//    비워두면 Plants / 제출로그 / 등급요약 을 제외한 모든 탭을 자동 검색합니다.
// =============================================================

const LOG_SHEET = process.env.SUBMIT_LOG_SHEET_NAME || '제출로그';
const EXCLUDE_TABS = [SHEET_NAME, LOG_SHEET, '등급요약'];

// 제출자 정보가 기록되는 열 (K, L, M, N — 원본 데이터 오른쪽의 빈 공간)
const RECORD_COLS = { 제출자명: 'K', 제출자연락처: 'L', 제출일: 'M', 등록상태: 'N', 제출사진: 'O' };

// JY 넘버 인식 규칙: JY 또는 JYH로 시작하고 하이픈으로 이어지는 코드
// (한자·한글이 섞인 넘버도 인식: 예 JY-CPX-地特1153-20-0001, JYH-OO-M268母樹-B0002)
const NUM_RE = /JYH?-[A-Za-z0-9가-힣一-鿿*]+(?:-[A-Za-z0-9가-힣一-鿿*]+)+/g;

// 넘버 비교용 정규화: 공백/하이픈 등 제거 + 대문자
function normalizeNumber(s) {
  return String(s || '').replace(/[\s\-_.]/g, '').toUpperCase();
}

// 시트 파일 안의 모든 탭 이름 목록
async function listTabs() {
  const api = await getClient();
  const res = await api.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties.title' });
  return (res.data.sheets || []).map((s) => s.properties.title);
}

// 검색할 탭 목록 결정
async function royalTabs() {
  const custom = (process.env.ROYAL_SHEET_NAMES || '').trim();
  if (custom) return custom.split(',').map((s) => s.trim()).filter(Boolean);
  const all = await listTabs();
  return all.filter((t) => !EXCLUDE_TABS.includes(t));
}

// A1 표기용 탭 이름 (특수문자 대비 작은따옴표로 감싸기)
function quoteTab(name) {
  return "'" + String(name).replace(/'/g, "''") + "'";
}

// 특정 탭 전체 읽기
async function readSheet(sheetName) {
  const hit = cacheGet('TAB:' + sheetName);
  if (hit) return hit;
  const api = await getClient();
  const res = await api.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${quoteTab(sheetName)}!A1:P10000`,
  });
  const v = res.data.values || [];
  cacheSet('TAB:' + sheetName, v);
  return v;
}

// 모든 등급 탭에서 넘버로 행 찾기
// 반환: { _sheet: 탭이름, _rowNumber, 제출자명, 제출자연락처, 이름미리보기 } 또는 null
async function findRoyalByNumber(number) {
  const target = normalizeNumber(number);
  if (!target) return null;
  const tabs = await royalTabs();
  for (const tab of tabs) {
    let values;
    try {
      values = await readSheet(tab);
    } catch (e) {
      console.warn(`탭 '${tab}' 읽기 건너뜀: ${e.message}`);
      continue;
    }
    for (let i = 0; i < values.length; i++) {
      const row = values[i] || [];
      // 행 전체 텍스트에서 JY 넘버들을 뽑아 정규화 비교
      const text = row.slice(0, 10).join('\n');
      const found = text.match(NUM_RE);
      if (!found) continue;
      if (found.some((n) => normalizeNumber(n) === target)) {
        return {
          _sheet: tab,
          _rowNumber: i + 1,
          제출자명: String(row[10] || '').trim(),      // K열
          제출자연락처: String(row[11] || '').trim(),  // L열
          이름미리보기: String(row[3] || row[0] || '').split('\n')[0].slice(0, 40),
        };
      }
    }
  }
  return null;
}

// 매칭된 행의 K~N 열에 제출자 정보 기록 (기존 데이터는 건드리지 않음)
async function updateRoyalRow(sheetName, rowNumber, updates) {
  const api = await getClient();
  const data = [];
  Object.keys(updates).forEach((col) => {
    const letter = RECORD_COLS[col];
    if (!letter) return;
    data.push({
      range: `${quoteTab(sheetName)}!${letter}${rowNumber}`,
      values: [[updates[col]]],
    });
  });
  // 1행이 제목줄이면 K1~N1에 열 제목도 넣어줌 (한 번만, 이미 있으면 덮어써도 같은 값)
  data.push({ range: `${quoteTab(sheetName)}!K1:N1`, values: [['제출자명', '제출자연락처', '제출일', '등록상태']] });
  if (data.length === 0) return;
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  cacheClear();
}

// 제출로그 탭에 모든 제출 기록 (탭이 없으면 자동 생성)
async function appendSubmissionLog(entry) {
  const api = await getClient();
  const LOG_HEADERS = ['제출일시', '입력넘버', '성함', '연락처', '일치여부', '처리상태'];
  let values = [];
  try {
    values = await readSheet(LOG_SHEET);
  } catch (e) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: LOG_SHEET } } }] },
    });
  }
  if (values.length === 0) {
    await api.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${quoteTab(LOG_SHEET)}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [LOG_HEADERS] },
    });
  }
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${quoteTab(LOG_SHEET)}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[entry.제출일시, entry.입력넘버, entry.성함, entry.연락처, entry.일치여부, entry.처리상태]] },
  });
  cacheClear();
}

module.exports.findRoyalByNumber = findRoyalByNumber;
module.exports.updateRoyalRow = updateRoyalRow;
module.exports.appendSubmissionLog = appendSubmissionLog;
module.exports._testables = { normalizeNumber, NUM_RE, computeNextNumber };

// =============================================================
// v4 추가 기능: 등급 시트 자동 넘버 / 품종명 목록 / 등급 시트 기록 / 설정(백로그) 탭
// =============================================================

// 작업표시줄에 노출되는 4개 등급 시트 (시트 이름은 공백 차이가 있어도 자동으로 찾음)
const GRADE_TABS = {
  '녹박': '자구7~19녹박(초)',
  '적박': '20~적박(초)',
  '골드': '40~골드(적)',
  '로얄': '60~로얄(적)',
};

// 등급 키(녹박/적박/골드/로얄) → 실제 탭 이름 (앞뒤 공백 차이 허용)
async function resolveGradeTab(key) {
  const want = GRADE_TABS[key];
  if (!want) throw new Error('알 수 없는 등급입니다: ' + key);
  const tabs = await listTabs();
  const found = tabs.find((t) => t.trim() === want.trim());
  if (!found) throw new Error(`구글 시트에서 '${want}' 탭을 찾지 못했습니다. 탭 이름을 확인해 주세요.`);
  return found;
}

// 시트 맨 아래(최하단)의 실제 넘버를 찾아, 다음 넘버를 제안
//  - 마지막 구간 숫자 +1 (자릿수 유지), 연도 구간(2자리 숫자)은 올해로 자동 교체
async function suggestGradeNumber(key) {
  const tab = await resolveGradeTab(key);
  const values = await readSheet(tab);
  let last = null; let lastRow = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    const text = (values[i] || []).slice(0, 10).join('\n');
    const ms = text.match(NUM_RE);
    if (ms && ms.length) { last = ms[ms.length - 1]; lastRow = i + 1; break; }
  }
  if (!last) throw new Error(`'${tab}' 탭에서 기존 넘버를 찾지 못했습니다.`);
  return { suggest: computeNextNumber(last), last, lastRow, tab };
}

// 다음 넘버 계산: 마지막 구간 끝 숫자 +1 (자릿수 유지), 2자리 연도 구간은 올해로 교체
function computeNextNumber(last, yearOverride) {
  const yy = yearOverride || String(new Date().getFullYear()).slice(2); // 예: 2026 → 26
  const parts = last.split('-');
  const tailIdx = parts.length - 1;
  const m = parts[tailIdx].match(/(\d+)$/);
  if (!m) throw new Error('마지막 넘버의 형식을 해석하지 못했습니다: ' + last);
  const digits = m[1];
  parts[tailIdx] = parts[tailIdx].slice(0, m.index) + String(parseInt(digits, 10) + 1).padStart(digits.length, '0');
  for (let i = parts.length - 2; i >= 1; i--) {
    if (/^\d{2}$/.test(parts[i])) { parts[i] = yy; break; }
  }
  return parts.join('-');
}

// 품종명(한글) 자동완성 목록: 등급 탭 D열 첫 줄 + Plants 품종명
async function listVarieties(key) {
  const names = new Set();
  try {
    const tab = await resolveGradeTab(key);
    const values = await readSheet(tab);
    for (const row of values) {
      let first = String((row || [])[3] || '').split('\n')[0].trim().replace(/^["'“”]+|["'“”]+$/g, '');
      // 뒤에 숫자만 다른 연속 개체(예: 자호(紫虎) '2, 화이트드래곤13)는 기본 이름 하나로 합침
      first = first.replace(/[\s'′’\-]*\d+\s*$/, '').trim();
      if (first && first.length >= 2 && !/^JY|^http|^ex\)|^모체|^첫째줄|^B부분|이름-학명/i.test(first)) names.add(first.slice(0, 40));
    }
  } catch (e) { /* 목록 실패는 치명적이지 않음 */ }
  return Array.from(names).slice(0, 2000);
}

// 등급 시트 맨 아래에 새 개체 행 추가 (No + D열: 넘버 줄바꿈 품종명)
async function appendGradeRow(key, number, name) {
  const tab = await resolveGradeTab(key);
  const api = await getClient();
  const values = await readSheet(tab);
  let lastNo = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    const n = parseInt(String((values[i] || [])[0] || '').trim(), 10);
    if (!isNaN(n)) { lastNo = n; break; }
  }
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${quoteTab(tab)}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[lastNo ? lastNo + 1 : '', '', '', number + '\n' + (name || '')]] },
  });
  cacheClear();
  return tab;
}

// 설정(백로그) 탭: 수정·추가할 기능 목록
const SETTINGS_SHEET = process.env.SETTINGS_SHEET_NAME || '설정';
const SETTINGS_HEADERS = ['등록일', '항목', '상태'];

async function ensureSettingsSheet() {
  const api = await getClient();
  let values = [];
  try {
    values = await readSheet(SETTINGS_SHEET);
  } catch (e) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SETTINGS_SHEET } } }] },
    });
  }
  if (values.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    await api.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${quoteTab(SETTINGS_SHEET)}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [
        SETTINGS_HEADERS,
        [today, '등급(녹박/적박/골드/로얄)별로 보증서 최하단 무늬 다르게 적용', '대기'],
        [today, '보증서 디자인 시안(10종) 중 선택안 적용', '대기'],
        [today, '알림톡 전환 (카카오 채널 + 템플릿 승인 후)', '대기'],
      ] },
    });
  }
}

async function getSettings() {
  await ensureSettingsSheet();
  const values = await readSheet(SETTINGS_SHEET);
  return values.slice(1).filter((r) => (r || []).some((c) => String(c || '').trim()))
    .map((r) => ({ 등록일: r[0] || '', 항목: r[1] || '', 상태: r[2] || '대기' }));
}

async function addSetting(text) {
  await ensureSettingsSheet();
  const api = await getClient();
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${quoteTab(SETTINGS_SHEET)}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[new Date().toISOString().slice(0, 10), text, '대기']] },
  });
  cacheClear();
}

// 등급 시트 원본 보기(뷰어)용: 탭 데이터 그대로 반환
async function readGradeSheet(key) {
  const tab = await resolveGradeTab(key);
  const values = await readSheet(tab);
  return { tab, values };
}

module.exports.GRADE_TABS = GRADE_TABS;
module.exports.suggestGradeNumber = suggestGradeNumber;
module.exports.listVarieties = listVarieties;
module.exports.appendGradeRow = appendGradeRow;
module.exports.getSettings = getSettings;
module.exports.addSetting = addSetting;
module.exports.readGradeSheet = readGradeSheet;

// =============================================================
// v5 추가: 시트 미리보기 / 등록 이력 요약 / 소유권 이전
// =============================================================

// 등급 시트의 No + D열(넘버·품종명)만 간단히 (등록 화면 옆 미리보기용)
async function getSheetPreview(key) {
  const tab = await resolveGradeTab(key);
  const values = await readSheet(tab);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    const no = String(r[0] || '').trim();
    const d = String(r[3] || '').trim();
    const j = String(r[9] || '').trim();
    if (!no && !d) continue;
    rows.push({ row: i + 1, no, d: d || (j ? '(생성넘버) ' + j : ''), owner: String(r[10] || '').trim() });
  }
  return { tab, rows };
}

// 등록 이력 요약: 제출자 연락처 기준으로 4개 등급 시트의 제출 기록을 묶어서 반환
async function buildHistory() {
  const digits = (p) => String(p || '').replace(/[^0-9]/g, '');
  const groups = new Map(); // phone → { 이름들, 연락처, 항목들[], 등급별 개수 }
  for (const key of Object.keys(GRADE_TABS)) {
    let tab, values;
    try {
      tab = await resolveGradeTab(key);
      values = await readSheet(tab);
    } catch (e) { continue; }
    for (let i = 1; i < values.length; i++) {
      const r = values[i] || [];
      const phone = digits(r[11]);
      if (!phone) continue;
      const name = String(r[10] || '').trim();
      const dText = String(r[3] || '');
      const nums = dText.match(NUM_RE) || [];
      const genNum = String(r[9] || '').trim();
      const number = nums.length ? nums[nums.length - 1] : genNum;
      const variety = dText.split('\n')[0].trim().slice(0, 40);
      if (!groups.has(phone)) groups.set(phone, { 연락처: String(r[11] || '').trim(), 이름: name, 총개수: 0, 등급별: {}, 항목: [] });
      const g = groups.get(phone);
      if (name && !g.이름) g.이름 = name;
      g.총개수 += 1;
      g.등급별[key] = (g.등급별[key] || 0) + 1;
      g.항목.push({ 등급: key, 넘버: number, 품종명: variety, 제출일: String(r[12] || '').trim(), 상태: String(r[13] || '').trim() });
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.총개수 - a.총개수);
}

// 소유권 이전: 넘버의 기존 등록자를 새 등록자로 교체하고 '이전기록' 탭에 남김
const TRANSFER_SHEET = process.env.TRANSFER_SHEET_NAME || '이전기록';
const TRANSFER_HEADERS = ['일시', '넘버', '품종명', '이전소유자', '이전연락처', '새소유자', '새연락처'];

async function ensureTransferSheet() {
  const api = await getClient();
  let values = [];
  try { values = await readSheet(TRANSFER_SHEET); }
  catch (e) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TRANSFER_SHEET } } }] },
    });
  }
  if (values.length === 0) {
    await api.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${quoteTab(TRANSFER_SHEET)}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [TRANSFER_HEADERS] },
    });
    cacheClear();
  }
}

async function transferOwnership(number, newName, newPhone) {
  const row = await findRoyalByNumber(number);
  if (!row) throw new Error('넘버 "' + number + '" 를 등급 시트에서 찾지 못했습니다.');
  const oldName = row['제출자명'] || '';
  const oldPhone = row['제출자연락처'] || '';
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10) + ' ' + now.toTimeString().slice(0, 5);
  await ensureTransferSheet();
  const api = await getClient();
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${quoteTab(TRANSFER_SHEET)}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[stamp, number, row.이름미리보기 || '', oldName, oldPhone, newName, newPhone]] },
  });
  await updateRoyalRow(row._sheet, row._rowNumber, {
    제출자명: newName,
    제출자연락처: newPhone,
    제출일: stamp,
    등록상태: oldName ? '소유권 이전 완료' : '제출완료(확인대기)',
  });
  cacheClear();
  return { sheet: row._sheet, rowNumber: row._rowNumber, oldName, oldPhone };
}

async function getTransfers() {
  try {
    const values = await readSheet(TRANSFER_SHEET);
    return values.slice(1).filter((r) => (r || []).some((c) => String(c || '').trim()))
      .map((r) => ({ 일시: r[0] || '', 넘버: r[1] || '', 품종명: r[2] || '', 이전소유자: r[3] || '', 이전연락처: r[4] || '', 새소유자: r[5] || '', 새연락처: r[6] || '' }))
      .reverse();
  } catch (e) { return []; }
}

module.exports.getSheetPreview = getSheetPreview;
module.exports.buildHistory = buildHistory;
module.exports.transferOwnership = transferOwnership;
module.exports.getTransfers = getTransfers;

// =============================================================
// v6 추가: 방주 멤버십 가입 신청 ('가입신청' 탭)
// =============================================================

const JOIN_SHEET = process.env.JOIN_SHEET_NAME || '가입신청';
const JOIN_HEADERS = ['일시', '성함', '연락처', '충족요건', '서명이미지', '동의', '상태', '제출넘버', '자동확인', '닉네임', '환영문자', '계약안내', '계약서명', '판매지원'];

async function ensureJoinSheet() {
  const api = await getClient();
  let values = [];
  try { values = await readSheet(JOIN_SHEET); }
  catch (e) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: JOIN_SHEET } } }] },
    });
  }
  if (values.length === 0) {
    await api.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${quoteTab(JOIN_SHEET)}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [JOIN_HEADERS] },
    });
    cacheClear();
  } else if ((values[0] || []).length < JOIN_HEADERS.length) {
    // 기존 시트 → 누락된 헤더(제출넘버/자동확인/닉네임/환영문자)만 채움 (데이터 보존)
    await api.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${quoteTab(JOIN_SHEET)}!A1:N1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [JOIN_HEADERS] },
    });
    cacheClear();
  }
}

async function appendJoinApplication(entry) {
  await ensureJoinSheet();
  const api = await getClient();
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${quoteTab(JOIN_SHEET)}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[entry.일시, entry.성함, entry.연락처, entry.충족요건, entry.서명이미지, entry.동의, entry.상태 || '심사 대기', entry.제출넘버 || '', entry.자동확인 || '', entry.닉네임 || '']] },
  });
  cacheClear();
}

module.exports.appendJoinApplication = appendJoinApplication;

// 공개 회원 명부: 상태 '승인' 회원만, 가입일 오름차순(먼저 들어온 순) + 반기 기수
async function getPublicMembers() {
  try {
    await ensureJoinSheet();
    const values = await readSheet(JOIN_SHEET);
    const rows = values.slice(1)
      .filter((r) => String((r || [])[6] || '').includes('가입완료'))
      .map((r) => {
        const 일시 = String(r[0] || '').trim();
        const m = 일시.match(/^(\d{4})-(\d{2})/);
        const year = m ? m[1] : '';
        const half = m ? (parseInt(m[2], 10) <= 6 ? '상반기' : '하반기') : '';
        return {
          닉네임: String(r[9] || '').trim() || '비공개 회원',
          일시,
          연도: year,
          기수: year ? `${year} ${half}` : '기수 미상',
        };
      })
      .sort((a, b) => a.일시.localeCompare(b.일시));
    return rows;
  } catch (e) { return []; }
}
module.exports.getPublicMembers = getPublicMembers;

// 방주 정원: '설정' 탭의 '총원=50' / '기수정원=10' 행에서 읽음 (없으면 자동 생성)
function currentCohortKST() {
  const now = new Date(Date.now() + 9 * 3600 * 1000); // KST
  const y = now.getUTCFullYear();
  const half = now.getUTCMonth() + 1 <= 6 ? '상반기' : '하반기';
  return { year: String(y), half, label: `${y} ${half}` };
}

async function getMemberCaps() {
  let totalCap = parseInt(process.env.MEMBER_TOTAL_CAP || '', 10) || 0;
  let cohortCap = parseInt(process.env.MEMBER_COHORT_CAP || '', 10) || 0;
  try {
    const rows = await getSettings();
    const missing = [];
    let foundT = false, foundC = false;
    rows.forEach((r) => {
      let m = String(r.항목 || '').match(/^총원\s*=\s*(\d+)/);
      if (m) { totalCap = parseInt(m[1], 10); foundT = true; }
      m = String(r.항목 || '').match(/^기수정원\s*=\s*(\d+)/);
      if (m) { cohortCap = parseInt(m[1], 10); foundC = true; }
    });
    if (!foundT) missing.push('총원=50');
    if (!foundC) missing.push('기수정원=10');
    if (missing.length) {
      const api = await getClient();
      const today = new Date().toISOString().slice(0, 10);
      await api.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${quoteTab(SETTINGS_SHEET)}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: missing.map((t) => [today, t, '정원 설정 — 숫자만 바꾸면 적용']) },
      });
      cacheClear();
    }
  } catch (e) {}
  return { totalCap: totalCap || 50, cohortCap: cohortCap || 10 };
}

// 가입 가능 여부: 총원·이번 기수 정원을 보고 대기 명단 전환 판단
async function getMembershipStatus() {
  const caps = await getMemberCaps();
  const cohort = currentCohortKST();
  let total = 0, inCohort = 0;
  try {
    const values = await readSheet(JOIN_SHEET);
    for (let i = 1; i < values.length; i++) {
      const r = values[i] || [];
      const st = String(r[6] || '');
      if (!(st.includes('승인') || st.includes('가입완료'))) continue;
      total += 1;
      const m = String(r[0] || '').match(/^(\d{4})-(\d{2})/);
      if (m && `${m[1]} ${parseInt(m[2], 10) <= 6 ? '상반기' : '하반기'}` === cohort.label) inCohort += 1;
    }
  } catch (e) {}
  const full = total >= caps.totalCap;
  const cohortFull = inCohort >= caps.cohortCap;
  return {
    totalCap: caps.totalCap,
    cohortCap: caps.cohortCap,
    total,
    inCohort,
    cohortLabel: cohort.label,
    seatsLeft: Math.max(0, Math.min(caps.totalCap - total, caps.cohortCap - inCohort)),
    waitlist: full || cohortFull,
    full,
  };
}
module.exports.getMemberCaps = getMemberCaps;
module.exports.getMembershipStatus = getMembershipStatus;

// 환영 문자 자동 발송 대상: 상태 '승인' + 환영문자(K열) 비어 있는 회원
async function getPendingWelcomes() {
  await ensureJoinSheet();
  const values = await readSheet(JOIN_SHEET);
  const out = [];
  let seq = 0; // getJoinApplicants 와 같은 방식의 회원번호 순번
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    if (!r.some((c) => String(c || '').trim())) continue;
    seq += 1;
    const 상태 = String(r[6] || '');
    const 환영 = String(r[10] || '').trim();
    const 연락처 = String(r[2] || '').trim();
    if (상태.includes('가입완료') && !환영 && 연락처) {
      out.push({
        sheetRow: i + 1,
        회원번호: 'ARK-' + String(seq).padStart(3, '0'),
        성함: String(r[1] || '').trim(),
        연락처,
        닉네임: String(r[9] || '').trim(),
        일시: String(r[0] || '').trim(),
      });
    }
  }
  return out;
}

// K열(환영문자)에 발송 기록 남기기
async function markWelcomeSent(sheetRow, note) {
  const api = await getClient();
  await api.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${quoteTab(JOIN_SHEET)}!K${sheetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[note]] },
  });
  cacheClear();
}
module.exports.getPendingWelcomes = getPendingWelcomes;
module.exports.markWelcomeSent = markWelcomeSent;

// 계약(협의서) 안내 대상: 상태 '승인' + 계약안내(L열) 비어 있음
async function getPendingContracts() {
  await ensureJoinSheet();
  const values = await readSheet(JOIN_SHEET);
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    if (!r.some((c) => String(c || '').trim())) continue;
    const 상태 = String(r[6] || '');
    if (!상태.includes('승인') || 상태.includes('가입완료')) continue;
    if (String(r[11] || '').trim()) continue; // 이미 안내함
    const 연락처 = String(r[2] || '').trim();
    if (!연락처) continue;
    out.push({ sheetRow: i + 1, 성함: String(r[1] || '').trim(), 연락처 });
  }
  return out;
}

async function markContractRequested(sheetRow, note) {
  const api = await getClient();
  await api.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${quoteTab(JOIN_SHEET)}!L${sheetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[note]] },
  });
  cacheClear();
}

// 계약 서명 대기 행 찾기 (상태 '승인' + 계약서명(M열) 비어 있음)
async function findContractPending(phone) {
  const want = String(phone || '').replace(/[^0-9]/g, '');
  if (!want) return null;
  const values = await readSheet(JOIN_SHEET);
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    const 상태 = String(r[6] || '');
    const p = String(r[2] || '').replace(/[^0-9]/g, '');
    if (p !== want) continue;
    if (상태.includes('가입완료') || String(r[12] || '').trim()) return { already: true, 성함: String(r[1] || '').trim() };
    if (상태.includes('승인')) return { sheetRow: i + 1, 성함: String(r[1] || '').trim(), 연락처: String(r[2] || '').trim() };
  }
  return null;
}

// 계약 서명 완료 처리: 서명이미지(E) + 상태(G)='가입완료' + 계약서명(M) 기록
async function markContractSigned(sheetRow, sigUrl, when, resale) {
  const api = await getClient();
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `${quoteTab(JOIN_SHEET)}!E${sheetRow}`, values: [[sigUrl]] },
        { range: `${quoteTab(JOIN_SHEET)}!G${sheetRow}`, values: [['가입완료']] },
        { range: `${quoteTab(JOIN_SHEET)}!M${sheetRow}`, values: [[when]] },
        { range: `${quoteTab(JOIN_SHEET)}!N${sheetRow}`, values: [[resale || '']] },
      ],
    },
  });
  cacheClear();
}
// =============================================================
// v23: 소유 현황('소유현황' 탭) + 등재 투표('등재투표'/'투표기록' 탭)
// =============================================================
const OWN_SHEET = process.env.OWN_SHEET_NAME || '소유현황';
const OWN_HEADERS = ['품종명', '구분', '회원명', '순번', '메모', '실거래가', '거래일'];

async function ensureOwnSheet() {
  const api = await getClient();
  let values = [];
  try { values = await readSheet(OWN_SHEET); }
  catch (e) {
    await api.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: OWN_SHEET } } }] } });
  }
  if (values.length === 0) {
    await api.spreadsheets.values.append({ spreadsheetId: SHEET_ID,
      range: `${quoteTab(OWN_SHEET)}!A1`, valueInputOption: 'USER_ENTERED',
      requestBody: { values: [OWN_HEADERS,
        ['미카엘의 심장', '보유', '지양하월시아', '', '원본', '', ''],
        ['미카엘의 심장', '대기', '(예시) 하월붕붕', '1', '', '', ''],
      ] } });
    cacheClear();
  } else if ((values[0] || []).length < OWN_HEADERS.length) {
    await api.spreadsheets.values.update({ spreadsheetId: SHEET_ID,
      range: `${quoteTab(OWN_SHEET)}!A1:G1`, valueInputOption: 'USER_ENTERED',
      requestBody: { values: [OWN_HEADERS] } });
    cacheClear();
  }
}

// 품종명 → { 보유:[이름], 대기:[{순번,이름}] }
async function getOwnershipMap() {
  await ensureOwnSheet();
  const values = await readSheet(OWN_SHEET);
  const map = {};
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    const name = String(r[0] || '').trim();
    if (!name) continue;
    if (!map[name]) map[name] = { 보유: [], 대기: [] };
    const who = String(r[2] || '').trim();
    if (!who) continue;
    if (String(r[1] || '').includes('대기')) map[name].대기.push({ 순번: parseInt(r[3], 10) || 999, 이름: who });
    else map[name].보유.push({ 이름: who, 가격: String(r[5] || '').trim(), 일자: String(r[6] || '').trim() });
  }
  Object.values(map).forEach((v) => v.대기.sort((a, b) => a.순번 - b.순번));
  return map;
}

const VOTE_SHEET = process.env.VOTE_SHEET_NAME || '등재투표';
const VOTE_HEADERS = ['번호', '제안일', '제안자', '품종명', '설명', '사진URL', '상태', '결과메모'];
const VOTELOG_SHEET = process.env.VOTELOG_SHEET_NAME || '투표기록';
const VOTELOG_HEADERS = ['투표번호', '회원번호', '선택', '일시'];

async function ensureVoteSheets() {
  const api = await getClient();
  for (const [tab, headers] of [[VOTE_SHEET, VOTE_HEADERS], [VOTELOG_SHEET, VOTELOG_HEADERS]]) {
    let values = [];
    try { values = await readSheet(tab); }
    catch (e) {
      await api.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] } });
    }
    if (values.length === 0) {
      await api.spreadsheets.values.append({ spreadsheetId: SHEET_ID,
        range: `${quoteTab(tab)}!A1`, valueInputOption: 'USER_ENTERED',
        requestBody: { values: [headers] } });
      cacheClear();
    }
  }
}

// 전체 가입완료 회원 수
async function countMembers() {
  const values = await readSheet(JOIN_SHEET).catch(() => []);
  let n = 0;
  for (let i = 1; i < values.length; i++) {
    if (String(((values[i] || [])[6]) || '').includes('가입완료')) n += 1;
  }
  return n;
}

// 투표 목록 (+득표 집계, 내 투표 여부)
async function listProposals(myNo) {
  await ensureVoteSheets();
  const rows = await readSheet(VOTE_SHEET);
  const logs = await readSheet(VOTELOG_SHEET);
  const total = await countMembers();
  const need = Math.max(1, Math.ceil(total * 0.7));
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const no = String(r[0] || '').trim();
    if (!no) continue;
    const voters = new Map(); // 회원번호 → 선택 (첫 표만 인정)
    for (let j = 1; j < logs.length; j++) {
      const l = logs[j] || [];
      if (String(l[0] || '').trim() !== no) continue;
      const who = String(l[1] || '').trim();
      if (who && !voters.has(who)) voters.set(who, String(l[2] || ''));
    }
    let yes = 0, noCnt = 0;
    voters.forEach((c) => { if (c.includes('찬성')) yes += 1; else noCnt += 1; });
    out.push({
      sheetRow: i + 1, 번호: no, 제안일: String(r[1] || ''), 제안자: String(r[2] || ''),
      품종명: String(r[3] || ''), 설명: String(r[4] || ''), 사진URL: String(r[5] || ''),
      상태: String(r[6] || '진행중'), 찬성: yes, 반대: noCnt, 필요: need, 전체회원: total,
      내선택: myNo ? (voters.get(myNo) || '') : '',
    });
  }
  return out.reverse(); // 최신 먼저
}

async function addProposal({ 제안자, 품종명, 설명, 사진URL }) {
  await ensureVoteSheets();
  const rows = await readSheet(VOTE_SHEET);
  let max = 0;
  for (let i = 1; i < rows.length; i++) { const n = parseInt((rows[i] || [])[0], 10); if (n > max) max = n; }
  const api = await getClient();
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  await api.spreadsheets.values.append({ spreadsheetId: SHEET_ID,
    range: `${quoteTab(VOTE_SHEET)}!A1`, valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[max + 1, today, 제안자, 품종명, 설명, 사진URL, '진행중', '']] } });
  cacheClear();
  return max + 1;
}

// 투표: 1인 1표, 전체 가입완료 회원의 70% 찬성 시 가결 → 방주리스트 자동 등재
async function castVote(no, memberNo, choice) {
  await ensureVoteSheets();
  const props = await listProposals(memberNo);
  const p = props.find((x) => x.번호 === String(no));
  if (!p) throw new Error('해당 투표를 찾을 수 없습니다.');
  if (!p.상태.includes('진행')) throw new Error('이미 마감된 투표입니다.');
  if (p.내선택) throw new Error('이미 투표하셨습니다. (1인 1표)');
  const api = await getClient();
  const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  await api.spreadsheets.values.append({ spreadsheetId: SHEET_ID,
    range: `${quoteTab(VOTELOG_SHEET)}!A1`, valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[p.번호, memberNo, choice, now]] } });
  cacheClear();
  const yes = p.찬성 + (choice.includes('찬성') ? 1 : 0);
  if (yes >= p.필요) {
    await api.spreadsheets.values.batchUpdate({ spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: [
        { range: `${quoteTab(VOTE_SHEET)}!G${p.sheetRow}`, values: [['가결']] },
        { range: `${quoteTab(VOTE_SHEET)}!H${p.sheetRow}`, values: [[`찬성 ${yes}/${p.전체회원} (${now})`]] },
      ] } });
    // 방주리스트에 자동 등재 (작출자 = 제안자)
    await api.spreadsheets.values.append({ spreadsheetId: SHEET_ID,
      range: `${quoteTab(ARKLIST_SHEET)}!A1`, valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[p.제안자, p.품종명, p.설명, p.사진URL, '', '', '', '', '회원등재']] } });
    cacheClear();
    return { passed: true, yes, need: p.필요 };
  }
  return { passed: false, yes, need: p.필요 };
}

const COMM_SHEET = process.env.COMM_SHEET_NAME || '커뮤니티';
const COMM_HEADERS = ['번호', '일시', '작성자', '회원번호', '제목', '내용', '사진URL'];
const CMT_SHEET = process.env.CMT_SHEET_NAME || '댓글';
const CMT_HEADERS = ['글번호', '일시', '작성자', '회원번호', '내용'];

async function ensureCommunitySheets() {
  const api = await getClient();
  for (const [tab, headers] of [[COMM_SHEET, COMM_HEADERS], [CMT_SHEET, CMT_HEADERS]]) {
    let values = [];
    try { values = await readSheet(tab); }
    catch (e) {
      await api.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] } });
    }
    if (values.length === 0) {
      await api.spreadsheets.values.append({ spreadsheetId: SHEET_ID,
        range: `${quoteTab(tab)}!A1`, valueInputOption: 'USER_ENTERED',
        requestBody: { values: [headers] } });
      cacheClear();
    }
  }
}

function nowKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

async function listPosts() {
  await ensureCommunitySheets();
  const rows = await readSheet(COMM_SHEET);
  const cmts = await readSheet(CMT_SHEET);
  const counts = {};
  for (let j = 1; j < cmts.length; j++) {
    const no = String((cmts[j] || [])[0] || '').trim();
    if (no) counts[no] = (counts[no] || 0) + 1;
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const no = String(r[0] || '').trim();
    if (!no) continue;
    out.push({ 번호: no, 일시: String(r[1] || ''), 작성자: String(r[2] || ''),
      제목: String(r[4] || ''), 내용: String(r[5] || ''), 사진URL: String(r[6] || ''),
      댓글수: counts[no] || 0 });
  }
  return out.reverse().slice(0, 100);
}

async function getPost(no) {
  await ensureCommunitySheets();
  const rows = await readSheet(COMM_SHEET);
  let post = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (String(r[0] || '').trim() === String(no)) {
      post = { 번호: String(r[0]), 일시: String(r[1] || ''), 작성자: String(r[2] || ''),
        제목: String(r[4] || ''), 내용: String(r[5] || ''), 사진URL: String(r[6] || '') };
      break;
    }
  }
  if (!post) return null;
  const cmts = await readSheet(CMT_SHEET);
  post.댓글 = [];
  for (let j = 1; j < cmts.length; j++) {
    const c = cmts[j] || [];
    if (String(c[0] || '').trim() !== String(no)) continue;
    post.댓글.push({ 일시: String(c[1] || ''), 작성자: String(c[2] || ''), 내용: String(c[4] || '') });
  }
  return post;
}

async function addPost({ 작성자, 회원번호, 제목, 내용, 사진URL }) {
  await ensureCommunitySheets();
  const rows = await readSheet(COMM_SHEET);
  let max = 0;
  for (let i = 1; i < rows.length; i++) { const n = parseInt((rows[i] || [])[0], 10); if (n > max) max = n; }
  const api = await getClient();
  await api.spreadsheets.values.append({ spreadsheetId: SHEET_ID,
    range: `${quoteTab(COMM_SHEET)}!A1`, valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[max + 1, nowKST(), 작성자, 회원번호, 제목, 내용, 사진URL || '']] } });
  cacheClear();
  return max + 1;
}

async function addComment({ 글번호, 작성자, 회원번호, 내용 }) {
  await ensureCommunitySheets();
  const api = await getClient();
  await api.spreadsheets.values.append({ spreadsheetId: SHEET_ID,
    range: `${quoteTab(CMT_SHEET)}!A1`, valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[글번호, nowKST(), 작성자, 회원번호, 내용]] } });
  cacheClear();
}

module.exports.listPosts = listPosts;
module.exports.getPost = getPost;
module.exports.addPost = addPost;
module.exports.addComment = addComment;
module.exports.getOwnershipMap = getOwnershipMap;
module.exports.listProposals = listProposals;
module.exports.addProposal = addProposal;
module.exports.castVote = castVote;
module.exports.countMembers = countMembers;

module.exports.getPendingContracts = getPendingContracts;
module.exports.markContractRequested = markContractRequested;
module.exports.findContractPending = findContractPending;
module.exports.markContractSigned = markContractSigned;

// 회원 명부 입장 암호: '설정' 탭의 '명부암호=...' 행 (없으면 자동 생성)
async function getGateCode() {
  let code = '';
  try {
    const rows = await getSettings();
    rows.forEach((r) => {
      const m = String(r.항목 || '').match(/^명부암호\s*=\s*(.+)$/);
      if (m) code = m[1].trim();
    });
    if (!code) {
      code = '방주5050';
      const api = await getClient();
      await api.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${quoteTab(SETTINGS_SHEET)}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[new Date().toISOString().slice(0, 10), '명부암호=방주5050', '명부 입장 암호 — 글자만 바꾸면 적용']] },
      });
      cacheClear();
    }
  } catch (e) {}
  return code || '방주5050';
}
module.exports.getGateCode = getGateCode;

// 승인된 회원인지 휴대폰 번호로 확인 → { 성함, 회원번호 } 또는 null
async function findApprovedByPhone(phone) {
  const want = String(phone || '').replace(/[^0-9]/g, '');
  if (!want) return null;
  try {
    const values = await readSheet(JOIN_SHEET);
    let seq = 0;
    for (let i = 1; i < values.length; i++) {
      const r = values[i] || [];
      if (!r.some((c) => String(c || '').trim())) continue;
      seq += 1;
      if (!String(r[6] || '').includes('가입완료')) continue;
      const p = String(r[2] || '').replace(/[^0-9]/g, '');
      if (p && p === want) {
        return { 성함: String(r[1] || '').trim(), 회원번호: 'ARK-' + String(seq).padStart(3, '0'), 닉네임: String(r[9] || '').trim() };
      }
    }
  } catch (e) {}
  return null;
}
module.exports.findApprovedByPhone = findApprovedByPhone;


// =============================================================
// v8 추가: 공개 방주 리스트 ('방주리스트' 탭 — 작출자별 등재 품종)
//  - 다른 작출자(관리자)의 명단도 줄만 추가하면 함께 표시됩니다.
// =============================================================

const ARKLIST_SHEET = process.env.ARKLIST_SHEET_NAME || '방주리스트';
// C열(설명)이 갤러리의 '스토리'로 표시됩니다. E~I열은 v15 갤러리 확장 열.
const ARKLIST_HEADERS = ['작출자', '품종명', '설명', '사진URL', '영문명', '작출연도', '모본', '부본', '등급'];

async function ensureArkListSheet() {
  const api = await getClient();
  let values = [];
  try { values = await readSheet(ARKLIST_SHEET); }
  catch (e) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: ARKLIST_SHEET } } }] },
    });
  }
  if (values.length === 0) {
    await api.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${quoteTab(ARKLIST_SHEET)}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [
        ARKLIST_HEADERS,
        ['지양하월시아', '미카엘의 심장', '', '', '', '', '', '', ''],
        ['지양하월시아', '에뚜왈블루', '', '', '', '', '', '', ''],
        ['지양하월시아', '춘하추동 춘', '', '', '', '', '', '', ''],
      ] },
    });
    cacheClear();
  } else if ((values[0] || []).length < ARKLIST_HEADERS.length) {
    // 기존 4열 시트 → 확장 헤더(E~I)만 채워 넣음 (데이터는 그대로 보존)
    await api.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${quoteTab(ARKLIST_SHEET)}!A1:I1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [ARKLIST_HEADERS] },
    });
    cacheClear();
  }
}

// 작출자별로 묶은 방주 리스트 반환
async function getArkList() {
  await ensureArkListSheet();
  const values = await readSheet(ARKLIST_SHEET);
  const groups = new Map();
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    const maker = String(r[0] || '').trim();
    const name = String(r[1] || '').trim();
    if (!maker || !name) continue;
    if (!groups.has(maker)) groups.set(maker, []);
    groups.get(maker).push({
      품종명: name,
      설명: String(r[2] || '').trim(),
      사진URL: String(r[3] || '').trim(),
      영문명: String(r[4] || '').trim(),
      작출연도: String(r[5] || '').trim(),
      모본: String(r[6] || '').trim(),
      부본: String(r[7] || '').trim(),
      등급: String(r[8] || '').trim(),
    });
  }
  return Array.from(groups.entries()).map(([작출자, 품종]) => ({ 작출자, 품종 }));
}

module.exports.getArkList = getArkList;

// =============================================================
// v9 추가: 정품 조회 / 대시보드 통계 / 회원 명단 / 백업 덤프
// =============================================================

// 공개 정품 조회: 넘버 하나의 상태만 반환 (개인정보 없음)
async function verifyNumber(number) {
  const target = normalizeNumber(number);
  if (!target) return { status: 'empty' };
  // ① Plants(발급 대장)에서 인증 여부
  try {
    const plant = await findById(number);
    if (plant) {
      const st = String(plant['상태'] || '').trim();
      return {
        status: /정품/.test(st) ? 'certified' : 'pending',
        번호: plant['고유번호'], 품종명: plant['품종명'] || '', 등급: plant['등급'] || '',
      };
    }
  } catch (e) {}
  // ② 등급 시트에서 등록(제출) 여부
  const row = await findRoyalByNumber(number);
  if (row) {
    const st = String(row['제출자명'] || '').trim() ? 'pending' : 'unregistered';
    return { status: st, 번호: number, 품종명: row.이름미리보기 || '', 등급: '' };
  }
  return { status: 'unknown', 번호: number };
}

// 관리자 대시보드 통계
async function getDashboardStats() {
  const stats = { 등급별등록: {}, 총등록: 0, 최근7일제출: 0, 확인대기: 0, 가입심사대기: 0, 이전기록수: 0 };
  for (const key of Object.keys(GRADE_TABS)) {
    try {
      const tab = await resolveGradeTab(key);
      const values = await readSheet(tab);
      let n = 0;
      for (let i = 1; i < values.length; i++) {
        if (String((values[i] || [])[10] || '').trim()) n++;
      }
      stats.등급별등록[key] = n;
      stats.총등록 += n;
    } catch (e) { stats.등급별등록[key] = 0; }
  }
  try {
    const log = await readSheet(process.env.SUBMIT_LOG_SHEET_NAME || '제출로그');
    const week = Date.now() - 7 * 24 * 3600 * 1000;
    for (let i = 1; i < log.length; i++) {
      const r = log[i] || [];
      const t = new Date(String(r[0] || '').replace(' ', 'T'));
      if (!isNaN(t) && t.getTime() > week) stats.최근7일제출++;
      if (String(r[5] || '').includes('관리자 확인')) stats.확인대기++;
    }
  } catch (e) {}
  try {
    const join = await readSheet(process.env.JOIN_SHEET_NAME || '가입신청');
    for (let i = 1; i < join.length; i++) {
      if (String((join[i] || [])[6] || '').includes('대기')) stats.가입심사대기++;
    }
  } catch (e) {}
  try {
    const tr = await readSheet(process.env.TRANSFER_SHEET_NAME || '이전기록');
    stats.이전기록수 = Math.max(0, tr.length - 1);
  } catch (e) {}
  return stats;
}

// 가입신청 명단 (회원 카드 발급용)
async function getJoinApplicants() {
  try {
    const values = await readSheet(process.env.JOIN_SHEET_NAME || '가입신청');
    return values.slice(1).filter((r) => (r || []).some((c) => String(c || '').trim()))
      .map((r, i) => ({
        회원번호: 'ARK-' + String(i + 1).padStart(3, '0'),
        일시: String(r[0] || ''), 성함: String(r[1] || ''), 연락처: String(r[2] || ''),
        충족요건: String(r[3] || ''), 상태: String(r[6] || ''),
      }));
  } catch (e) { return []; }
}

// 백업: 모든 탭 데이터를 JSON으로 반환 (서버가 /data/backups 에 저장)
async function dumpAllTabs() {
  const tabs = await listTabs();
  const out = {};
  for (const t of tabs) {
    try { out[t] = await readSheet(t); } catch (e) { out[t] = ['(읽기 실패: ' + e.message + ')']; }
  }
  return out;
}

module.exports.verifyNumber = verifyNumber;
module.exports.getDashboardStats = getDashboardStats;
module.exports.getJoinApplicants = getJoinApplicants;
module.exports.dumpAllTabs = dumpAllTabs;

// =============================================================
// v10 추가: 회원 전용 특별분양 (전량 완판 조건부)
//  - '특별분양' 탭: 분양ID | 품종명 | 설명 | 사진URL | 가격 | 수량 | 마감일 | 상태
//  - '분양예약' 탭: 일시 | 분양ID | 성함 | 연락처 | 회원번호 | 서약 | 메모
//  - 규칙: 회원당 1구, 선착순으로 정원이 차면 마감, 마감일까지 미달이면 불발
// =============================================================

const OFFER_SHEET = process.env.OFFER_SHEET_NAME || '특별분양';
const RESERVE_SHEET = process.env.RESERVE_SHEET_NAME || '분양예약';

async function ensureOfferSheets() {
  const api = await getClient();
  let ov = [];
  try { ov = await readSheet(OFFER_SHEET); }
  catch (e) {
    await api.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: OFFER_SHEET } } }] } });
  }
  if (ov.length === 0) {
    await api.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${quoteTab(OFFER_SHEET)}!A1`, valueInputOption: 'USER_ENTERED',
      requestBody: { values: [
        ['분양ID', '품종명', '설명', '사진URL', '가격', '수량', '마감일', '상태'],
        ['OFFER-001', '(예시) 미카엘의 심장 자구', '지양 최후의 카드 라인 · 예시 행입니다. 상태를 비우면 노출되지 않습니다.', '', '3000000', '10', '2026-12-31', ''],
      ] },
    });
    cacheClear();
  }
  let rv = [];
  try { rv = await readSheet(RESERVE_SHEET); }
  catch (e) {
    await api.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: RESERVE_SHEET } } }] } });
  }
  if (rv.length === 0) {
    await api.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${quoteTab(RESERVE_SHEET)}!A1`, valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['일시', '분양ID', '성함', '연락처', '회원번호', '서약', '메모']] },
    });
    cacheClear();
  }
}

// 진행 중 분양 목록 + 예약 현황 (상태가 '모집중'인 것만 노출)
async function getOffers() {
  await ensureOfferSheets();
  const ov = await readSheet(OFFER_SHEET);
  const rv = await readSheet(RESERVE_SHEET);
  const counts = {}; // 분양ID → 예약자 수
  for (let i = 1; i < rv.length; i++) {
    const id = String((rv[i] || [])[1] || '').trim();
    if (id) counts[id] = (counts[id] || 0) + 1;
  }
  const today = new Date().toISOString().slice(0, 10);
  const offers = [];
  for (let i = 1; i < ov.length; i++) {
    const r = ov[i] || [];
    const id = String(r[0] || '').trim();
    const 상태 = String(r[7] || '').trim();
    if (!id || 상태 !== '모집중') continue;
    const 수량 = parseInt(String(r[5] || '0'), 10) || 0;
    const 예약 = counts[id] || 0;
    const 마감일 = String(r[6] || '').trim();
    let phase = 'open';                              // 모집 중
    if (예약 >= 수량 && 수량 > 0) phase = 'full';      // 정원 달성 (성사)
    else if (마감일 && 마감일 < today) phase = 'failed'; // 마감일 지남 + 미달 (불발)
    offers.push({
      id, 품종명: String(r[1] || ''), 설명: String(r[2] || ''), 사진URL: String(r[3] || ''),
      가격: String(r[4] || ''), 수량, 예약, 마감일, phase,
    });
  }
  return offers;
}

// 예약 접수 (회원당 1구, 정원 초과·중복 방지)
async function reserveOffer({ offerId, name, phone, memberNo, memo }) {
  const offers = await getOffers();
  const offer = offers.find((o) => o.id === offerId);
  if (!offer) throw new Error('진행 중인 분양을 찾지 못했습니다.');
  if (offer.phase === 'failed') throw new Error('마감일이 지나 이번 분양은 성사되지 않았습니다.');
  if (offer.phase === 'full') throw new Error('정원이 모두 찼습니다.');
  const digits = (p) => String(p || '').replace(/[^0-9]/g, '');
  const rv = await readSheet(RESERVE_SHEET);
  for (let i = 1; i < rv.length; i++) {
    const r = rv[i] || [];
    if (String(r[1] || '').trim() === offerId && digits(r[3]) === digits(phone)) {
      throw new Error('이미 이 분양에 예약하셨습니다. (회원당 1구)');
    }
  }
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10) + ' ' + now.toTimeString().slice(0, 5);
  const api = await getClient();
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${quoteTab(RESERVE_SHEET)}!A1`, valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[stamp, offerId, name, phone, memberNo, '우선환원 서약 동의', memo || '']] },
  });
  cacheClear();
  return { offer, 예약후: offer.예약 + 1 };
}

module.exports.getOffers = getOffers;
module.exports.reserveOffer = reserveOffer;

// =============================================================
// v13 추가: 가입요건 '골드+ 10개' 자동 검증
//  제출한 넘버들을 골드·로얄 시트와 대조하고, 본인 전화번호로 정품 등록돼 있는지 확인
// =============================================================

async function verifyGoldPlusNumbers(numbersText, phone) {
  const nums = Array.from(new Set(String(numbersText || '').match(NUM_RE) || []));
  const digits = (p) => String(p || '').replace(/[^0-9]/g, '');
  const myPhone = digits(phone);
  let goldTab = null, royalTab = null;
  try { goldTab = await resolveGradeTab('골드'); } catch (e) {}
  try { royalTab = await resolveGradeTab('로얄'); } catch (e) {}
  let 확인 = 0, 본인등록 = 0;
  for (const n of nums) {
    let row = null;
    try { row = await findRoyalByNumber(n); } catch (e) { break; }
    if (!row) continue;
    if (row._sheet === goldTab || row._sheet === royalTab) {
      확인++;
      if (myPhone && digits(row['제출자연락처']) === myPhone) 본인등록++;
    }
  }
  return { 제출: nums.length, 확인, 본인등록, 목록: nums };
}

module.exports.verifyGoldPlusNumbers = verifyGoldPlusNumbers;

module.exports.runDriveBackup = runDriveBackup;
