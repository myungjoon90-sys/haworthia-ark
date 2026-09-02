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
  'DNA마커', '사진URL', '소유자', '소유이력', '발급일', '관리자메시지', '상태',
];

let _client = null;

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
  const api = await getClient();
  const res = await api.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1:Z10000`,
  });
  return res.data.values || [];
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
// 로얄넘버 정품 등록 (고객 제출) 관련 함수
//  - 같은 구글 시트 파일 안의 '로얄넘버' 탭(마스터 목록)과
//    '제출로그' 탭(모든 제출 기록)을 사용합니다.
//  - 탭 이름은 ROYAL_SHEET_NAME / SUBMIT_LOG_SHEET_NAME 환경변수로 변경 가능
// =============================================================

const ROYAL_SHEET = process.env.ROYAL_SHEET_NAME || '로얄넘버';
const LOG_SHEET = process.env.SUBMIT_LOG_SHEET_NAME || '제출로그';

// 특정 탭 전체 읽기
async function readSheet(sheetName) {
  const api = await getClient();
  const res = await api.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A1:Z10000`,
  });
  return res.data.values || [];
}

// 넘버 비교용 정규화: 공백/하이픈 제거 + 대문자 (예: "hw 2026 0001" == "HW-2026-0001")
function normalizeNumber(s) {
  return String(s || '').replace(/[\s\-_.]/g, '').toUpperCase();
}

// 로얄넘버 탭에서 넘버로 행 찾기. { _rowNumber, _headers, ...열값들 } 반환
async function findRoyalByNumber(number) {
  const values = await readSheet(ROYAL_SHEET);
  if (values.length < 1) return null;
  const headers = (values[0] || []).map((h) => String(h || '').trim());
  const numIdx = headers.findIndex((h) => h === '넘버' || h === '로얄넘버' || h === '고유번호' || h === '번호');
  if (numIdx === -1) throw new Error(`'${ROYAL_SHEET}' 탭의 1행에 '넘버'(또는 로얄넘버/고유번호/번호) 열 제목이 필요합니다.`);
  const target = normalizeNumber(number);
  if (!target) return null;
  for (let i = 1; i < values.length; i++) {
    const raw = values[i] || [];
    if (normalizeNumber(raw[numIdx]) === target) {
      const obj = { _rowNumber: i + 1, _headers: headers };
      headers.forEach((h, idx) => { if (h) obj[h] = String(raw[idx] === undefined ? '' : raw[idx]); });
      return obj;
    }
  }
  return null;
}

// 로얄넘버 탭의 특정 행에 제출자 정보 기록 (열 제목 기준으로 안전하게 기록)
async function updateRoyalRow(rowNumber, headers, updates) {
  const api = await getClient();
  const data = [];
  Object.keys(updates).forEach((col) => {
    const idx = headers.indexOf(col);
    if (idx === -1) return; // 해당 열 제목이 없으면 건너뜀
    data.push({
      range: `${ROYAL_SHEET}!${columnLetter(idx + 1)}${rowNumber}`,
      values: [[updates[col]]],
    });
  });
  if (data.length === 0) return;
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
}

// 제출로그 탭에 모든 제출 기록 (탭이 없으면 자동 생성)
async function appendSubmissionLog(entry) {
  const api = await getClient();
  const LOG_HEADERS = ['제출일시', '입력넘버', '성함', '연락처', '일치여부', '처리상태'];
  let values = [];
  try {
    values = await readSheet(LOG_SHEET);
  } catch (e) {
    // 탭이 없으면 만들고 제목줄 추가
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: LOG_SHEET } } }] },
    });
  }
  if (values.length === 0) {
    await api.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${LOG_SHEET}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [LOG_HEADERS] },
    });
  }
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${LOG_SHEET}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[entry.제출일시, entry.입력넘버, entry.성함, entry.연락처, entry.일치여부, entry.처리상태]] },
  });
}

module.exports.findRoyalByNumber = findRoyalByNumber;
module.exports.updateRoyalRow = updateRoyalRow;
module.exports.appendSubmissionLog = appendSubmissionLog;
