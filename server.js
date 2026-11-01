// =============================================================
// server.js  —  지양하월시아 방주 프로젝트 디지털 보증서 시스템 (v4)
// 주요 경로(URL):
//   GET  /certificate/:id     → 고객용 디지털 보증서 페이지
//   GET  /royal               → 로얄넘버 정품 등록 (고객 공개 페이지)
//   GET  /admin               → 관리자 로그인 → 통합 등록·발송 페이지로 이동
//   GET  /admin/new           → 개체 등록 + 보증서 발송 (통합 페이지)
//   GET  /admin/sheet/:key    → 녹박/적박/골드/로얄 시트 실시간 뷰어
//   GET  /admin/settings      → 설정(수정·추가 기능 백로그)
//   GET  /admin/resend        → 기존 개체 보증서 재발송
//   GET  /api/next-number     → 등급 선택 시 다음 넘버 자동 제안
//   GET  /api/varieties       → 품종명 자동완성 목록
//   GET  /healthz             → 서버 상태 확인용
// =============================================================

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const sheets = require('./lib/sheets');
const messaging = require('./lib/messaging');

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

// ---- 사진 저장 폴더 (Railway 볼륨 /data 가 있으면 거기에, 없으면 로컬 폴더) ----
const PHOTO_DIR = process.env.PHOTO_DIR || (fs.existsSync('/data') ? '/data/photos' : path.join(__dirname, 'photos_local'));
try { fs.mkdirSync(PHOTO_DIR, { recursive: true }); } catch (e) { console.warn('사진 폴더 생성 실패:', e.message); }

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PHOTO_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase().slice(0, 6);
      const safe = String((req.body && req.body.plantId) || 'photo').replace(/[^A-Za-z0-9가-힣一-鿿\-]/g, '').slice(0, 60);
      cb(null, `${safe}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/photos', express.static(PHOTO_DIR));
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
// 서명 토큰: 구매자 전용 링크(전체 정보)와 공개 링크(개인정보 숨김)를 구분
function certToken(id) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'jiyang-ark-secret')
    .update('cert:' + String(id)).digest('hex').slice(0, 10);
}
function ownerCertUrl(req, id) {
  return certificateUrl(req, id) + '?k=' + certToken(id);
}
function signPayload(str) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'jiyang-ark-secret')
    .update('card:' + str).digest('hex').slice(0, 12);
}
function photoUrl(req, filename) {
  const base = BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/photos/${encodeURIComponent(filename)}`;
}

app.get('/healthz', (req, res) => res.send('ok'));
app.get('/', (req, res) => res.redirect('/about'));

// ---- 고객용 보증서 페이지 ----
function gradeOf(plant) {
  const g = String(plant['등급'] || '').trim();
  if (['녹박', '적박', '골드', '로얄'].includes(g)) return g;
  const tail = String(plant['고유번호'] || '').split('-').pop().toUpperCase();
  if (tail.startsWith('RG')) return '로얄';
  if (tail.startsWith('RT')) return '적박';
  if (tail.startsWith('G') && !tail.startsWith('GR')) return '골드';
  if (tail.startsWith('GR') || tail.startsWith('T')) return '녹박';
  return '기본';
}

app.get('/certificate/:id', async (req, res) => {
  try {
    const plant = await sheets.findById(req.params.id);
    if (!plant) return res.status(404).render('not_found', { id: req.params.id });
    const grade = String(req.query.grade || '').trim() || gradeOf(plant); // ?grade= 로 미리보기 가능
    const full = String(req.query.k || '') === certToken(req.params.id); // 구매자 전용 링크만 전체 표시
    res.render('certificate', { plant, grade, full, pageUrl: certificateUrl(req, req.params.id) });
  } catch (err) {
    console.error(err);
    res.status(500).send('보증서를 불러오는 중 오류가 발생했습니다: ' + err.message);
  }
});

// ---- 관리자 로그인 ----
function requireLogin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin');
}

app.get('/admin', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin/new');
  res.render('login', { error: null });
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin/new');
  }
  res.render('login', { error: '비밀번호가 올바르지 않습니다.' });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

