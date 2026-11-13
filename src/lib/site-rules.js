// 텍스트 추출 규칙을 사이트별로 보관한다 (크롬 API 비의존 → tools/test-site-rules.mjs)
//
// storage.local `siteRules` = { [사이트 키]: { rules: [...], combine: {...} } }
//  - 사이트 키는 호스트(포트 포함). 같은 사이트의 모든 페이지가 규칙을 함께 쓴다. file:// 은 "file" 하나로 묶는다.
//  - 사이드 패널은 현재 탭의 사이트 규칙을 보여 주고, 복사 단축키는 규칙이 있는 사이트에서만 동작한다.
//
// 예전(v0.6.0 까지)에는 규칙 묶음이 하나(`current`)뿐이었고 단축키는 `allowedPatterns` 로 허용했다.
// → migrateLegacy() 가 한 번 옮긴다.
export const K_SITE_RULES = "siteRules";

export const DEFAULT_COMBINE = { mode: "join", separator: "space", customSep: "", template: "" };

/** URL → 사이트 키. 규칙을 쓸 수 없는 페이지(chrome:// 등)는 null */
export function siteKeyFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol === "file:") return "file";
  if (u.protocol === "http:" || u.protocol === "https:") return u.host || null;
  return null;
}

/** 저장된 사이트 묶음 → 항상 { rules, combine } 형태 */
export function normalizeSiteState(v) {
  const ok = v && typeof v === "object";
  return {
    rules: ok && Array.isArray(v.rules) ? v.rules : [],
    combine: { ...DEFAULT_COMBINE, ...((ok && v.combine) || {}) },
  };
}

/** siteRules 에 한 사이트를 반영한 새 객체. 규칙이 없으면 항목을 지운다(단축키도 꺼진다) */
export function putSiteState(all, key, state) {
  const next = { ...(all && typeof all === "object" ? all : {}) };
  if (!key) return next;
  if (state && Array.isArray(state.rules) && state.rules.length) {
    next[key] = { rules: state.rules, combine: { ...DEFAULT_COMBINE, ...(state.combine || {}) } };
  } else {
    delete next[key];
  }
  return next;
}

/** 허용 사이트 패턴(예: `https://host/path*`) → 사이트 키. 호스트에 `*` 가 있으면 특정 사이트가 아니라 null */
function keyFromPattern(p) {
  if (typeof p !== "string") return null;
  const m = /^[a-z]+:\/\/([^/]*)/i.exec(p.trim());
  if (!m || m[1].includes("*")) return null;
  return siteKeyFromUrl(p.trim().replace(/\*/g, ""));
}

/**
 * 예전 단일 규칙 묶음(`current`)을 사이트별 저장으로 옮긴다.
 * - 첫 번째 허용 사이트 패턴의 사이트로 넣는다 (예전 단축키가 동작하던 곳).
 * - 사이트를 알 수 없으면 「이전 규칙」 프리셋으로 남겨 어느 사이트에서든 불러올 수 있게 한다.
 * 반환: 바꿀 게 없으면 null, 있으면 storage.local 에 쓸 { siteRules, presets? }
 */
export function migrateLegacy({ siteRules, current, allowedPatterns, presets }, makeId) {
  if (siteRules && typeof siteRules === "object") return null; // 이미 옮김
  const legacy = normalizeSiteState(current);
  const out = { siteRules: {} };
  if (!legacy.rules.length) return out;

  const key = (Array.isArray(allowedPatterns) ? allowedPatterns : []).map(keyFromPattern).find(Boolean);
  if (key) {
    out.siteRules = putSiteState({}, key, legacy);
  } else {
    const list = Array.isArray(presets) ? presets.slice() : [];
    list.push({ id: makeId(), name: "이전 규칙", rules: legacy.rules, combine: legacy.combine });
    out.presets = list;
  }
  return out;
}

/** 저장된 사이트 묶음 전체의 규칙 수 (백업 요약용) */
export function countSiteRules(siteRules) {
  if (!siteRules || typeof siteRules !== "object") return 0;
  return Object.values(siteRules).reduce((n, s) => n + normalizeSiteState(s).rules.length, 0);
}

/** storage.local 에서 예전 데이터를 한 번 옮긴다 (서비스 워커 설치·업데이트 시, 패널 열 때). area = chrome.storage.local */
export async function migrateLegacyStorage(area, makeId) {
  const bag = await area.get([K_SITE_RULES, "current", "allowedPatterns", "presets"]);
  const patch = migrateLegacy(bag, makeId);
  if (patch) await area.set(patch);
}
