// =============================================================
// lib/messaging.js — 솔라피(Solapi) 알림톡/문자 발송
//  - KAKAO_PFID + ALIMTALK_TEMPLATE_ID 가 모두 있으면 → 알림톡(ATA)
//  - 하나라도 비어 있으면 → 문자(LMS)로 자동 발송
//  - 별도 SDK 없이 솔라피 공식 HTTP API(HMAC-SHA256 인증)를 직접 호출
// =============================================================

const crypto = require('crypto');

const API_HOST = 'https://api.solapi.com';

function requiredEnv() {
  const missing = [];
  if (!process.env.SOLAPI_API_KEY) missing.push('SOLAPI_API_KEY');
  if (!process.env.SOLAPI_API_SECRET) missing.push('SOLAPI_API_SECRET');
  if (!process.env.SENDER_PHONE) missing.push('SENDER_PHONE');
  if (missing.length) {
    throw new Error('환경변수가 비어 있습니다: ' + missing.join(', ') + ' (Railway Variables 확인)');
  }
}

// 솔라피 HMAC-SHA256 인증 헤더 생성
function authHeader() {
  const apiKey = process.env.SOLAPI_API_KEY;
  const apiSecret = process.env.SOLAPI_API_SECRET;
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', apiSecret).update(date + salt).digest('hex');
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

// 전화번호에서 숫자만 남기기 (010-1234-5678 → 01012345678)
function digits(phone) {
  return String(phone || '').replace(/[^0-9]/g, '');
}

// 솔라피로 메시지 1건 발송
async function sendViaSolapi(message) {
  const res = await fetch(API_HOST + '/messages/v4/send', {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.errorMessage || body.message || JSON.stringify(body);
    throw new Error('솔라피 발송 실패: ' + msg);
  }
  return body;
}

// 보증서 링크 발송 (알림톡 우선, 미설정 시 LMS 문자)
//  { to: 받는번호, name: 고객명, url: 보증서 링크 }
async function sendCertificate({ to, name, url }) {
  requiredEnv();

  const pfId = (process.env.KAKAO_PFID || '').trim();
  const templateId = (process.env.ALIMTALK_TEMPLATE_ID || '').trim();
  const varName = process.env.ALIMTALK_VAR_NAME || '#{고객명}';
  const varLink = process.env.ALIMTALK_VAR_LINK || '#{링크}';
  const customerName = (name || '').trim() || '고객';

  const base = {
    to: digits(to),
    from: digits(process.env.SENDER_PHONE),
  };

  // ① 알림톡 (카카오 채널 + 승인 템플릿이 준비된 경우)
  if (pfId && templateId) {
    const variables = {};
    variables[varName] = customerName;
    variables[varLink] = url;
    const message = {
      ...base,
      type: 'ATA',
      kakaoOptions: { pfId, templateId, variables, disableSms: false },
      // 알림톡 실패 시 대체 문자 내용
      text: certificateText(customerName, url),
      subject: '지양하월시아 디지털 보증서',
    };
    await sendViaSolapi(message);
    return { channel: '알림톡' };
  }

  // ② 문자(LMS) — 알림톡 설정 전 기본 발송 수단
  const message = {
    ...base,
    type: 'LMS',
    subject: '지양하월시아 디지털 보증서',
    text: certificateText(customerName, url),
  };
  await sendViaSolapi(message);
  return { channel: '문자(LMS)' };
}

// 문자 본문
function certificateText(name, url) {
  return (
    `[지양하월시아 · 방주 프로젝트]\n\n` +
    `${name}님, 안녕하세요.\n` +
    `소장하신 하월시아의 정품 디지털 보증서가 발급되었습니다.\n\n` +
    `▼ 아래 링크에서 보증서를 확인하세요\n` +
    `${url}\n\n` +
    `귀한 인연에 감사드립니다.\n지양하월시아 드림`
  );
}

module.exports = { sendCertificate };