// ---- API: 등급 선택 시 다음 넘버 제안 ----
app.get('/api/next-number', requireLogin, async (req, res) => {
  try {
    const r = await sheets.suggestGradeNumber(String(req.query.grade || ''));
    res.json({ ok: true, suggest: r.suggest, last: r.last, lastRow: r.lastRow, tab: r.tab });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---- API: 품종명 자동완성 목록 ----
app.get('/api/varieties', requireLogin, async (req, res) => {
  try {
    const names = await sheets.listVarieties(String(req.query.grade || '로얄'));
    res.json({ ok: true, names });
  } catch (e) {
    res.json({ ok: false, error: e.message, names: [] });
  }
});

// ---- API: 등급 시트 미리보기 (등록 화면 옆 창) ----
app.get('/api/sheet-preview', requireLogin, async (req, res) => {
  try {
    const r = await sheets.getSheetPreview(String(req.query.grade || ''));
    res.json({ ok: true, tab: r.tab, rows: r.rows });
  } catch (e) {
    res.json({ ok: false, error: e.message, rows: [] });
  }
});

// ---- 통합: 개체 등록 + 보증서 자동 발송 ----
app.get('/admin/new', requireLogin, (req, res) => {
  // /admin/submissions 의 [승인·등록] 버튼에서 넘어올 때 프리필
  const q = req.query || {};
  const form = {};
  if (q.num) form.plantId = String(q.num);
  if (q.vname) form.variety = String(q.vname);
  if (q.owner) form.owner = String(q.owner);
  if (q.phone) form.phone = String(q.phone);
  res.render('register', { error: null, result: null, form, grades: Object.keys(sheets.GRADE_TABS) });
});

// 정품 등록 제출 승인 보드 (확인대기 목록)
app.get('/admin/submissions', requireLogin, async (req, res) => {
  try {
    const subs = await sheets.listPendingSubmissions();
    res.render('submissions', { subs, grades: Object.keys(sheets.GRADE_TABS), error: null });
  } catch (err) {
    console.error(err);
    res.render('submissions', { subs: [], grades: Object.keys(sheets.GRADE_TABS), error: err.message });
  }
});

app.post('/admin/new', requireLogin, upload.single('photo'), async (req, res) => {
  const b = req.body || {};
  const nowYear = new Date().getFullYear();
  const form = {
    등급: (b.grade || '').trim(),
    고유번호: (b.plantId || '').trim(),
    품종명: (b.variety || '').trim(),
    육종가: (b.breeder || '').trim() || '지양하월시아',
    육종연도: (b.bredYear || '').trim(),
    모본: (b.mother || '').trim(),
    부본: (b.father || '').trim(),
    DNA마커: (b.dna || '').trim(),
    소유자: (b.owner || '').trim(),
    소유이력: (b.history || '').trim(),
    관리자메시지: (b.adminMsg || '').trim(),
    고객전화: (b.phone || '').trim(),
  };
  try {
    if (!form['고유번호']) throw new Error('고유번호(넘버)는 필수입니다. 등급을 선택하면 자동으로 제안됩니다.');
    if (!form['품종명']) throw new Error('품종명은 필수입니다.');
    const exists = await sheets.findById(form['고유번호']);
    if (exists) throw new Error('고유번호 "' + form['고유번호'] + '" 는 이미 등록되어 있습니다.');

    // 사진 업로드 처리
    let 사진URL = '';
    if (req.file) 사진URL = photoUrl(req, req.file.filename);

    // 소유이력: 최초 육종 줄 자동 삽입
    let 이력 = form['소유이력'];
    if (!/최초\s*육종/.test(이력)) {
      const firstLine = `${form['육종연도'] || nowYear} | 최초 육종 (지양하월시아)`;
      이력 = 이력 ? firstLine + '\n' + 이력 : firstLine;
    }

    // ① Plants 탭에 기록 (상태 기본: 미인증)
    await sheets.appendRow({
      고유번호: form['고유번호'],
      품종명: form['품종명'],
      육종가: form['육종가'],
      육종연도: form['육종연도'],
      모본: form['모본'],
      부본: form['부본'],
      DNA마커: form['DNA마커'],
      사진URL,
      소유자: form['소유자'],
      소유이력: 이력,
      관리자메시지: form['관리자메시지'],
      상태: '미인증',
      등급: form['등급'],
    });

    // ② 선택한 등급 시트 맨 아래에도 기록
    let gradeTab = null;
    if (form['등급']) {
      try {
        gradeTab = await sheets.appendGradeRow(form['등급'], form['고유번호'], form['품종명']);
      } catch (e) {
        console.warn('등급 시트 기록 경고:', e.message);
      }
    }

    // ③ 전화번호가 있으면 보증서 자동 발송 → 상태 '정품 인증' 전환
    let sendInfo = null;
    if (form['고객전화']) {
      const url = ownerCertUrl(req, form['고유번호']);
      const sendResult = await messaging.sendCertificate({
        to: form['고객전화'],
        name: form['소유자'] || '',
        url,
      });
      const plant = await sheets.findById(form['고유번호']);
      if (plant) {
        await sheets.updateRow(plant._rowNumber, {
          상태: '정품 인증',
          발급일: new Date().toISOString().slice(0, 10),
        });
      }
      sendInfo = { channel: sendResult.channel, phone: form['고객전화'], url };
    }

    res.render('register', {
      error: null,
      form: {},
      grades: Object.keys(sheets.GRADE_TABS),
      result: {
        고유번호: form['고유번호'],
        품종명: form['품종명'],
        url: certificateUrl(req, form['고유번호']),
        gradeTab,
        사진URL,
        send: sendInfo,
      },
    });
  } catch (err) {
    console.error(err);
    const viewForm = { grade: form['등급'], plantId: form['고유번호'], variety: form['품종명'], breeder: form['육종가'], bredYear: form['육종연도'], mother: form['모본'], father: form['부본'], dna: form['DNA마커'], owner: form['소유자'], history: form['소유이력'], adminMsg: form['관리자메시지'], phone: form['고객전화'] };
    res.render('register', { error: err.message, form: viewForm, result: null, grades: Object.keys(sheets.GRADE_TABS) });
  }
});

// ---- 등급 시트 실시간 뷰어 ----
app.get('/admin/sheet/:key', requireLogin, async (req, res) => {
  try {
    const key = req.params.key;
    if (!sheets.GRADE_TABS[key]) return res.status(404).send('알 수 없는 시트입니다.');
    const { tab, values } = await sheets.readGradeSheet(key);
    res.render('sheet_view', { key, tab, values, grades: Object.keys(sheets.GRADE_TABS) });
  } catch (err) {
    console.error(err);
    res.status(500).send('시트를 불러오는 중 오류: ' + err.message);
  }
});

// ---- 설정 (수정·추가 기능 백로그) ----
app.get('/admin/settings', requireLogin, async (req, res) => {
  try {
    const items = await sheets.getSettings();
    res.render('settings', { items, grades: Object.keys(sheets.GRADE_TABS), added: req.query.ok === '1', error: null });
  } catch (err) {
    console.error(err);
    res.render('settings', { items: [], grades: Object.keys(sheets.GRADE_TABS), added: false, error: err.message });
  }
});

app.post('/admin/settings', requireLogin, async (req, res) => {
  try {
    const text = (req.body.item || '').trim();
    if (text) await sheets.addSetting(text);
    res.redirect('/admin/settings?ok=1');
  } catch (err) {
    console.error(err);
    const items = await sheets.getSettings().catch(() => []);
    res.render('settings', { items, grades: Object.keys(sheets.GRADE_TABS), added: false, error: err.message });
  }
});

// ---- 대시보드 ----
app.get('/admin/dashboard', requireLogin, async (req, res) => {
  try {
    const stats = await sheets.getDashboardStats();
    res.render('dashboard', { stats, grades: Object.keys(sheets.GRADE_TABS), error: null });
  } catch (err) {
    console.error(err);
    res.render('dashboard', { stats: null, grades: Object.keys(sheets.GRADE_TABS), error: err.message });
  }
});

// ---- QR 택 (인쇄용) : QR에는 공개 링크만 담겨 개인정보가 노출되지 않음 ----
app.get('/admin/qr/:id', requireLogin, async (req, res) => {
  const id = req.params.id;
  const plant = await sheets.findById(id).catch(() => null);
  res.render('qr_tag', {
    id,
    variety: plant ? (plant['품종명'] || '') : '',
    grade: plant ? gradeOf(plant) : '기본',
    publicUrl: certificateUrl(req, id),
    grades: Object.keys(sheets.GRADE_TABS),
  });
});

// ---- 회원 관리: 명단 + 멤버십 카드 발급 ----
app.get('/admin/members', requireLogin, async (req, res) => {
  try {
    const members = await sheets.getJoinApplicants();
    // 각 회원의 카드 링크 생성 (서명된 링크)
    const base = BASE_URL || `${req.protocol}://${req.get('host')}`;
    members.forEach((m) => {
      const payload = Buffer.from(JSON.stringify({ n: m.성함, no: m.회원번호, d: m.일시.slice(0, 10), p: m.연락처 }), 'utf8').toString('base64url');
      m.cardUrl = `${base}/card?d=${payload}&k=${signPayload(payload)}`;
    });
    res.render('members', { members, grades: Object.keys(sheets.GRADE_TABS), sent: req.query.sent || '', error: null });
  } catch (err) {
    console.error(err);
    res.render('members', { members: [], grades: Object.keys(sheets.GRADE_TABS), sent: '', error: err.message });
  }
});

app.post('/admin/members/card', requireLogin, async (req, res) => {
  try {
    const phone = (req.body.phone || '').trim();
    const url = (req.body.cardUrl || '').trim();
    const name = (req.body.name || '').trim();
    if (!phone || !url) throw new Error('연락처와 카드 링크가 필요합니다.');
    await messaging.sendCertificate({ to: phone, name, url });
    res.redirect('/admin/members?sent=' + encodeURIComponent(name));
  } catch (err) {
    console.error(err);
    const members = await sheets.getJoinApplicants().catch(() => []);
    res.render('members', { members, grades: Object.keys(sheets.GRADE_TABS), sent: '', error: err.message });
  }
});

// ---- 회원 카드 (서명 링크로만 접근) ----
app.get('/card', (req, res) => {
  try {
    const d = String(req.query.d || '');
    if (!d || String(req.query.k || '') !== signPayload(d)) return res.status(404).render('not_found', { id: 'MEMBER CARD' });
    const info = JSON.parse(Buffer.from(d, 'base64url').toString('utf8'));
    res.render('member_card', { name: info.n, no: info.no, date: info.d, dq: d, kq: String(req.query.k || '') });
  } catch (e) {
    res.status(404).render('not_found', { id: 'MEMBER CARD' });
  }
});

// ---- 회원 전용 특별분양 (회원 카드의 서명 링크로만 접근) ----
function verifyMemberLink(req) {
  const d = String((req.query.d !== undefined ? req.query.d : req.body.d) || '');
  const k = String((req.query.k !== undefined ? req.query.k : req.body.k) || '');
  if (!d || k !== signPayload(d)) return null;
  try { return { info: JSON.parse(Buffer.from(d, 'base64url').toString('utf8')), d, k }; }
  catch (e) { return null; }
}

app.get('/offers', async (req, res) => {
  const m = verifyMemberLink(req);
  if (!m) return res.status(404).render('not_found', { id: 'MEMBERS ONLY' });
  try {
    const offers = await sheets.getOffers();
    res.render('offers', { offers, member: m.info, d: m.d, k: m.k, error: null, done: null });
  } catch (err) {
    console.error(err);
    res.render('offers', { offers: [], member: m.info, d: m.d, k: m.k, error: err.message, done: null });
  }
});

app.post('/offers/reserve', async (req, res) => {
  const m = verifyMemberLink(req);
  if (!m) return res.status(404).render('not_found', { id: 'MEMBERS ONLY' });
  const offerId = (req.body.offerId || '').trim();
  const memo = (req.body.memo || '').trim();
  const phone = (req.body.phone || m.info.p || '').trim();
  try {
    if (req.body.pledge !== 'on') throw new Error('재분양 시 지양 우선환원 서약에 동의해 주셔야 예약할 수 있습니다.');
    if (!phone.replace(/[^0-9]/g, '').match(/^01[0-9]{8,9}$/)) throw new Error('연락처를 확인해 주세요.');
    const r = await sheets.reserveOffer({ offerId, name: m.info.n, phone, memberNo: m.info.no, memo });
    const msg = r.예약후 >= r.offer.수량
      ? `🎉 [방주 특별분양 성사!] ${r.offer.품종명} — 정원 ${r.offer.수량}명 전원 모집 완료 (마지막 예약: ${m.info.n})`
      : `[방주 특별분양 예약] ${r.offer.품종명} ${r.예약후}/${r.offer.수량}
${m.info.n} (${m.info.no}) / ${phone}`;
    messaging.sendAdminAlert(msg).catch(() => {});
    const offers = await sheets.getOffers();
    res.render('offers', { offers, member: m.info, d: m.d, k: m.k, error: null, done: { 품종명: r.offer.품종명, 예약후: r.예약후, 수량: r.offer.수량 } });
  } catch (err) {
    console.error(err);
    const offers = await sheets.getOffers().catch(() => []);
    res.render('offers', { offers, member: m.info, d: m.d, k: m.k, error: err.message, done: null });
  }
});

// ---- 이력: 제출자별 등록 요약 + 소유권 이전 ----
app.get('/admin/history', requireLogin, async (req, res) => {
  try {
    const [groups, transfers] = await Promise.all([sheets.buildHistory(), sheets.getTransfers()]);
    res.render('history', { groups, transfers, grades: Object.keys(sheets.GRADE_TABS), msg: req.query.ok ? '소유권 이전이 완료되었습니다.' : null, error: null });
  } catch (err) {
    console.error(err);
    res.render('history', { groups: [], transfers: [], grades: Object.keys(sheets.GRADE_TABS), msg: null, error: err.message });
  }
});

app.post('/admin/transfer', requireLogin, async (req, res) => {
  try {
    const number = (req.body.number || '').trim();
    const newName = (req.body.newName || '').trim();
    const newPhone = (req.body.newPhone || '').trim();
    if (!number || !newName || !newPhone) throw new Error('넘버, 새 소유자 성함, 연락처를 모두 입력해 주세요.');
    await sheets.transferOwnership(number, newName, newPhone);
    res.redirect('/admin/history?ok=1');
  } catch (err) {
    console.error(err);
    const [groups, transfers] = await Promise.all([sheets.buildHistory().catch(() => []), sheets.getTransfers().catch(() => [])]);
    res.render('history', { groups, transfers, grades: Object.keys(sheets.GRADE_TABS), msg: null, error: err.message });
  }
});

// ---- 기존 개체 보증서 재발송 (구 발송 페이지) ----
app.get('/admin/resend', requireLogin, (req, res) => {
  res.render('admin', { result: null, error: null, form: {}, grades: Object.keys(sheets.GRADE_TABS) });
});

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
    const updates = { 발급일: today, 상태: '정품 인증' };
    if (form.name) updates['소유자'] = form.name;
    try {
      await sheets.updateRow(plant._rowNumber, updates);
    } catch (e) {
      console.warn('시트 업데이트 경고(발송은 계속 진행):', e.message);
    }
    const url = ownerCertUrl(req, form.id);
    const sendResult = await messaging.sendCertificate({
      to: form.phone,
      name: form.name || plant['소유자'] || '',
      url,
    });
    res.render('admin', {
      error: null,
      form: {},
      grades: Object.keys(sheets.GRADE_TABS),
      result: { channel: sendResult.channel, id: form.id, variety: plant['품종명'] || '', phone: form.phone, url },
    });
  } catch (err) {
    console.error(err);
    res.render('admin', { error: err.message, form, result: null, grades: Object.keys(sheets.GRADE_TABS) });
  }
});

