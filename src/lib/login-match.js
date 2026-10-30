// 자동 로그인 대상 사이트 매칭 (UI·크롬 API 비의존 → 단독 테스트 가능)
//
// 텍스트 추출의 `match.js`(접두어 + 와일드카드)와 달리, 로그인은 **자격증명을 주입**하므로
// 느슨한 패턴 매칭을 쓰지 않는다. origin(프로토콜+호스트+포트)은 **완전 일치**,
// 경로는 디렉터리 경계를 지키는 접두어 일치만 허용한다.

/** URL → { ok, origin, protocol, host, port, path } */
export function parseTarget(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false };
    return {
      ok: true,
      origin: u.origin, // 기본 포트는 생략된 형태로 정규화됨 (https://a.com:443 → https://a.com)
      protocol: u.protocol,
      host: u.hostname,
      port: u.port || (u.protocol === "https:" ? "443" : "80"),
      path: normalizePath(u.pathname),
    };
  } catch (_) {
    return { ok: false };
  }
}

/** 경로 정규화: 선행 `/` 보장, 끝 `/` 제거(루트는 `/` 유지) */
export function normalizePath(p) {
  let s = String(p || "/");
  if (!s.startsWith("/")) s = "/" + s;
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** 사용자가 입력한 URL → 저장용 { origin, path, matchPath } */
export function describeSiteUrl(url) {
  const t = parseTarget(url);
  if (!t.ok) return null;
  return { origin: t.origin, path: t.path, matchPath: t.path !== "/" };
}

/** 경로 접두어 일치 (디렉터리 경계 존중). `/admin` 은 `/administrator` 와 일치하지 않음 */
export function pathMatches(urlPath, sitePath) {
  const a = normalizePath(urlPath);
  const b = normalizePath(sitePath);
  if (b === "/") return true;
  return a === b || a.startsWith(b + "/");
}

/**
 * 현재 URL이 사이트 등록 정보와 일치하는지.
 * @returns {{ ok:boolean, reason?:string }}
 */
export function siteMatches(url, site) {
  const t = parseTarget(url);
  if (!t.ok) return { ok: false, reason: "지원하지 않는 주소" };
  if (!site || !site.origin) return { ok: false, reason: "사이트 정보 없음" };
  if (t.origin !== site.origin) return { ok: false, reason: "origin 불일치" };
  if (site.matchPath && !pathMatches(t.path, site.path)) {
    return { ok: false, reason: "경로 불일치" };
  }
  return { ok: true };
}

/**
 * HTTPS로 등록된 사이트를 HTTP로 접속한 경우(다운그레이드) 감지.
 * origin이 다르므로 siteMatches는 false가 되지만, 사용자에게 **이유를 알려주기 위해** 따로 판별한다.
 */
export function isDowngrade(url, site) {
  const t = parseTarget(url);
  if (!t.ok || !site || !site.origin) return false;
  const s = parseTarget(site.origin + (site.path || ""));
  if (!s.ok) return false;
  return s.protocol === "https:" && t.protocol === "http:" && s.host === t.host;
}

/**
 * origin 만 일치하는 사이트 (경로는 보지 않음).
 *
 * **로그아웃 전용**: 로그인은 특정 경로(로그인 페이지)에서 하지만, 로그아웃은 로그인 후 이동한
 * 아무 경로에서나 누른다. 경로 일치를 요구하면 "등록되지 않은 사이트"로 보여 로그아웃이 불가능하다.
 * origin(프로토콜+도메인+포트)은 여전히 **완전 일치**해야 하므로, 다른 사이트에 자격증명이
 * 새는 위험은 없다(애초에 로그아웃은 복호화도 하지 않는다).
 */
export function findOriginMatchingSites(url, sites) {
  const t = parseTarget(url);
  if (!t.ok) return [];
  return (Array.isArray(sites) ? sites : [])
    .filter((s) => s && s.origin === t.origin)
    .sort((a, b) => normalizePath(b.path).length - normalizePath(a.path).length);
}

/** 경로가 더 구체적인(긴) 사이트가 먼저 오도록 정렬해 반환 */
export function findMatchingSites(url, sites) {
  const list = Array.isArray(sites) ? sites : [];
  return list
    .filter((s) => siteMatches(url, s).ok)
    .sort((a, b) => normalizePath(b.path).length - normalizePath(a.path).length);
}

/** 현재 URL이 HTTPS 다운그레이드 때문에 막힌 사이트들 */
export function findDowngradedSites(url, sites) {
  const list = Array.isArray(sites) ? sites : [];
  return list.filter((s) => isDowngrade(url, s));
}

// ---- 실행 후보 선정 (순수) -----------------------------------------------

/**
 * 로그아웃을 시도할 수 있는 사이트들 (경로가 구체적인 순서 유지).
 * 실제로 로그인 상태인지는 콘텐츠 스크립트가 DOM 에서 판별한다.
 */
export function logoutCandidates(sites) {
  return (Array.isArray(sites) ? sites : []).filter(
    (s) => s && s.autoLogin !== false && s.autoLogout !== false && s.sel && s.sel.logout
  );
}

/**
 * 로그인에 쓸 (사이트 × 계정) 후보.
 * 기본 계정(defaultAccountId)은 **맨 앞으로 정렬만** 한다 — 선택창을 건너뛰지 않는다.
 * (건너뛰면 2번째 이후 계정을 영원히 쓸 수 없다)
 * @param {object[]} sites  이미 URL 매칭된 사이트들
 * @param {{accountId?:string}} [opts]  특정 계정을 지정하면 그것만
 */
export function accountCandidates(sites, opts = {}) {
  const out = [];
  for (const site of Array.isArray(sites) ? sites : []) {
    if (!site || site.autoLogin === false) continue;
    const accounts = Array.isArray(site.accounts) ? site.accounts : [];
    if (!accounts.length) continue;

    if (opts.accountId) {
      const a = accounts.find((x) => x.id === opts.accountId);
      if (a) out.push({ site, account: a });
      continue;
    }
    const def = accounts.find((x) => x.id === site.defaultAccountId);
    const ordered = def ? [def, ...accounts.filter((a) => a.id !== def.id)] : accounts;
    for (const a of ordered) out.push({ site, account: a });
  }
  return out;
}

// ---- 콘텐츠 스크립트 등록용 매치 패턴 ------------------------------------
// 페이지 내 단축키(F2 등)를 등록된 사이트에만 심기 위해 쓴다.
// 매치 패턴은 포트를 선택적으로 지원하며, 포트를 생략하면 모든 포트에 일치한다(공식 문서).
// 느슨해지는 부분(경로 접두어·포트)은 서비스 워커의 siteMatches() 가 다시 엄격하게 검사한다.

/** @param {object} site @param {{withPort?:boolean}} [opts] */
export function toMatchPattern(site, opts = {}) {
  const withPort = opts.withPort !== false;
  if (!site || !site.origin) return null;
  let origin = site.origin;
  if (!withPort) {
    try {
      const u = new URL(origin);
      origin = u.protocol + "//" + u.hostname;
    } catch (_) {
      return null;
    }
  }
  const p = site.matchPath ? normalizePath(site.path) : "/";
  return p === "/" ? `${origin}/*` : `${origin}${p}*`;
}

/** 자동 로그인이 켜진 사이트들의 매치 패턴 (중복 제거) */
export function toMatchPatterns(sites, opts) {
  const out = [];
  for (const s of Array.isArray(sites) ? sites : []) {
    if (!s || s.autoLogin === false) continue;
    const p = toMatchPattern(s, opts);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** CSS 셀렉터 유효성 검증 (브라우저·Node 공통: Node에는 document가 없으므로 선택적) */
export function isValidSelector(sel) {
  const s = String(sel || "").trim();
  if (!s) return false;
  if (typeof document !== "undefined" && document.createDocumentFragment) {
    try {
      document.createDocumentFragment().querySelector(s);
      return true;
    } catch (_) {
      return false;
    }
  }
  // Node 등 DOM이 없는 환경: 최소 형식 검사만
  return !/[{}]/.test(s);
}
