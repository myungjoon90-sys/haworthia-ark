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
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  _client = google.sheets({ version: 'v4', auth: authClient });
  return _client;
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
const JOIN_HEADERS = ['일시', '성함', '연락처', '충족요건', '서명이미지', '동의', '상태', '제출넘버', '자동확인'];

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
  }
}

async function appendJoinApplication(entry) {
  await ensureJoinSheet();
  const api = await getClient();
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${quoteTab(JOIN_SHEET)}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[entry.일시, entry.성함, entry.연락처, entry.충족요건, entry.서명이미지, entry.동의, '심사 대기']] },
  });
  cacheClear();
}

module.exports.appendJoinApplication = appendJoinApplication;


// =============================================================
// v8 추가: 공개 방주 리스트 ('방주리스트' 탭 — 작출자별 등재 품종)
//  - 다른 작출자(관리자)의 명단도 줄만 추가하면 함께 표시됩니다.
// =============================================================

const ARKLIST_SHEET = process.env.ARKLIST_SHEET_NAME || '방주리스트';
const ARKLIST_HEADERS = ['작출자', '품종명', '설명', '사진URL'];

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
        ['지양하월시아', '미카엘의 심장', '', ''],
        ['지양하월시아', '에뚜왈블루', '', ''],
        ['지양하월시아', '춘하추동 춘', '', ''],
      ] },
    });
    cacheClear();
  }
}

// 작출자별로 묶은 방주 리스트 반환: [{ 작출자, 품종: [{품종명, 설명, 사진URL}] }]
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
    groups.get(maker).push({ 품종명: name, 설명: String(r[2] || '').trim(), 사진URL: String(r[3] || '').trim() });
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
