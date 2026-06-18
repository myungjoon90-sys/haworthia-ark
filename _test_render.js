// EJS와 동일한 규칙으로 템플릿을 렌더링해보는 검증용 스크립트 (배포와 무관, 깃에 올라가지 않음)
const fs = require('fs');
const path = require('path');

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 표준 EJS의 <% %>, <%= %>, <%- %>, <%# %> 를 지원하는 최소 컴파일러
function renderEjs(template, data) {
  let src = "let __o='';\nwith(__locals){\n";
  let cursor = 0;
  const re = /<%(=|-|#)?([\s\S]*?)%>/g;
  let m;
  while ((m = re.exec(template)) !== null) {
    const text = template.slice(cursor, m.index);
    if (text) src += "__o+=" + JSON.stringify(text) + ";\n";
    const type = m[1];
    const code = m[2];
    if (type === '=') src += "__o+=__esc(" + code + ");\n";
    else if (type === '-') src += "__o+=(" + code + ");\n";
    else if (type === '#') { /* comment */ }
    else src += code + "\n";
    cursor = m.index + m[0].length;
  }
  const tail = template.slice(cursor);
  if (tail) src += "__o+=" + JSON.stringify(tail) + ";\n";
  src += "}\nreturn __o;";
  const fn = new Function('__locals', '__esc', src);
  return fn(data, escapeXml);
}

function test(file, data) {
  const tpl = fs.readFileSync(path.join(__dirname, 'views', file), 'utf8');
  try {
    const out = renderEjs(tpl, data);
    const hasUndefined = /undefined/.test(out);
    console.log(`✅ ${file} 렌더 성공 (${out.length}자)` + (hasUndefined ? '  ⚠️ "undefined" 포함!' : ''));
    return out;
  } catch (e) {
    console.log(`❌ ${file} 렌더 실패: ${e.message}`);
    return null;
  }
}

// 샘플 개체 사진(데이터 URI) — 별도 SVG 파일을 읽어 base64로 인코딩
const svg = fs.readFileSync(path.join(__dirname, '_sample_photo.svg'));
const photoDataUri = 'data:image/svg+xml;base64,' + svg.toString('base64');

const samplePlant = {
  고유번호: 'HW-2026-0001',
  품종명: '옵투사 만상 「청룡」',
  육종가: '지양하월시아',
  육종연도: '2024',
  모본: '청광 만상',
  부본: '흑룡 옵투사',
  DNA마커: '등록 완료 (JY-DNA-0001)',
  사진URL: photoDataUri,
  소유자: '홍길동',
  소유이력: '2024 | 최초 육종 (지양하월시아)\n2026-06-18 | 홍길동 님 분양',
  발급일: '2026-06-18',
  관리자메시지: '',
  상태: '정품 인증',
};

console.log('=== 템플릿 렌더링 검증 ===');
const cert = test('certificate.ejs', { plant: samplePlant, pageUrl: 'https://ark.up.railway.app/certificate/HW-2026-0001' });
test('admin.ejs', { result: null, error: null, form: {} });
test('login.ejs', { error: null });
test('not_found.ejs', { id: 'HW-9999-9999' });
const reg = test('register.ejs', { error: null, result: null, form: { 고유번호: 'HW-2026-0007' }, suggestedId: 'HW-2026-0007' });

// 빈 데이터(필드 누락) 케이스도 검증
const emptyPlant = { 고유번호: 'HW-2026-0002', 품종명: '', 육종가:'', 육종연도:'', 모본:'', 부본:'', DNA마커:'', 사진URL:'', 소유자:'', 소유이력:'', 발급일:'', 관리자메시지:'', 상태:'' };
test('certificate.ejs', { plant: emptyPlant, pageUrl: 'https://x/y' });

// 미리보기 HTML 저장
if (cert) fs.writeFileSync(path.join(__dirname, '_preview_certificate.html'), cert);
if (reg) fs.writeFileSync(path.join(__dirname, '_preview_register.html'), reg);
console.log('미리보기 저장: _preview_certificate.html, _preview_register.html');
