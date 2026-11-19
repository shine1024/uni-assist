// 콘텐츠 스크립트 — 페이지 내 단축키
//  기본값 Windows 등: F2 = 로그인/로그아웃, F4 = 사이드 패널 열기·닫기, Ctrl+Shift+Y = 추출 결과 복사
//        Mac       : ⌃⌥L / ⌃⌥P / ⌃⌥C  (Mac 의 F키는 fn 없이는 크롬에 오지 않는다 — ../lib/hotkey.js 참고)
//
// 왜 commands API 를 쓰지 않는가: Chrome `commands` 는 단축키에 Ctrl/Alt 를 반드시 포함해야 하고,
// 지원 키 목록에 F1~F12 가 없다(공식 문서). 즉 F2/F4 단독 키는 등록 자체가 불가능하다.
// → 서비스 워커가 chrome.scripting.registerContentScripts() 로 이 스크립트를 심는다.
//
// 패널 토글 주의: chrome.sidePanel.open() 은 **사용자 제스처**를 요구한다.
// 콘텐츠 스크립트의 키 입력은 유효한 제스처이고 메시지에 함께 전달되지만,
// 서비스 워커가 await 를 만나면 사라진다 → SW 쪽에서 동기적으로 호출한다.
//
// 이 스크립트는 ES 모듈이 아니므로 ../lib/hotkey.js 를 import 할 수 없다.
// → `comboFromEvent` / `isTypingTarget` / `needsTypingGuard` / `PLATFORM_DEFAULTS` / `isMacPlatform` /
//   `normalizeHotkey` / `readHotkeys` 를 아래에 복제해 두었다.
//   (tools/test-hotkey.mjs 가 복제본이 lib 와 일치하는지 검사한다 — 한쪽만 고치면 테스트 실패)