// =============================================================
// 공개 페이지: 방주 소개(/about) + 멤버십 가입(/join, 전자서명)
// =============================================================

// 가입 요건 목록 — 여기만 고치면 가입창에 그대로 반영됩니다.
// (id는 시트에 기록되는 짧은 이름, need는 총 몇 개를 충족해야 하는지)
const MEMBER_RULE = { need: 3 };
const MEMBER_CRITERIA = [
  { id: '골드10', label: '골드 등급 이상, 디지털 보증서 10개 이상 보유 (넘버 제출)' },
  { id: '구매1천', label: '지양하월시아 누적 구매 1,000만원 이상' },
  { id: '키핑', label: '지양하월시아에 하월시아를 키핑 중' },
  { id: '컬렉션30', label: '지양하월시아 출신 개체 30주 이상 보유 (방주 등록 기준)' },
  { id: '대회출품', label: '하월시아 대회·전시에 지양 개체로 출품(수상)한 이력' },
];
// 보너스 요건: 충족 시 위 요건 1개를 충족한 것으로 인정
const MEMBER_BONUS = { id: '보너스-초기라벨3세트', label: '[보너스] 초기(2015~10년대) 개체를 정품 라벨 완전 세트(한글판+시리얼번호판 2장 = 1세트)로 총 3세트 보유' };

