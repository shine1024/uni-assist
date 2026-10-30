// 페이지 내 단축키 로직 + 콘텐츠 스크립트 등록용 매치 패턴 검증 (node tools/test-hotkey.mjs)
import {
  DEFAULT_COMBO,
  DEFAULT_PANEL_COMBO,
  comboFromEvent,
  displayCombo,
  hotkeyConflict,
  isFunctionCombo,
  isTypingTarget,
  needsTypingGuard,
  normalizeHotkey,
} from "../src/lib/hotkey.js";
import {
  accountCandidates,
  logoutCandidates,
  toMatchPattern,
  toMatchPatterns,
} from "../src/lib/login-match.js";
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}\n      기대: ${e}\n      실제: ${a}`);
  }
}

// keydown 이벤트 흉내
const ev = (key, mods = {}) => ({
  key,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

console.log("hotkey: comboFromEvent");
eq(comboFromEvent(ev("F2")), "F2", "F2 단독");
eq(comboFromEvent(ev("F12")), "F12", "F12 단독");
eq(comboFromEvent(ev("l")), "L", "소문자 키는 대문자로 정규화");
eq(comboFromEvent(ev("L", { shift: true })), "Shift+L", "Shift 조합");
eq(comboFromEvent(ev("2", { ctrl: true, alt: true })), "Ctrl+Alt+2", "수정자 순서 고정");
eq(comboFromEvent(ev("L", { meta: true, ctrl: true })), "Ctrl+Meta+L", "Ctrl→Meta 순서");
eq(comboFromEvent(ev(" ")), "Space", "스페이스는 Space 로");
eq(comboFromEvent(ev("Control", { ctrl: true })), null, "수정자만 누른 상태는 조합 아님");
eq(comboFromEvent(ev("Shift", { shift: true })), null, "Shift 단독도 조합 아님");
// 같은 물리 조합은 항상 같은 문자열 → 저장/비교가 단순해진다
eq(comboFromEvent(ev("F2")) === comboFromEvent(ev("F2")), true, "같은 입력 → 같은 문자열");

console.log("hotkey: normalizeHotkey");
eq(normalizeHotkey(undefined), { combo: "F2", enabled: true }, "기본값 F2 / 사용 ON");
eq(normalizeHotkey({ combo: "  Alt+L  " }), { combo: "Alt+L", enabled: true }, "공백 제거");
eq(normalizeHotkey({ combo: "", enabled: false }), { combo: "F2", enabled: false }, "빈 조합은 기본값으로");
eq(DEFAULT_COMBO, "F2", "로그인/로그아웃 기본 조합은 F2");
eq(DEFAULT_PANEL_COMBO, "F4", "패널 토글 기본 조합은 F4");
eq(normalizeHotkey(undefined, "F4"), { combo: "F4", enabled: true }, "fallback 조합 적용");
eq(normalizeHotkey({ combo: "F9" }, "F4"), { combo: "F9", enabled: true }, "지정된 조합이 fallback보다 우선");

console.log("hotkey: 충돌 판정");
eq(hotkeyConflict({ combo: "F2" }, { combo: "F4" }), false, "다른 키는 충돌 아님");
eq(hotkeyConflict({ combo: "F2" }, { combo: "F2" }), true, "같은 키는 충돌");
eq(hotkeyConflict({ combo: "F2", enabled: false }, { combo: "F2" }), false, "한쪽이 꺼져 있으면 충돌 아님");
eq(hotkeyConflict({ combo: "F2" }, { combo: "F2", enabled: false }), false, "반대쪽이 꺼져도 충돌 아님");

console.log("hotkey: 입력 중 가로채기 가드");
eq(isFunctionCombo("F2"), true, "F2 는 기능키");
eq(isFunctionCombo("F13"), false, "F13 은 범위 밖");
eq(needsTypingGuard("F2"), false, "F2 는 입력창에서도 받는다");
eq(needsTypingGuard("L"), true, "수정자 없는 글자키는 입력 중 무시해야 함");
eq(needsTypingGuard("Alt+L"), false, "Alt 조합은 입력과 충돌 안 함");
eq(needsTypingGuard("Shift+L"), true, "Shift+글자는 여전히 글자 입력이므로 가드 필요");
eq(needsTypingGuard("Insert"), false, "Insert 는 글자 입력이 아님");
eq(isTypingTarget({ tagName: "INPUT" }), true, "input 은 입력 대상");
eq(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true, "contenteditable 은 입력 대상");
eq(isTypingTarget({ tagName: "DIV" }), false, "일반 div 는 아님");
eq(isTypingTarget(null), false, "null 안전");

console.log("hotkey: 표기");
eq(displayCombo("Meta+L", true), "⌘L", "Mac 에서 Meta → ⌘");
eq(displayCombo("Alt+L", true), "⌥L", "Mac 에서 Alt → ⌥");
eq(displayCombo("Alt+L", false), "Alt+L", "그 외는 그대로");

console.log("login-match: 콘텐츠 스크립트 매치 패턴");
const root = { id: "a", origin: "https://a.com", path: "/", matchPath: false };
const scoped = { id: "b", origin: "https://a.com", path: "/admin/login", matchPath: true };
const ported = { id: "c", origin: "https://a.com:8443", path: "/", matchPath: false };
eq(toMatchPattern(root), "https://a.com/*", "origin 범위 → /*");
eq(toMatchPattern(scoped), "https://a.com/admin/login*", "경로 범위 → 경로 접두어");
eq(toMatchPattern(ported), "https://a.com:8443/*", "포트 포함");
eq(toMatchPattern(ported, { withPort: false }), "https://a.com/*", "포트 제거 fallback");
eq(toMatchPattern({ origin: "" }), null, "origin 없으면 null");
eq(
  toMatchPatterns([root, scoped, ported, { ...root, id: "d" }]),
  ["https://a.com/*", "https://a.com/admin/login*", "https://a.com:8443/*"],
  "중복 제거"
);
eq(toMatchPatterns([{ ...root, autoLogin: false }]), [], "자동 로그인 꺼진 사이트는 제외");
eq(toMatchPatterns([]), [], "사이트 없으면 빈 배열 (빈 matches 로는 등록하지 않음)");

// ---- 콘텐츠 스크립트에 복제된 로직이 lib 와 일치하는지 ---------------------
// hotkey.js(콘텐츠 스크립트)는 ES 모듈이 아니어서 lib 를 import 할 수 없고 일부 함수를 복제한다.
// 복제본이 소리 없이 갈라지지 않도록, 파일에서 꺼내 같은 입력으로 비교한다.
console.log("콘텐츠 스크립트 복제본 동기화");
const src = readFileSync(new URL("../src/content/hotkey.js", import.meta.url), "utf-8");
const modLine = src.match(/const MOD_KEYS = new Set\([\s\S]*?\);/)[0];
const start = src.indexOf("// ---- ../lib/hotkey.js");
const end = src.search(/\n\s*\/\/ -{40,}/);
eq(start > 0 && end > start, true, "복제 구간 마커를 찾음");
const dup = new Function(
  `${modLine}\n${src.slice(start, end)}\nreturn { comboFromEvent, isTypingTarget, needsTypingGuard };`
)();

const cases = [ev("F2"), ev("l"), ev("L", { shift: true }), ev("2", { ctrl: true, alt: true }), ev(" "), ev("Control", { ctrl: true })];
eq(
  cases.map((c) => dup.comboFromEvent(c)),
  cases.map((c) => comboFromEvent(c)),
  "comboFromEvent 복제본이 lib 와 동일"
);
eq(
  ["F2", "L", "Alt+L", "Shift+L", "Insert", ""].map((c) => dup.needsTypingGuard(c)),
  ["F2", "L", "Alt+L", "Shift+L", "Insert", ""].map((c) => needsTypingGuard(c)),
  "needsTypingGuard 복제본이 lib 와 동일"
);
eq(
  [{ tagName: "INPUT" }, { tagName: "DIV" }, null].map((t) => dup.isTypingTarget(t)),
  [{ tagName: "INPUT" }, { tagName: "DIV" }, null].map((t) => isTypingTarget(t)),
  "isTypingTarget 복제본이 lib 와 동일"
);

// ---- 실행 후보 선정 -------------------------------------------------------
console.log("login-match: logoutCandidates");
const noLogout = { id: "n", autoLogin: true, sel: { user: "#u", pass: "#p" } };
const withLogout = { id: "w", autoLogin: true, sel: { user: "#u", pass: "#p", logout: "#out" } };
eq(logoutCandidates([noLogout, withLogout]).map((s) => s.id), ["w"], "로그아웃 셀렉터가 있는 사이트만");
eq(logoutCandidates([{ ...withLogout, autoLogout: false }]), [], "autoLogout 꺼짐 → 제외");
eq(logoutCandidates([{ ...withLogout, autoLogin: false }]), [], "사이트 자체가 꺼짐 → 제외");
eq(logoutCandidates([]), [], "사이트 없음");

console.log("login-match: accountCandidates (기본 계정은 '건너뛰기'가 아니라 '맨 앞')");
const a1 = { id: "a1", label: "운영", username: "op" };
const a2 = { id: "a2", label: "테스트", username: "qa" };
const a3 = { id: "a3", label: "관리자", username: "admin" };
const siteOne = { id: "s1", autoLogin: true, accounts: [a1] };
const siteMulti = { id: "s2", autoLogin: true, accounts: [a1, a2, a3], defaultAccountId: "a2" };

eq(accountCandidates([siteOne]).map((c) => c.account.id), ["a1"], "계정 1개 → 후보 1개(선택창 없음)");
// 핵심 회귀: 기본 계정이 지정돼 있어도 다른 계정이 후보에서 빠지지 않아야 한다
eq(
  accountCandidates([siteMulti]).map((c) => c.account.id),
  ["a2", "a1", "a3"],
  "기본 계정이 맨 앞 + 나머지 모두 포함"
);
eq(
  accountCandidates([{ ...siteMulti, defaultAccountId: null }]).map((c) => c.account.id),
  ["a1", "a2", "a3"],
  "기본 계정 미지정 → 등록 순서"
);
eq(
  accountCandidates([{ ...siteMulti, defaultAccountId: "없는id" }]).map((c) => c.account.id),
  ["a1", "a2", "a3"],
  "기본 계정 id가 유효하지 않으면 등록 순서"
);
eq(
  accountCandidates([siteMulti], { accountId: "a3" }).map((c) => c.account.id),
  ["a3"],
  "계정을 지정하면 그것만"
);
eq(accountCandidates([siteMulti], { accountId: "x" }), [], "없는 계정 지정 → 후보 없음");
eq(accountCandidates([{ ...siteMulti, autoLogin: false }]), [], "사이트 꺼짐 → 후보 없음");
eq(accountCandidates([{ id: "s3", autoLogin: true, accounts: [] }]), [], "계정 없는 사이트 → 제외");
eq(
  accountCandidates([siteOne, siteMulti]).map((c) => `${c.site.id}/${c.account.id}`),
  ["s1/a1", "s2/a2", "s2/a1", "s2/a3"],
  "사이트 여러 개면 사이트 순서 유지"
);

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
