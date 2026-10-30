// 페이지 내 단축키 — 키 조합 표현/비교 순수 로직 (UI·크롬 API 비의존 → 단독 테스트 가능)
//
// 왜 필요한가: Chrome `commands` API 는 단축키에 **Ctrl 또는 Alt 를 반드시 포함**해야 하고
// 지원 키 목록에 **F1~F12 가 없다**(공식 문서 확인). 그래서 `F2` 같은 단일 기능키는
// commands 로 등록할 수 없고, 등록된 사이트의 페이지에 키 리스너를 심어서 처리한다.
//
// 조합은 "Alt+Shift+L", "F2" 같은 **정규화된 문자열 하나**로 저장한다.
// 콘텐츠 스크립트(src/content/hotkey.js)는 ES 모듈이 아니어서 이 파일을 import 할 수 없으므로
// `comboFromEvent` / `isTypingTarget` 두 함수만 그쪽에 복제해 두었다. 바꿀 때 양쪽을 함께 수정.

export const DEFAULT_COMBO = "F2"; // 로그인 / 로그아웃
export const DEFAULT_PANEL_COMBO = "F4"; // 사이드 패널 열기·닫기
export const DEFAULT_HOTKEY = { combo: DEFAULT_COMBO, enabled: true };
export const DEFAULT_PANEL_HOTKEY = { combo: DEFAULT_PANEL_COMBO, enabled: true };

const MOD_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "CapsLock", "Dead"]);

/** 수정자 순서를 고정해 같은 조합이 항상 같은 문자열이 되게 한다 */
export function comboFromEvent(e) {
  let k = e.key;
  if (!k || MOD_KEYS.has(k)) return null; // 수정자만 누른 상태는 조합이 아니다
  if (k === " ") k = "Space";
  else if (k.length === 1) k = k.toUpperCase();
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(k);
  return parts.join("+");
}

export function normalizeHotkey(h, fallback = DEFAULT_COMBO) {
  const combo = h && typeof h.combo === "string" && h.combo.trim() ? h.combo.trim() : fallback;
  return { combo, enabled: !h || h.enabled !== false };
}

/** 두 단축키가 같은 조합이면 충돌 (한쪽이 꺼져 있으면 충돌 아님) */
export function hotkeyConflict(a, b) {
  const x = normalizeHotkey(a);
  const y = normalizeHotkey(b, DEFAULT_PANEL_COMBO);
  return x.enabled && y.enabled && x.combo === y.combo;
}

/** F1~F12 단독 조합인지 (입력창에 포커스가 있어도 안전하게 받을 수 있는 키) */
export function isFunctionCombo(combo) {
  return /^F([1-9]|1[0-2])$/.test(String(combo || ""));
}

/** 수정자 없는 일반 키 조합인지 (입력 중에 가로채면 글자를 못 치게 되는 조합) */
export function needsTypingGuard(combo) {
  const c = String(combo || "");
  if (!c) return true;
  if (/^(Ctrl|Alt|Meta)\+/.test(c)) return false; // 수정자가 있으면 입력과 충돌하지 않는다
  return !isFunctionCombo(c) && !/^(Escape|Insert|Delete|Home|End|PageUp|PageDown)$/.test(c);
}

/** 글자를 입력 중인 요소인지 */
export function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** 사람이 읽는 표기 (Mac 은 Meta → ⌘) */
export function displayCombo(combo, isMac) {
  const c = String(combo || "");
  return isMac ? c.replace(/\bMeta\+/g, "⌘").replace(/\bAlt\+/g, "⌥") : c;
}