// 공개 정품 조회: 넘버 상태만 확인 (개인정보 없음)
app.get('/verify', async (req, res) => {
  const q = (req.query.n || '').trim();
  if (!q) return res.render('verify', { q: '', result: null, error: null });
  try {
    const result = await sheets.verifyNumber(q);
    res.render('verify', { q, result, error: null });
  } catch (err) {
    console.error(err);
    res.render('verify', { q, result: null, error: err.message });
  }
});

// 공개 방주 리스트 (작출자별 등재 품종)
app.get('/list', async (req, res) => {
  const isMember = !!(req.session && req.session.memberNo);
  try {
    const groups = await sheets.getArkList();
    const ownership = isMember ? await sheets.getOwnershipMap().catch(() => ({})) : {};
    res.render('ark_list', { groups, isMember, ownership, error: null });
  } catch (err) {
    console.error(err);
    res.render('ark_list', { groups: [], isMember, ownership: {}, error: err.message });
  }
});

// 공개 회원 명부 (성함록) — 회원 전용: 휴대폰 번호 + 입장 암호 확인 후 열람
app.get('/members', async (req, res) => {
  if (!(req.session && req.session.memberNo)) {
    return res.render('members_gate', { error: null });
  }
  try {
    const members = await sheets.getPublicMembers();
    const seat = await sheets.getMembershipStatus().catch(() => null);
    res.render('members_public', { members, seat, error: null });
  } catch (err) {
    console.error(err);
    res.render('members_public', { members: [], seat: null, error: err.message });
  }
});

// ---- 등재 투표 (회원 전용): 실생을 올리고 전체 회원 70% 찬성 시 방주 등재 ----
function requireMember(req, res, next) {
  if (req.session && req.session.memberNo) return next();
  req.session.afterGate = (req.originalUrl.startsWith('/vote') || req.originalUrl.startsWith('/community')) ? req.originalUrl : '/members';
  res.render('members_gate', { error: null });
}

