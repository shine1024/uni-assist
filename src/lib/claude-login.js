// Claude 로그인 인증 — 보안 링크 메일 해석 (크롬 API 비의존 → 단위 테스트 가능)
//
// claude.ai 로그인 때 오는 메일 「Claude의 보안 링크가 도착했습니다」가 슬랙 DM 에 메일 파일로 올라온다.
// 메일의 「로그인」 버튼 링크(https://claude.ai/magic-link#토큰)를 열면 인증 코드가 보이는 페이지가 뜬다.
// 링크는 로그인 열쇠이므로 저장·로그·오류 메시지에 넣지 않는다. 설계: docs/CLAUDE-LOGIN.md
import { decodeEntities } from "./slack-otp.js";

// 화면이나 메일이 바뀌면 이 값만 고친다. (content/claude-auto.js 에 일부 복제 — 테스트가 일치 검사)
export const CLAUDE_LOGIN_CONFIG = {
  titleKeyword: "Claude의 보안 링크가 도착했습니다",
  senderDomain: "mail.anthropic.com",
  linkOrigin: "https://claude.ai",
  linkPath: "/magic-link",
  selectors: {
    codeInput: '[data-step="code"][data-active] input#code',
    submit: 'button[data-testid="continue"]',
    // 사용자 확인: class="data-link-code". 속성으로 붙어 있을 경우도 함께 본다
    linkCode: ".data-link-code, [data-link-code]",
  },
  submitWaitMs: 3000,
  pollIntervalMs: 3000,
  waitMs: 180000,
  lookbackSec: 180,
  // 보안 링크 페이지가 열리고 코드가 나타나기를 기다리는 시간
  linkPageWaitMs: 20000,
  // 링크로 로그인된 뒤 탭을 닫기 전에 잠깐 두는 시간 (세션 정리)
  loginSettleMs: 800,
  matches: ["https://claude.ai/*"],
};

const LINK_RE = /https:\/\/claude\.ai\/magic-link#[^\s"'<>()\[\]]+/g;

// 링크를 찾을 본문 후보 순서. 미리보기(preview*)는 잘려 있을 수 있어 링크 찾기에 쓰지 않는다.
export const LINK_SOURCES = ["raw", "simplified_html", "plain_text"];

/** 보낸 주소에서 도메인만 (진단 표시용). from 은 글자("이름 <주소>") 또는 슬랙 형식 [{ address }] */
export function senderDomain(from) {
  const first = Array.isArray(from) ? from[0] : from;
  const text = first && typeof first === "object" ? first.address || first.original || "" : String(first || "");
  const m = text.match(/@([\w.-]+)/);
  return m ? m[1].toLowerCase() : "";
}

/** 보낸 사람이 Anthropic 메일 도메인인지 (알 수 없으면 true). 회사 메일 전달로 바뀔 수 있어 막는 데는 쓰지 않고 진단에만 쓴다 */
export function senderAllowed(from, domain = CLAUDE_LOGIN_CONFIG.senderDomain) {
  const d = senderDomain(from);
  return !d || d === domain;
}

/** 보안 링크로 열어도 되는 주소인지: https://claude.ai/magic-link#… 만 허용 */
export function isAllowedLink(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.origin === CLAUDE_LOGIN_CONFIG.linkOrigin &&
    !u.username &&
    !u.password &&
    u.pathname === CLAUDE_LOGIN_CONFIG.linkPath &&
    u.hash.length > 1
  );
}

// ---- 메일 원본 해석 ----------------------------------------------------------

function bytesToUtf8(bytes) {
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

export function decodeQuotedPrintable(body) {
  const s = body.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const c = s.charCodeAt(i);
      if (c < 128) bytes.push(c);
      else bytes.push(...new TextEncoder().encode(s[i]));
    }
  }
  return bytesToUtf8(bytes);
}

function decodeBase64(body) {
  try {
    const bin = atob(body.replace(/\s+/g, ""));
    return bytesToUtf8([...bin].map((c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

/** 메일 원본(MIME)이면 quoted-printable·base64 본문을 풀어 붙인다. MIME 이 아니면 그대로. */
export function decodeMime(text) {
  const s = String(text || "");
  if (!/^content-transfer-encoding:/im.test(s)) return s;
  const out = [];
  const re = /content-transfer-encoding:\s*([\w-]+)[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|$)/gi;
  for (const m of s.matchAll(re)) {
    const enc = m[1].toLowerCase();
    if (enc === "quoted-printable") out.push(decodeQuotedPrintable(m[2]));
    else if (enc === "base64") out.push(decodeBase64(m[2]));
    else out.push(m[2]);
  }
  return out.length ? out.join("\n") : s;
}

/** JSON 이면 안의 글자 값을 모두 모은다(필드 이름이 달라도 찾도록). JSON 이 아니면 그대로. */
function expandJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [text];
  }
  const out = [];
  const walk = (v, depth) => {
    if (depth > 6 || out.length > 200) return;
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(data, 0);
  return out.length ? out : [text];
}

/** 글자 하나에서 허용되는 보안 링크들(중복 없이) */
export function linksIn(text) {
  const links = new Set();
  for (const part of expandJson(String(text || ""))) {
    const decoded = decodeEntities(decodeMime(part));
    for (const m of decoded.matchAll(LINK_RE)) if (isAllowedLink(m[0])) links.add(m[0]);
  }
  return links;
}

/**
 * 후보 글자들에서 보안 링크를 찾는다. 앞 후보부터 보고, 링크가 정확히 하나인 첫 후보의 링크를 쓴다.
 * 같은 후보에 서로 다른 링크가 둘 이상이면 고르지 않고 다음 후보를 본다.
 * @param {(string|{name:string,text:string})[]} sources
 */
export function findMagicLink(sources) {
  for (const src of sources || []) {
    const text = src && typeof src === "object" ? src.text : src;
    if (!text) continue;
    const links = linksIn(text);
    if (links.size === 1) return [...links][0];
  }
  return null;
}

/** 진단용 요약 — 링크·본문은 넣지 않고 길이와 개수만 */
export function describeSources(sources) {
  return (sources || []).map(({ name, text }) => ({
    name,
    length: text.length,
    mentions: (text.match(/magic-link/g) || []).length,
    links: linksIn(text).size,
    mime: /^content-transfer-encoding:/im.test(text),
  }));
}

/** 로그인을 마친 뒤의 화면인지 (로그인·링크·로그아웃 화면이 아니면 로그인된 것으로 본다) */
export function isLoggedInPath(pathname) {
  return !/^\/(login|magic-link|logout)(\/|$)/.test(pathname);
}

/** 링크 페이지에서 읽은 글자 → 인증 코드 (공백·하이픈 제거, 숫자 4~10자리만) */
export function normalizeCode(text) {
  const s = String(text || "").replace(/[\s-]/g, "");
  return /^\d{4,10}$/.test(s) ? s : null;
}

/** 진단용: 읽은 글자의 모양만 (숫자/영문/기타 개수) */
export function describeCodeText(text) {
  const s = String(text || "");
  return {
    length: s.length,
    digits: (s.match(/\d/g) || []).length,
    letters: (s.match(/[A-Za-z]/g) || []).length,
    other: (s.match(/[^\dA-Za-z]/g) || []).length,
  };
}
