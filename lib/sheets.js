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