app.get('/vote', requireMember, async (req, res) => {
  try {
    const proposals = await sheets.listProposals(req.session.memberNo);
    res.render('vote', { proposals, me: { no: req.session.memberNo, nick: req.session.memberNick || req.session.memberName }, msg: req.query.msg || '', error: null });
  } catch (err) {
    console.error(err);
    res.render('vote', { proposals: [], me: { no: req.session.memberNo, nick: req.session.memberNick || '' }, msg: '', error: err.message });
  }
});

app.post('/vote/propose', requireMember, upload.single('photo'), async (req, res) => {
  try {
    const 품종명 = (req.body.vname || '').trim();
    const 설명 = (req.body.vdesc || '').trim();
    if (!품종명) throw new Error('품종명을 입력해 주세요.');
    if (!req.file) throw new Error('개체 사진을 첨부해 주세요.');
    const 사진URL = photoUrl(req, req.file.filename);
    const no = await sheets.addProposal({ 제안자: req.session.memberNick || req.session.memberName, 품종명, 설명, 사진URL });
    messaging.sendAdminAlert(`[방주] 새 등재 투표 #${no}\n${req.session.memberName} / ${품종명}`).catch(() => {});
    res.redirect('/vote?msg=' + encodeURIComponent('등재 제안이 올라갔습니다. 회원 투표가 시작됩니다.'));
  } catch (err) {
    const proposals = await sheets.listProposals(req.session.memberNo).catch(() => []);
    res.render('vote', { proposals, me: { no: req.session.memberNo, nick: req.session.memberNick || '' }, msg: '', error: err.message });
  }
});

app.post('/vote/cast', requireMember, async (req, res) => {
  try {
    const r = await sheets.castVote(String(req.body.no || ''), req.session.memberNo, String(req.body.choice || ''));
    if (r.passed) {
      messaging.sendAdminAlert(`[방주] 등재 투표 가결! (찬성 ${r.yes}/${r.need} 충족)\n방주리스트에 자동 등재되었습니다.`).catch(() => {});
      return res.redirect('/vote?msg=' + encodeURIComponent('가결되었습니다! 방주 갤러리에 등재됩니다.'));
    }
    res.redirect('/vote?msg=' + encodeURIComponent('투표가 기록되었습니다.'));
  } catch (err) {
    const proposals = await sheets.listProposals(req.session.memberNo).catch(() => []);
    res.render('vote', { proposals, me: { no: req.session.memberNo, nick: req.session.memberNick || '' }, msg: '', error: err.message });
  }
});

// ---- 회원 커뮤니티 (사진 + 댓글) ----
app.get('/community', requireMember, async (req, res) => {
  try {
    const posts = await sheets.listPosts();
    res.render('community', { posts, me: { nick: req.session.memberNick || req.session.memberName }, msg: req.query.msg || '', error: null });
  } catch (err) {
    console.error(err);
    res.render('community', { posts: [], me: { nick: req.session.memberNick || '' }, msg: '', error: err.message });
  }
});

app.post('/community/post', requireMember, upload.single('photo'), async (req, res) => {
  try {
    const 제목 = (req.body.title || '').trim();
    const 내용 = (req.body.body || '').trim();
    if (!제목 && !내용) throw new Error('제목이나 내용을 입력해 주세요.');
    const 사진URL = req.file ? photoUrl(req, req.file.filename) : '';
    const no = await sheets.addPost({ 작성자: req.session.memberNick || req.session.memberName, 회원번호: req.session.memberNo, 제목: 제목 || '(제목 없음)', 내용, 사진URL });
    res.redirect('/community/' + no);
  } catch (err) {
    const posts = await sheets.listPosts().catch(() => []);
    res.render('community', { posts, me: { nick: req.session.memberNick || '' }, msg: '', error: err.message });
  }
});

app.get('/community/:no', requireMember, async (req, res) => {
  try {
    const post = await sheets.getPost(req.params.no);
    if (!post) return res.status(404).render('not_found', { id: 'POST' });
    res.render('community_post', { post, me: { nick: req.session.memberNick || req.session.memberName }, error: null });
  } catch (err) {
    console.error(err);
    res.status(500).render('not_found', { id: 'POST' });
  }
});

app.post('/community/:no/comment', requireMember, async (req, res) => {
  try {
    const 내용 = (req.body.text || '').trim();
    if (내용) await sheets.addComment({ 글번호: req.params.no, 작성자: req.session.memberNick || req.session.memberName, 회원번호: req.session.memberNo, 내용 });
    res.redirect('/community/' + req.params.no);
  } catch (err) {
    console.error(err);
    res.redirect('/community/' + req.params.no);
  }
});

app.post('/members/enter', async (req, res) => {
  try {
    const phone = (req.body.phone || '').trim();
    const code = (req.body.code || '').trim();
    if (!phone || !code) throw new Error('휴대폰 번호와 입장 암호를 모두 입력해 주세요.');
    const digits = phone.replace(/[^0-9]/g, '');
    if (code.replace(/[^0-9]/g, '') !== digits.slice(-4)) throw new Error('입장 암호가 올바르지 않습니다. (가입하신 휴대폰 번호의 뒤 4자리)');
    const member = await sheets.findApprovedByPhone(phone);
    if (!member) throw new Error('회원 명단에서 이 번호를 찾을 수 없습니다. 가입하신 번호로 입력해 주세요.');
    req.session.memberNo = member.회원번호;
    req.session.memberName = member.성함;
    req.session.memberNick = member.닉네임 || member.성함;
    res.redirect(req.session.afterGate || '/members');
  } catch (err) {
    res.render('members_gate', { error: err.message });
  }
});

app.get('/about', (req, res) => {
  res.render('about', { joinUrl: '/join', royalUrl: '/royal' });
});

