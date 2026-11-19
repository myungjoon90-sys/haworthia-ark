// =============================================================
// club/i18n.js — 하월시아 클럽 화면 언어 (한국어 · English · 简体中文 · 繁體中文)
//  - 열쇠는 한국어 문장 그대로. 번역이 없으면 한국어가 그대로 나온다.
//  - {n} 같은 자리에 값을 끼워 넣는다.
//  - 회원이 쓴 글·닉네임·품종 태그는 번역하지 않는다.
// =============================================================
const DICT = require('./i18n_dict');

const LANGS = [
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
  { code: 'zh-Hans', label: '简体' },
  { code: 'zh-Hant', label: '繁體' },
];
const CODES = LANGS.map((l) => l.code);
const COL = { en: 0, 'zh-Hans': 1, 'zh-Hant': 2 };

// 폰·브라우저 언어로 고르기: 한국어 → ko / 대만·홍콩·마카오 중국어 → 繁體 / 그 밖 중국어 → 简体 / 나머지 → English
function fromAcceptLanguage(h) {
  const parts = String(h || '').toLowerCase().split(',').map((x) => x.split(';')[0].trim()).filter(Boolean);
  for (const p of parts) {
    if (p.startsWith('ko')) return 'ko';
    if (p.startsWith('zh')) {
      if (/(tw|hk|mo|hant)/.test(p)) return 'zh-Hant';
      return 'zh-Hans';
    }
    if (p.startsWith('en')) return 'en';
  }
  return parts.length ? 'en' : 'ko';
}

function makeT(lang, missing) {
  const col = COL[lang];
  return function t(s, vars) {
    let out = s;
    if (col !== undefined) {
      const row = DICT[s];
      if (row && row[col]) out = row[col];
      else if (missing && s && /[가-힣]/.test(s)) missing.add(s);
    }
    if (vars) out = String(out).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
    return out;
  };
}

const AGO = {
  ko: ['방금', '{n}분 전', '{n}시간 전', '{n}일 전'],
  en: ['just now', '{n}m ago', '{n}h ago', '{n}d ago'],
  'zh-Hans': ['刚刚', '{n}分钟前', '{n}小时前', '{n}天前'],
  'zh-Hant': ['剛剛', '{n}分鐘前', '{n}小時前', '{n}天前'],
};
function timeAgo(ms, lang, ymd) {
  const a = AGO[lang] || AGO.ko;
  const d = Math.max(0, Date.now() - ms);
  const m = Math.floor(d / 60000);
  const f = (s, n) => s.replace('{n}', n);
  if (m < 1) return a[0];
  if (m < 60) return f(a[1], m);
  const h = Math.floor(m / 60);
  if (h < 24) return f(a[2], h);
  const day = Math.floor(h / 24);
  if (day < 7) return f(a[3], day);
  return ymd(ms);
}

// 문자 인증 나라 목록 (이름은 번역표에서)
//  - 솔라피 해외 SMS 안내(2026 확인): 미국은 제한, 베트남은 등록 템플릿만 → 목록에서 뺐다
//  - 대만은 문자 앞에 "[SOLAPI] " 가 붙고, 링크가 들어가면 실패할 수 있다 → 인증 문자에 링크를 넣지 않는다
const COUNTRIES = [
  { code: '82', flag: '🇰🇷', name: '한국' },
  { code: '886', flag: '🇹🇼', name: '대만' },
  { code: '86', flag: '🇨🇳', name: '중국' },
  { code: '852', flag: '🇭🇰', name: '홍콩' },
  { code: '853', flag: '🇲🇴', name: '마카오' },
  { code: '81', flag: '🇯🇵', name: '일본' },
  { code: '65', flag: '🇸🇬', name: '싱가포르' },
  { code: '60', flag: '🇲🇾', name: '말레이시아' },
  { code: '66', flag: '🇹🇭', name: '태국' },
  { code: '63', flag: '🇵🇭', name: '필리핀' },
  { code: '62', flag: '🇮🇩', name: '인도네시아' },
  { code: '61', flag: '🇦🇺', name: '호주' },
  { code: '64', flag: '🇳🇿', name: '뉴질랜드' },
  { code: '44', flag: '🇬🇧', name: '영국' },
  { code: '49', flag: '🇩🇪', name: '독일' },
  { code: '33', flag: '🇫🇷', name: '프랑스' },
  { code: '31', flag: '🇳🇱', name: '네덜란드' },
  { code: '39', flag: '🇮🇹', name: '이탈리아' },
  { code: '34', flag: '🇪🇸', name: '스페인' },
  { code: '7', flag: '🇷🇺', name: '러시아' },
  { code: '91', flag: '🇮🇳', name: '인도' },
  { code: '971', flag: '🇦🇪', name: '아랍에미리트' },
];
const DEF_COUNTRY = { ko: '82', 'zh-Hant': '886', 'zh-Hans': '86', en: '' }; // 영어 화면은 나라를 직접 고르게

// 인증 문자
//  - 한국 번호: 한국어 (국내 SMS 는 EUC-KR 이라 중국 간체 글자가 깨질 수 있음)
//  - 해외 번호: 영문·숫자만 (해외 SMS 글자 처리가 나라마다 달라 깨짐 없는 쪽으로 · 확실하지 않아 안전하게)
const SMS_TEXT = {
  ko: '[하월시아 클럽] 인증번호 {code}\n5분 이내에 입력해 주세요.',
  intl: '[Haworthia Club] Code {code} (valid 5 min)',
};

module.exports = { DICT, LANGS, CODES, fromAcceptLanguage, makeT, timeAgo, COUNTRIES, DEF_COUNTRY, SMS_TEXT };