(() => {
  // 등록된 스크립트와 설치 직후 기존 탭 주입(service-worker.js)이 겹칠 수 있다.
  // 가장 나중에 심긴 것만 동작하도록 토큰을 덮어쓴다. 확장을 다시 불러온 뒤 남은 예전 리스너도
  // 같은 이유로, 또는 런타임 연결이 끊긴 것을 보고 스스로 물러난다.
  const token = {};
  window.__uaHotkeyLoaded = token;
  const active = () => {
    try {
      return window.__uaHotkeyLoaded === token && !!chrome.runtime.id;
    } catch (_) {
      return false;
    }
  };

  const SETTINGS_KEY = "ua_login_settings";
  const MOD_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "CapsLock", "Dead"]);

  let auth = { combo: "", enabled: false }; // 설정을 읽기 전에는 아무 키도 가로채지 않는다
  let panel = { combo: "", enabled: false };
  let copy = { combo: "", enabled: false };
  const busyUntil = { auth: 0, panel: 0, copy: 0 };
  const COOLDOWN = { auth: 1200, panel: 350, copy: 600 };

  // ---- ../lib/hotkey.js 와 동일해야 하는 부분 ---------------------------
  function comboFromEvent(e) {
    const code = e.code || "";
    const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
    let k = m ? m[1] || m[2] : e.key;
    if (!k || MOD_KEYS.has(k)) return null;
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

  function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  }

  function needsTypingGuard(c) {
    if (!c) return true;
    if (/^(Ctrl|Alt|Meta)\+/.test(c)) return false;
    return (
      !/^F([1-9]|1[0-2])$/.test(c) && !/^(Escape|Insert|Delete|Home|End|PageUp|PageDown)$/.test(c)
    );
  }

  const PLATFORM_DEFAULTS = {
    win: { auth: "F2", panel: "F4", copy: "Ctrl+Shift+Y" },
    mac: { auth: "Ctrl+Alt+L", panel: "Ctrl+Alt+P", copy: "Ctrl+Alt+C" },
  };
  const SETTING_KEYS = { auth: "hotkey", panel: "panelHotkey", copy: "copyHotkey" };

  function isMacPlatform(nav = globalThis.navigator) {
    if (!nav) return false;
    const p = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || "";
    return /mac/i.test(p);
  }

  function normalizeHotkey(h, fallback) {
    const combo = h && typeof h.combo === "string" && h.combo.trim() ? h.combo.trim() : fallback;
    return { combo, enabled: !h || h.enabled !== false };
  }

  function readHotkeys(settings, isMac) {
    const s = settings || {};
    const out = {};
    for (const kind of ["auth", "panel", "copy"]) {
      const key = SETTING_KEYS[kind] + (isMac ? "Mac" : "");
      out[kind] = normalizeHotkey(s[key], PLATFORM_DEFAULTS[isMac ? "mac" : "win"][kind]);
    }
    return out;
  }
  // ---------------------------------------------------------------------

  const IS_MAC = isMacPlatform();

  function applySettings(s) {
    ({ auth, panel, copy } = readHotkeys(s, IS_MAC));
  }

  // 이 리스너는 패널 토글(F4) 때문에 모든 페이지에 심긴다.
  //  - 로그인 단축키는 **등록된 사이트에서만**, 복사 단축키는 **텍스트 추출 규칙이 있는 사이트에서만** 가로채고,
  //    그 외에는 키를 페이지에 그대로 넘긴다. 키 입력 시점에 동기적으로 판단해야 해서 서비스 워커에 미리 물어 둔다.
  //    (규칙은 storage.local 에 있고 콘텐츠 스크립트는 local 을 못 읽는다 — service-worker.js 의 setAccessLevel)
  //  - 성능: 묻는 것은 서비스 워커를 깨우므로 줄인다.
  //    · 두 가지를 **한 번의 메시지**(HOTKEY_TARGETS)로 묻는다
  //    · 보이지 않는 탭(백그라운드로 연 탭, 세션 복원)은 **처음 보일 때까지** 묻지 않는다
  //    · 탭 전환·포커스 때 다시 묻는 것은 TARGET_TTL_MS 에 한 번만 (패널에서 규칙을 막 추가한 경우는
  //      아래 keydown 의 soft 경로가 복사 요청을 보내고 다시 물어서 메운다)
  //    · 로그인·복사 단축키를 둘 다 꺼 두면 아예 묻지 않는다
  const TARGET_TTL_MS = 10000;
  let authTarget = false;
  let copyTarget = false;
  let settingsLoaded = false;
  let askedAt = 0;

  function refreshTargets(force = false) {
    if (!active() || !settingsLoaded) return;
    if (!auth.enabled && !copy.enabled) return;
    if (document.visibilityState !== "visible") return; // 보일 때 visibilitychange 에서 다시 온다
    const now = Date.now();
    if (!force && now - askedAt < TARGET_TTL_MS) return;
    askedAt = now;
    chrome.runtime
      .sendMessage({ type: "HOTKEY_TARGETS" })
      .then((r) => {
        authTarget = !!(r && r.auth);
        copyTarget = !!(r && r.copy);
      })
      .catch(() => {
        authTarget = copyTarget = false;
      });
  }

  window.addEventListener("focus", () => refreshTargets());
  document.addEventListener("visibilitychange", () => refreshTargets());

  chrome.storage.sync.get(SETTINGS_KEY).then((bag) => {
    applySettings(bag[SETTINGS_KEY]);
    settingsLoaded = true;
    refreshTargets(true);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const settingsChanged = !!changes[SETTINGS_KEY];
    if (settingsChanged) applySettings(changes[SETTINGS_KEY].newValue);
    if (settingsChanged || Object.keys(changes).some((k) => k.startsWith("ua_site_") || k === "ua_login_index")) {
      askedAt = 0; // 다음에 보일 때 바로 다시 묻는다
      refreshTargets(true);
    }
  });

  function fire(kind, message) {
    const now = Date.now();
    if (now < busyUntil[kind]) return false;
    busyUntil[kind] = now + COOLDOWN[kind];
    // await 없이 즉시 보낸다 — 패널 토글은 사용자 제스처가 메시지에 함께 전달되어야 한다
    chrome.runtime.sendMessage(message).catch(() => {});
    return true;
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat || !active()) return;
      const combo = comboFromEvent(e);
      if (!combo) return;

      // 규칙을 막 추가해 copyTarget 이 아직 false 여도 복사 요청은 보낸다(규칙이 없으면 워커가 무시).
      // 다만 그때는 키를 가로채지 않아 페이지 동작을 막지 않는다.
      const hit =
        panel.enabled && combo === panel.combo
          ? { kind: "panel", msg: { type: "PANEL_TOGGLE" } }
          : auth.enabled && authTarget && combo === auth.combo
            ? { kind: "auth", msg: { type: "LOGIN_HOTKEY" } }
            : copy.enabled && combo === copy.combo
              ? { kind: "copy", msg: { type: "COPY_HOTKEY" }, soft: !copyTarget }
              : null;
      if (!hit) return;

      // 수정자 없는 일반 키라면 입력 중에는 가로채지 않는다(F2/F4 같은 기능키는 그대로 동작)
      if (needsTypingGuard(combo) && isTypingTarget(e.target)) return;

      if (hit.soft) {
        fire(hit.kind, hit.msg);
        refreshTargets(true);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      fire(hit.kind, hit.msg);
    },
    true // 페이지가 먼저 처리해 버리는 것을 막기 위해 캡처 단계에서 받는다
  );
})();