app.get('/join', async (req, res) => {
  const seat = await sheets.getMembershipStatus().catch(() => null);
  res.render('join', { error: null, done: false, form: {}, criteria: MEMBER_CRITERIA, bonus: MEMBER_BONUS, need: MEMBER_RULE.need, seat });
});

app.post('/join', async (req, res) => {
  const form = {
    name: (req.body.name || '').trim(),
    nickname: (req.body.nickname || '').trim(),
    phone: (req.body.phone || '').trim(),
    criteria: [].concat(req.body.criteria || []),
    agree: req.body.agree === 'on',
  };
  try {
    if (!form.name) throw new Error('성함을 입력해 주세요.');
    if (!form.phone.replace(/[^0-9]/g, '').match(/^01[0-9]{8,9}$/)) throw new Error('휴대폰 번호를 정확히 입력해 주세요.');
    if (form.criteria.length < MEMBER_RULE.need) throw new Error(`가입 요건 중 ${MEMBER_RULE.need}가지 이상을 선택(충족)해야 합니다.`);
    if (!form.agree) throw new Error('방주 프로젝트 규정 동의에 체크해 주세요.');

    // '골드10' 요건 체크 시: 넘버 제출 필수 + 골드·로얄 시트와 자동 대조
    let 제출넘버 = '', 자동확인 = '';
    if (form.criteria.includes('골드10')) {
      const goldNumbers = (req.body.goldNumbers || '').trim();
      const check = await sheets.verifyGoldPlusNumbers(goldNumbers, form.phone);
      if (check.제출 < 10) throw new Error(`골드 등급 이상 넘버를 10개 이상 적어 주세요. (현재 인식된 넘버: ${check.제출}개)`);
      제출넘버 = check.목록.join('\n');
      자동확인 = `제출 ${check.제출}개 / 골드+ 시트 확인 ${check.확인}개 / 본인 정품등록 ${check.본인등록}개`;
    }

    const now = new Date();
    const stamp = now.toISOString().slice(0, 10) + ' ' + now.toTimeString().slice(0, 5);
    const seat = await sheets.getMembershipStatus().catch(() => null);
    const isWait = !!(seat && seat.waitlist);
    await sheets.appendJoinApplication({
      일시: stamp,
      성함: form.name,
      연락처: form.phone,
      충족요건: form.criteria.join(', '),
      서명이미지: '',
      동의: '규정 동의함',
      상태: isWait ? '대기' : '심사 대기',
      제출넘버,
      자동확인,
      닉네임: form.nickname,
    });
    messaging.sendAdminAlert(`[방주] ${isWait ? '대기 명단 등록' : '새 멤버십 가입 신청'}\n${form.name} / ${form.phone}\n요건: ${form.criteria.join(', ')}` + (자동확인 ? `\n넘버 자동확인: ${자동확인}` : '')).catch(() => {});
    // 신청자 본인에게 접수 확인 문자 (실패해도 신청은 정상 처리)
    messaging.sendText({
      to: form.phone,
      subject: isWait ? '방주 대기 명단 등록' : '방주 가입 신청 접수',
      text: `[지양하월시아 · 방주 프로젝트]\n\n${form.name}님, ` + (isWait
        ? `현재 기수 정원이 마감되어 대기 명단에 등록되었습니다.\n자리가 나면 등록 순서에 따라 다음 기수 심사 대상으로 안내드리겠습니다.`
        : `멤버십 가입 신청이 접수되었습니다.\n관리자 검토(요건 확인) 후 결과를 문자로 안내드리겠습니다.`) +
        `\n\n감사합니다.\n지양하월시아 드림`,
    }).catch((e) => console.warn('접수 확인 문자 실패(무시):', e.message));
    res.render('join', { error: null, done: isWait ? 'wait' : true, form: {}, criteria: MEMBER_CRITERIA, bonus: MEMBER_BONUS, need: MEMBER_RULE.need, seat });
  } catch (err) {
    console.error(err);
    const seat = await sheets.getMembershipStatus().catch(() => null);
    res.render('join', { error: err.message, done: false, form, criteria: MEMBER_CRITERIA, bonus: MEMBER_BONUS, need: MEMBER_RULE.need, seat });
  }
});

// ---- 협의서 확인·서명 (승인 회원 전용, 서명 링크로만 접근) ----
function parseContractLink(req) {
  const d = String((req.method === 'POST' ? req.body.d : req.query.d) || '');
  const k = String((req.method === 'POST' ? req.body.k : req.query.k) || '');
  if (!d || k !== signPayload(d)) return null;
  try { return { info: JSON.parse(Buffer.from(d, 'base64url').toString('utf8')), d, k }; }
  catch (e) { return null; }
}

app.get('/contract', async (req, res) => {
  const link = parseContractLink(req);
  if (!link) return res.status(404).render('not_found', { id: 'CONTRACT' });
  try {
    const row = await sheets.findContractPending(link.info.p);
    if (!row) return res.status(404).render('not_found', { id: 'CONTRACT' });
    if (row.already) return res.render('contract', { name: row.성함, dq: link.d, kq: link.k, done: 'already', error: null });
    res.render('contract', { name: row.성함, dq: link.d, kq: link.k, done: false, error: null });
  } catch (e) {
    console.error(e);
    res.status(500).render('contract', { name: link.info.n, dq: link.d, kq: link.k, done: false, error: e.message });
  }
});

