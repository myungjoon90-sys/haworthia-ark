// =============================================================
// server.js  —  지양하월시아 방주 프로젝트 디지털 보증서 시스템
// 주요 경로(URL):
//   GET  /certificate/:id   → 고객용 디지털 보증서 페이지
//   GET  /admin             → 관리자 로그인 / 보증서 발송 페이지
//   GET  /admin/new         → 개체 등록(보증서 발행) 폼
//   POST /admin/new         → 개체 등록 처리 (구글 시트에 새 행 추가)
//   POST /admin/login       → 관리자 로그인 처리
//   POST /admin/send        → 제품번호 입력 → 보증서 링크를 고객에게 알림톡/문자 발송
//   GET  /healthz           → 서버 상태 확인용
// =============================================================

require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const sheets = require('./lib/sheets');
const messaging = require('./lib/messaging');

const app = express();
const PORT = process.env.PORT || 3000;

// 배포 후 도메인 (예: https://ark.up.railway.app, 끝에 / 없이)
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'jiyang-ark-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 },
  })
);

function certificateUrl(req, id) {
  const base = BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/certificate/${encodeURIComponent(id)}`;
}

app.get('/healthz', (req, res) => res.send('ok'));
app.get('/', (req, res) => res.redirect('/admin'));

// 고객용 보증서 페이지
app.get('/certificate/:id', async (req, res) => {
  try {
    const plant = await sheets.findById(req.params.id);
    if (!plant) return res.status(404).render('not_found', { id: req.params.id });
    res.render('certificate', { plant, pageUrl: certificateUrl(req, req.params.id) });
  } catch (err) {
    console.error(err);
    res.status(500).send('보증서를 불러오는 중 오류가 발생했습니다: ' + err.message);
  }
});

function requireLogin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin');
}

app.get('/admin', (req, res) => {
  if (req.session && req.session.isAdmin) return res.render('admin', { result: null, error: null, form: {} });
  res.render('login', { error: null });
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.render('login', { error: '비밀번호가 올바르지 않습니다.' });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

// 올해 기준 다음 고유번호 추천 (예: HW-2026-0007)
async function suggestNextId() {
  const year = new Date().getFullYear();
  const prefix = 'HW-' + year + '-';
  let max = 0;
  try {
    const rows = await sheets.getAllRows();
    rows.forEach((r) => {
      const id = (r['고유번호'] || '').trim();
      if (id.indexOf(prefix) === 0) {
        const n = parseInt(id.slice(prefix.length), 10);
        if (!isNaN(n) && n > max) max = n;
      }
    });
  } catch (e) {
    console.warn('번호 추천 중 경고:', e.message);
  }
  return prefix + String(max + 1).padStart(4, '0');
}

// 개체 등록 폼
app.get('/admin/new', requireLogin, async (req, res) => {
  const suggestedId = await suggestNextId();
  res.render('register', { error: null, result: null, form: { 고유번호: suggestedId }, suggestedId });
});

// 개체 등록 처리 (시트에 새 행 추가)
app.post('/admin/new', requireLogin, async (req, res) => {
  const b = req.body;
  const form = {
    고유번호: (b['고유번호'] || '').trim(),
    품종명: (b['품종명'] || '').trim(),
    육종가: (b['육종가'] || '').trim() || '지양하월시아',
    육종연도: (b['육종연도'] || '').trim(),
    모본: (b['모본'] || '').trim(),
    부본: (b['부본'] || '').trim(),
    DNA마커: (b['DNA마커'] || '').trim(),
    사진URL: (b['사진URL'] || '').trim(),
    소유자: (b['소유자'] || '').trim(),
    소유이력: (b['소유이력'] || '').trim(),
    관리자메시지: (b['관리자메시지'] || '').trim(),
    상태: (b['상태'] || '').trim() || '정품 인증',
  };
  try {
    if (!form['고유번호']) throw new Error('고유번호는 필수입니다.');
    if (!form['품종명']) throw new Error('품종명은 필수입니다.');
    const exists = await sheets.findById(form['고유번호']);
    if (exists) throw new Error('고유번호 "' + form['고유번호'] + '" 는 이미 등록되어 있습니다. 다른 번호를 사용하세요.');
    await sheets.appendRow(form);
    const url = certificateUrl(req, form['고유번호']);
    res.render('register', {
      error: null,
      form: {},
      suggestedId: await suggestNextId(),
      result: { 고유번호: form['고유번호'], 품종명: form['품종명'], url },
    });
  } catch (err) {
    console.error(err);
    res.render('register', { error: err.message, form, result: null, suggestedId: form['고유번호'] });
  }
});

// 보증서 발송 처리
app.post('/admin/send', requireLogin, async (req, res) => {
  const form = {
    id: (req.body.id || '').trim(),
    name: (req.body.name || '').trim(),
    phone: (req.body.phone || '').trim(),
  };
  try {
    if (!form.id) throw new Error('제품(고유)번호를 입력하세요.');
    if (!form.phone) throw new Error('고객 휴대폰 번호를 입력하세요.');
    const plant = await sheets.findById(form.id);
    if (!plant) throw new Error('고유번호 "' + form.id + '" 에 해당하는 개체를 시트에서 찾지 못했습니다.');
    const today = new Date().toISOString().slice(0, 10);
    const updates = { 발급일: today };
    if (form.name) updates['소유자'] = form.name;
    try {
      await sheets.updateRow(plant._rowNumber, updates);
    } catch (e) {
      console.warn('시트 업데이트 경고(발송은 계속 진행):', e.message);
    }
    const url = certificateUrl(req, form.id);
    const sendResult = await messaging.sendCertificate({
      to: form.phone,
      name: form.name || plant['소유자'] || '',
      url,
    });
    res.render('admin', {
      error: null,
      form: {},
      result: { channel: sendResult.channel, id: form.id, variety: plant['품종명'] || '', phone: form.phone, url },
    });
  } catch (err) {
    console.error(err);
    res.render('admin', { error: err.message, form, result: null });
  }
});

// =============================================================
// 로얄넘버 정품 등록 (고객이 직접 제출하는 공개 페이지)
//   GET  /royal  → 제출 폼
//   POST /royal  → 넘버를 '로얄넘버' 탭과 대조 → 일치하면 그 행에 자동 기록
// =============================================================

app.get('/royal', (req, res) => {
  res.render('royal', { error: null, result: null, form: {} });
});

app.post('/royal', async (req, res) => {
  const form = {
    number: (req.body.number || '').trim(),
    name: (req.body.name || '').trim(),
    phone: (req.body.phone || '').trim(),
    agree: req.body.agree === 'on' || req.body.agree === 'true',
  };
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10) + ' ' + now.toTimeString().slice(0, 5);
  try {
    if (!form.number) throw new Error('로얄넘버를 입력해 주세요.');
    if (!form.name) throw new Error('성함을 입력해 주세요.');
    if (!form.phone.replace(/[^0-9]/g, '').match(/^01[0-9]{8,9}$/)) throw new Error('휴대폰 번호를 정확히 입력해 주세요. (예: 01012345678)');
    if (!form.agree) throw new Error('개인정보 수집·이용에 동의해 주셔야 등록이 가능합니다.');

    const row = await sheets.findRoyalByNumber(form.number);

    // ① 넘버가 마스터 목록에 없음 → 로그만 남기고 확인대기 안내
    if (!row) {
      await sheets.appendSubmissionLog({
        제출일시: stamp, 입력넘버: form.number, 성함: form.name,
        연락처: form.phone, 일치여부: '불일치', 처리상태: '관리자 확인 필요',
      });
      return res.render('royal', {
        error: null, form: {},
        result: { type: 'pending', number: form.number },
      });
    }

    // ② 이미 다른 사람이 등록한 넘버 → 중복 안내 (기존 기록은 덮어쓰지 않음)
    const existingName = (row['제출자명'] || '').trim();
    const existingPhone = (row['제출자연락처'] || '').replace(/[^0-9]/g, '');
    if (existingName && existingPhone && existingPhone !== form.phone.replace(/[^0-9]/g, '')) {
      await sheets.appendSubmissionLog({
        제출일시: stamp, 입력넘버: form.number, 성함: form.name,
        연락처: form.phone, 일치여부: '일치(중복제출)', 처리상태: '관리자 확인 필요',
      });
      return res.render('royal', {
        error: null, form: {},
        result: { type: 'duplicate', number: form.number },
      });
    }

    // ③ 정상 매칭 → 해당 행에 제출자 정보 자동 기록
    await sheets.updateRoyalRow(row._rowNumber, row._headers, {
      제출자명: form.name,
      제출자연락처: form.phone,
      제출일: stamp,
      등록상태: '제출완료(확인대기)',
    });
    await sheets.appendSubmissionLog({
      제출일시: stamp, 입력넘버: form.number, 성함: form.name,
      연락처: form.phone, 일치여부: '일치', 처리상태: '자동기록 완료',
    });
    res.render('royal', {
      error: null, form: {},
      result: { type: 'ok', number: form.number, name: form.name },
    });
  } catch (err) {
    console.error(err);
    res.render('royal', { error: err.message, form, result: null });
  }
});

app.listen(PORT, () => {
  console.log('✅ 방주 보증서 서버가 실행되었습니다. 포트: ' + PORT);
  if (!BASE_URL) console.log('ℹ️  BASE_URL 환경변수가 비어 있습니다. 배포 후 도메인을 BASE_URL에 넣어주세요.');
});
