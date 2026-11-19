// 페이지 내 단축키 — 키 조합 표현/비교 순수 로직 (UI·크롬 API 비의존 → 단독 테스트 가능)
//
// 왜 필요한가: Chrome `commands` API 는 단축키에 **Ctrl 또는 Alt 를 반드시 포함**해야 하고
// 지원 키 목록에 **F1~F12 가 없다**(공식 문서 확인). 그래서 `F2` 같은 단일 기능키는
// commands 로 등록할 수 없고, 등록된 사이트의 페이지에 키 리스너를 심어서 처리한다.
//
// 조합은 "Alt+Shift+L", "F2" 같은 **정규화된 문자열 하나**로 저장한다.
//
// 운영체제별 단축키: 설정은 storage.sync 로 모든 PC 가 공유하지만 단축키만은 **Mac 과 그 외를 따로** 둔다.
//  · Mac 키보드의 F1~F12 는 기본이 밝기·Mission Control 같은 시스템 키라 fn 없이는 크롬에 오지 않는다
//  · 한 PC 에서 바꾼 키가 다른 운영체제 PC 의 키까지 바꾸면 안 된다
//  → 윈도우 등은 기존 키(hotkey / panelHotkey / copyHotkey), Mac 은 뒤에 "Mac" 을 붙인 키에 저장한다.
//
// 콘텐츠 스크립트(src/content/hotkey.js)는 ES 모듈이 아니어서 이 파일을 import 할 수 없으므로
// `comboFromEvent` / `isTypingTarget` / `needsTypingGuard` / `PLATFORM_DEFAULTS` / `isMacPlatform` /
// `readHotkeys` 를 그쪽에 복제해 두었다. 바꿀 때 양쪽을 함께 수정 (tools/test-hotkey.mjs 가 비교한다).

export const DEFAULT_COMBO = "F2"; // 로그인 / 로그아웃
export const DEFAULT_PANEL_COMBO = "F4"; // 사이드 패널 열기·닫기
export const DEFAULT_COPY_COMBO = "Ctrl+Shift+Y"; // 텍스트 추출 결과 복사 (규칙이 있는 사이트에서만)
export const DEFAULT_HOTKEY = { combo: DEFAULT_COMBO, enabled: true };
export const DEFAULT_PANEL_HOTKEY = { combo: DEFAULT_PANEL_COMBO, enabled: true };
export const DEFAULT_COPY_HOTKEY = { combo: DEFAULT_COPY_COMBO, enabled: true };

export const HOTKEY_KINDS = ["auth", "panel", "copy"];

// Mac 기본값은 Control+Option 조합 — macOS·크롬 기본 단축키는 ⌘ 위주라 ⌃⌥ 는 거의 비어 있다
export const PLATFORM_DEFAULTS = {
  win: { auth: "F2", panel: "F4", copy: "Ctrl+Shift+Y" },
  mac: { auth: "Ctrl+Alt+L", panel: "Ctrl+Alt+P", copy: "Ctrl+Alt+C" },
};
const SETTING_KEYS = { auth: "hotkey", panel: "panelHotkey", copy: "copyHotkey" };

/** 설정 객체에서 이 단축키가 저장되는 키 이름 */
export function hotkeySettingKey(kind, isMac) {
  return SETTING_KEYS[kind] + (isMac ? "Mac" : "");
}

export function defaultCombo(kind, isMac) {
  return PLATFORM_DEFAULTS[isMac ? "mac" : "win"][kind];
}

/** navigator(페이지·워커 공통)로 Mac 인지 판단 */
export function isMacPlatform(nav = globalThis.navigator) {
  if (!nav) return false;
  const p = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || "";
  return /mac/i.test(p);
}

/** 설정에서 이 운영체제의 단축키 세 가지를 꺼낸다 */
export function readHotkeys(settings, isMac) {
  const s = settings || {};
  const out = {};
  for (const kind of HOTKEY_KINDS) {
    out[kind] = normalizeHotkey(s[hotkeySettingKey(kind, isMac)], defaultCombo(kind, isMac));
  }
  return out;
}

const MOD_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "CapsLock", "Dead"]);

/**
 * 누른 키 → 조합 문자열. 수정자 순서를 고정해 같은 조합이 항상 같은 문자열이 되게 한다.
 * 글자·숫자는 `e.code`(물리 키)로 읽는다. `e.key` 는 입력될 **문자**라서
 *  · Mac 에서 Option 을 누르면 `¬`·`˙` 같은 특수문자(또는 "Dead")가 오고
 *  · 한글 입력 상태에서는 `ㅣ`, 조합 중에는 "Process" 가 온다 → 단축키가 맞지 않게 된다.
 */
export function comboFromEvent(e) {
  const code = e.code || "";
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
  let k = m ? m[1] || m[2] : e.key;
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
  return x.enabled && y.enabled && x.combo === y.combo; // 호출자는 readHotkeys 로 정규화한 값을 넘긴다
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

/** 사람이 읽는 표기 (Mac 은 ⌃⌥⇧⌘ 기호를 붙여 쓴다: Ctrl+Alt+L → ⌃⌥L) */
const MAC_SYMBOLS = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };
export function displayCombo(combo, isMac) {
  const c = String(combo || "");
  if (!isMac) return c;
  const m = /^((?:(?:Ctrl|Alt|Shift|Meta)\+)*)(.+)$/.exec(c);
  if (!m) return c;
  return m[1].split("+").filter(Boolean).map((p) => MAC_SYMBOLS[p]).join("") + m[2];
}