app.post('/contract', async (req, res) => {
  const link = parseContractLink(req);
  if (!link) return res.status(404).render('not_found', { id: 'CONTRACT' });
  try {
    const sig = String(req.body.signature || '');
    if (req.body.agree !== 'on') throw new Error('협의서 동의에 체크해 주세요.');
    if (!sig.startsWith('data:image/png;base64,')) throw new Error('서명란에 서명해 주세요.');
    const row = await sheets.findContractPending(link.info.p);
    if (!row) return res.status(404).render('not_found', { id: 'CONTRACT' });
    if (row.already) return res.render('contract', { name: row.성함, dq: link.d, kq: link.k, done: 'already', error: null });

    const b64 = sig.replace(/^data:image\/png;base64,/, '');
    if (b64.length > 1.5 * 1024 * 1024) throw new Error('서명 이미지가 너무 큽니다. 다시 시도해 주세요.');
    const fname = 'contract_' + String(link.info.p).replace(/[^0-9]/g, '') + '_' + Date.now() + '.png';
    fs.writeFileSync(path.join(PHOTO_DIR, fname), Buffer.from(b64, 'base64'));
    const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    const resale = String(req.body.resale || '').slice(0, 20);
    await sheets.markContractSigned(row.sheetRow, photoUrl(req, fname), '서명 ' + now, resale);
    messaging.sendAdminAlert(`[방주] 협의서 서명 완료 → 가입완료\n${row.성함} / ${link.info.p}\n재분양: ${resale || '미선택'}`).catch(() => {});
    setTimeout(() => { processWelcomes().catch(() => {}); }, 2000); // 곧바로 환영 문자
    res.render('contract', { name: row.성함, dq: link.d, kq: link.k, done: true, error: null });
  } catch (e) {
    console.error(e);
    res.render('contract', { name: link.info.n, dq: link.d, kq: link.k, done: false, error: e.message });
  }
});

// =============================================================
// 로얄넘버 정품 등록 (고객이 직접 제출하는 공개 페이지)
// =============================================================

app.get('/royal', (req, res) => {
  res.render('royal', { error: null, result: null, form: {} });
});

app.post('/royal', upload.single('photo'), async (req, res) => {
  const form = {
    number: (req.body.number || '').trim(),
    vname: (req.body.vname || '').trim(),
    name: (req.body.name || '').trim(),
    phone: (req.body.phone || '').trim(),
    agree: req.body.agree === 'on' || req.body.agree === 'true',
  };
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10) + ' ' + now.toTimeString().slice(0, 5);
  try {
    if (!form.number) throw new Error('로얄넘버를 입력해 주세요.');
    if (!form.vname) throw new Error('품종명(라벨에 적힌 이름)을 입력해 주세요.');
    if (!form.name) throw new Error('성함을 입력해 주세요.');
    if (!form.phone.replace(/[^0-9]/g, '').match(/^01[0-9]{8,9}$/)) throw new Error('휴대폰 번호를 정확히 입력해 주세요. (예: 01012345678)');
    if (!form.agree) throw new Error('개인정보 수집·이용에 동의해 주셔야 등록이 가능합니다.');
    if (!req.file) throw new Error('개체와 라벨이 함께 나온 사진을 반드시 올려 주세요. (도용 방지를 위한 실물 확인용)');
    const 제출사진 = photoUrl(req, req.file.filename);

    const row = await sheets.findRoyalByNumber(form.number);

    if (!row) {
      await sheets.appendSubmissionLog({
        제출일시: stamp, 입력넘버: form.number, 품종명: form.vname, 성함: form.name,
        연락처: form.phone, 일치여부: '불일치', 처리상태: '관리자 확인 필요',
      });
      messaging.sendAdminAlert(`[방주] 새 넘버 제출(목록 불일치)\n${form.name} / ${form.phone}\n${form.number} (${form.vname})\n사진: ${제출사진}`).catch(() => {});
      return res.render('royal', { error: null, form: {}, result: { type: 'pending', number: form.number } });
    }

    const existingName = (row['제출자명'] || '').trim();
    const existingPhone = (row['제출자연락처'] || '').replace(/[^0-9]/g, '');
    if (existingName && existingPhone && existingPhone !== form.phone.replace(/[^0-9]/g, '')) {
      await sheets.appendSubmissionLog({
        제출일시: stamp, 입력넘버: form.number, 품종명: form.vname, 성함: form.name,
        연락처: form.phone, 일치여부: '일치(중복제출)', 처리상태: '관리자 확인 필요',
      });
      messaging.sendAdminAlert(`[방주] 중복 제출(소유권 확인 필요)\n${form.name} / ${form.phone}\n${form.number} (${form.vname})\n사진: ${제출사진}`).catch(() => {});
      return res.render('royal', { error: null, form: {}, result: { type: 'duplicate', number: form.number } });
    }

    await sheets.updateRoyalRow(row._sheet, row._rowNumber, {
      제출자명: form.name,
      제출자연락처: form.phone,
      제출일: stamp,
      등록상태: '제출완료(확인대기)',
      제출사진,
    });
    messaging.sendAdminAlert(`[방주] 새 정품 등록 제출\n${form.name} / ${form.phone}\n${form.number} (${form.vname})\n승인: /admin/submissions\n사진: ${제출사진}`).catch(() => {});
    await sheets.appendSubmissionLog({
      제출일시: stamp, 입력넘버: form.number, 품종명: form.vname, 성함: form.name,
      연락처: form.phone, 일치여부: '일치', 처리상태: '자동기록 완료',
    });
    res.render('royal', { error: null, form: {}, result: { type: 'ok', number: form.number, name: form.name } });
  } catch (err) {
    console.error(err);
    res.render('royal', { error: err.message, form, result: null });
  }
});

// ---- 자동 백업: 하루 1회 전체 탭을 JSON 파일로 저장 (사진 볼륨과 같은 저장소) ----
const BACKUP_DIR = path.join(path.dirname(PHOTO_DIR), 'backups');
async function runBackup() {
  try {
    const data = await sheets.dumpAllTabs();
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = 'backup-' + new Date().toISOString().slice(0, 10) + '.json';
    fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(data));
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('backup-')).sort();
    while (files.length > 14) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    console.log('🗄  자동 백업 완료:', name);
  } catch (e) {
    console.warn('자동 백업 실패(다음 회차에 재시도):', e.message);
  }
}
setTimeout(runBackup, 3 * 60 * 1000);           // 서버 시작 3분 후 1회
setInterval(runBackup, 24 * 60 * 60 * 1000);    // 이후 24시간마다

// 매일 1회: 구글 드라이브 '방주 백업' 폴더에 시트 사본 자동 생성 (BACKUP_FOLDER_ID 설정 시)
async function runDriveBackupSafe() {
  try {
    const r = await sheets.runDriveBackup();
    if (r && r.ok) console.log('드라이브 백업 완료:', r.name);
    else if (r && r.skipped) console.log('드라이브 백업 건너뜀:', r.skipped);
  } catch (e) {
    console.warn('드라이브 백업 실패(무시):', e.message);
  }
}
setTimeout(runDriveBackupSafe, 5 * 60 * 1000);
setInterval(runDriveBackupSafe, 24 * 60 * 60 * 1000);

// =============================================================
// 승인 자동 환영: 구글시트에서 상태를 '승인'으로 바꾸면
// 5분 안에 환영 문자 + 멤버십 카드 링크가 자동 발송됩니다. (K열에 기록)
// =============================================================
async function processWelcomes() {
  try {
    const list = await sheets.getPendingWelcomes();
    if (!list.length) return;
    for (const m of list) {
      try {
        const freshK = await sheets.readJoinCellFresh('K' + m.sheetRow).catch(() => '');
        if (freshK) continue; // 다른 인스턴스가 이미 처리함 (배포 교체 중 중복 방지)
        await sheets.markWelcomeSent(m.sheetRow, '발송중');
        const payload = Buffer.from(JSON.stringify({ n: m.성함, no: m.회원번호, d: (m.일시 || '').slice(0, 10), p: m.연락처 }), 'utf8').toString('base64url');
        const cardUrl = BASE_URL ? `${BASE_URL}/card?d=${payload}&k=${signPayload(payload)}` : '';
        const text =
          `[지양하월시아 · 방주 프로젝트]\n\n` +
          `${m.성함}님, 방주 멤버십 가입이 승인되었습니다.\n` +
          `50석의 방주에 오르신 것을 진심으로 환영합니다.\n\n` +
          `회원번호 ${m.회원번호}` +
          (cardUrl ? `\n\n▼ 멤버십 카드 확인\n${cardUrl}` : '') +
          (BASE_URL ? `\n\n▼ 회원 명부 (회원 전용)\n${BASE_URL}/members\n입장: 가입하신 휴대폰 번호 + 번호 뒤 4자리` : '') +
          `\n\n블랙 라인 분양과 회원 소식을 가장 먼저 안내드리겠습니다.\n지양하월시아 드림`;
        await messaging.sendText({ to: m.연락처, subject: '방주 멤버십 승인', text });
        const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
        await sheets.markWelcomeSent(m.sheetRow, '발송 ' + now);
        messaging.sendAdminAlert(`[방주] 환영 문자 자동 발송\n${m.성함} / ${m.회원번호}`).catch(() => {});
      } catch (e) {
        console.warn('환영 문자 발송 실패:', e.message);
        await sheets.markWelcomeSent(m.sheetRow, '실패(칸 비우면 재시도): ' + String(e.message || '').slice(0, 40)).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('환영 자동발송 체크 실패(무시):', e.message);
  }
}
setTimeout(processWelcomes, 3 * 60 * 1000);     // 서버 시작 3분 후 1회 (배포 교체 중 중복 방지)
setInterval(processWelcomes, 5 * 60 * 1000);    // 이후 5분마다

// =============================================================
// 승인 → 협의서 서명 안내: 시트에서 상태를 '승인'으로 바꾸면
// 5분 안에 협의서 확인·서명 링크가 문자로 발송됩니다. (L열에 기록)
// 서명이 끝나면 상태가 '가입완료'로 바뀌고 환영 문자가 나갑니다.
// =============================================================
async function processContracts() {
  try {
    if (!BASE_URL) return;
    const list = await sheets.getPendingContracts();
    for (const m of list) {
      try {
        const freshL = await sheets.readJoinCellFresh('L' + m.sheetRow).catch(() => '');
        if (freshL) continue; // 다른 인스턴스가 이미 처리함 (배포 교체 중 중복 방지)
        await sheets.markContractRequested(m.sheetRow, '안내중');
        const payload = Buffer.from(JSON.stringify({ p: m.연락처, n: m.성함 }), 'utf8').toString('base64url');
        const url = `${BASE_URL}/contract?d=${payload}&k=${signPayload(payload)}`;
        const text =
          `[지양하월시아 · 방주 프로젝트]\n\n` +
          `${m.성함}님, 방주 멤버십 가입이 승인되었습니다.\n` +
          `마지막 절차로 아래 링크에서 협의서를 확인하고 서명해 주시면 가입이 완료됩니다.\n\n` +
          `▼ 협의서 확인·서명\n${url}\n\n` +
          `서명 완료 즉시 회원번호와 멤버십 카드를 보내드립니다.\n지양하월시아 드림`;
        await messaging.sendText({ to: m.연락처, subject: '방주 협의서 서명 안내', text });
        const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
        await sheets.markContractRequested(m.sheetRow, '안내 ' + now);
      } catch (e) {
        console.warn('계약 안내 발송 실패:', e.message);
        await sheets.markContractRequested(m.sheetRow, '실패(칸 비우면 재시도): ' + String(e.message || '').slice(0, 40)).catch(() => {});
      }
    }
  } catch (e) { console.warn('계약 안내 체크 실패(무시):', e.message); }
}
setTimeout(processContracts, 3.5 * 60 * 1000);
setInterval(processContracts, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log('✅ 방주 보증서 서버(v4)가 실행되었습니다. 포트: ' + PORT);
  console.log('📷 사진 저장 폴더: ' + PHOTO_DIR);
  if (!BASE_URL) console.log('ℹ️  BASE_URL 환경변수가 비어 있습니다. 배포 후 도메인을 BASE_URL에 넣어주세요.');
});
