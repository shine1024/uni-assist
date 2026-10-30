// 콘텐츠 스크립트 — 자동 로그인 전용 (텍스트 추출용 picker.js 와 독립)
// 서비스 워커가 필요한 순간에만, **최상위 프레임에만** 주입한다.
//
// 보안 전제
//  · 주입 전 서비스 워커가 origin을 검증하지만, 주입~입력 사이에 페이지가 이동할 수 있다.
//    → 입력 직전에 콘텐츠 스크립트가 **다시 한 번 location.origin을 확인**한다.
//  · 비밀번호는 콘솔에 출력하지 않고, 입력 후 지역 변수 참조를 끊는다.
//  · iframe 내부 요소는 다루지 않는다(document 범위만 조회).

(() => {
  if (window.__uaAutofillLoaded) return;
  window.__uaAutofillLoaded = true;

  const DEFAULT_TIMEOUT = 8000;
  const BUTTON_ENABLE_WAIT = 2000;

  // ---- 요소 조회 / 대기 --------------------------------------------------
  function qs(selector) {
    try {
      return document.querySelector(selector);
    } catch (_) {
      return null; // 잘못된 셀렉터
    }
  }

  function selectorValid(selector) {
    try {
      document.createDocumentFragment().querySelector(selector);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 동적으로 생성되는 로그인 폼(SPA)을 위해 MutationObserver로 대기 */
  function waitForEl(selector, timeoutMs) {
    const now = qs(selector);
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      let done = false;
      const finish = (el) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(timer);
        resolve(el);
      };
      const obs = new MutationObserver(() => {
        const el = qs(selector);
        if (el) finish(el);
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  function waitEnabled(el, timeoutMs) {
    if (!el.disabled) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(timer);
        resolve(ok);
      };
      const obs = new MutationObserver(() => {
        if (!el.disabled) finish(true);
      });
      obs.observe(el, { attributes: true, attributeFilter: ["disabled", "class", "aria-disabled"] });
      const timer = setTimeout(() => finish(!el.disabled), timeoutMs);
    });
  }

  // ---- 값 입력 (React/Vue 제어 컴포넌트 대응) ----------------------------
  // React는 value를 자체 추적하므로 el.value 직접 대입은 무시될 수 있다.
  // 네이티브 setter를 통해 대입한 뒤 bubbles:true 이벤트를 발생시켜야 상태가 갱신된다.
  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fillField(el, value) {
    try {
      el.focus({ preventScroll: true });
    } catch (_) {
      el.focus();
    }
    setNativeValue(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function clickEl(el) {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
  }

  // ---- 토스트 (picker.css 의 __ua-toast 재사용) --------------------------
  let toastEl = null;
  let toastTimer = null;
  function showToast(text, kind) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "__ua-toast";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.toggle("error", kind === "error");
    void toastEl.offsetWidth;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl && toastEl.classList.remove("show"), 2200);
  }

  // ---- 계정 선택 오버레이 ------------------------------------------------
  // 페이지 DOM에 들어가는 정보이므로 **아이디 평문은 넣지 않는다**(라벨 또는 마스킹된 아이디).
  let chooser = null;
  function closeChooser() {
    if (chooser) {
      chooser.remove();
      chooser = null;
    }
    document.removeEventListener("keydown", onChooserKey, true);
  }
  let chooserResolve = null;
  function chooserItems() {
    return chooser ? Array.from(chooser.querySelectorAll(".__ua-af-item")) : [];
  }
  function onChooserKey(e) {
    if (!chooser) return;
    const items = chooserItems();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finishChoose(null);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const i = items.indexOf(document.activeElement);
      const next = e.key === "ArrowDown" ? i + 1 : i - 1;
      const target = items[(next + items.length) % items.length] || items[0];
      if (target) target.focus();
      return;
    }
    if (/^[1-9]$/.test(e.key)) {
      const target = items[Number(e.key) - 1];
      if (target) {
        e.preventDefault();
        e.stopPropagation();
        target.click();
      }
    }
    // Enter / Space 는 포커스된 버튼이 기본 처리
  }
  function finishChoose(id) {
    const fn = chooserResolve;
    chooserResolve = null;
    closeChooser();
    if (fn) fn(id);
  }

  function chooseAccount(title, items) {
    closeChooser();
    return new Promise((resolve) => {
      chooserResolve = resolve;
      chooser = document.createElement("div");
      chooser.className = "__ua-af-backdrop";
      const box = document.createElement("div");
      box.className = "__ua-af-box";

      const head = document.createElement("div");
      head.className = "__ua-af-head";
      head.textContent = title;
      box.appendChild(head);

      const list = document.createElement("div");
      list.className = "__ua-af-list";
      items.forEach((it, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "__ua-af-item";
        if (i < 9) {
          const num = document.createElement("span");
          num.className = "__ua-af-item-num";
          num.textContent = String(i + 1);
          b.appendChild(num);
        }
        const n = document.createElement("span");
        n.className = "__ua-af-item-name";
        n.textContent = it.label;
        b.appendChild(n);
        if (it.sub) {
          const s = document.createElement("span");
          s.className = "__ua-af-item-sub";
          s.textContent = it.sub;
          b.appendChild(s);
        }
        b.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          finishChoose(it.id);
        });
        list.appendChild(b);
      });
      box.appendChild(list);

      const foot = document.createElement("div");
      foot.className = "__ua-af-foot";
      foot.textContent = "↑↓ 이동 · Enter 선택 · 숫자키 바로 선택 · ESC 취소";
      box.appendChild(foot);

      chooser.appendChild(box);
      chooser.addEventListener("click", (e) => {
        if (e.target === chooser) finishChoose(null);
      });
      document.documentElement.appendChild(chooser);
      document.addEventListener("keydown", onChooserKey, true);
      const first = list.querySelector(".__ua-af-item");
      if (first) first.focus();
    });
  }

  // ---- 자동 로그인 실행 --------------------------------------------------
  async function runFill(msg) {
    // 주입 후 페이지가 이동했을 수 있으므로 origin을 재확인한다.
    if (msg.expectedOrigin && location.origin !== msg.expectedOrigin) {
      return { ok: false, code: "ORIGIN_CHANGED", message: "페이지가 이동해 중단했습니다" };
    }

    const sel = msg.sel || {};
    if (!sel.user || !sel.pass) {
      return { ok: false, code: "NO_SELECTOR", message: "아이디/비밀번호 셀렉터가 비어 있습니다" };
    }
    for (const [k, s] of [
      ["아이디", sel.user],
      ["비밀번호", sel.pass],
      ["로그인 버튼", sel.submit],
    ]) {
      if (s && !selectorValid(s)) {
        return { ok: false, code: "BAD_SELECTOR", message: `${k} 셀렉터가 올바르지 않습니다` };
      }
    }

    const timeout = msg.timeoutMs || DEFAULT_TIMEOUT;
    const userEl = await waitForEl(sel.user, timeout);
    if (!userEl) {
      return {
        ok: false,
        code: "USER_NOT_FOUND",
        message: "아이디 입력창을 찾지 못했습니다 (이미 로그인됐거나 셀렉터가 바뀐 상태일 수 있어요)",
      };
    }
    const passEl = await waitForEl(sel.pass, Math.min(timeout, 3000));
    if (!passEl) {
      return { ok: false, code: "PASS_NOT_FOUND", message: "비밀번호 입력창을 찾지 못했습니다" };
    }

    fillField(userEl, String(msg.username ?? ""));
    fillField(passEl, String(msg.password ?? ""));

    if (!msg.autoSubmit) {
      showToast("아이디/비밀번호 입력 완료 ✓");
      return { ok: true, submitted: false, message: "입력 완료 (버튼 클릭은 꺼져 있음)" };
    }
    if (!sel.submit) {
      showToast("입력 완료 ✓ (버튼 셀렉터 없음)");
      return { ok: true, submitted: false, message: "로그인 버튼 셀렉터가 없어 클릭하지 않았습니다" };
    }

    const btn = await waitForEl(sel.submit, Math.min(timeout, 3000));
    if (!btn) {
      showToast("입력 완료 · 버튼 못 찾음", "error");
      return { ok: true, submitted: false, code: "BTN_NOT_FOUND", message: "로그인 버튼을 찾지 못했습니다" };
    }
    const enabled = await waitEnabled(btn, BUTTON_ENABLE_WAIT);
    if (!enabled) {
      showToast("로그인 버튼이 비활성 상태예요", "error");
      return { ok: true, submitted: false, code: "BTN_DISABLED", message: "로그인 버튼이 비활성 상태입니다" };
    }
    clickEl(btn);
    showToast("자동 로그인 실행 ✓");
    return { ok: true, submitted: true };
  }

  // ---- 로그아웃 ----------------------------------------------------------
  // 로그인 여부는 "로그아웃 요소가 DOM 에 있는지"로 판별한다.
  // (대부분의 사이트는 로그인 상태에서만 로그아웃 링크를 렌더한다)
  // 드롭다운 안에 숨어 있는 로그아웃 링크도 다룰 수 있도록 **표시 여부는 보지 않는다.**
  function detect(sel) {
    const s = sel || {};
    const has = (x) => !!(x && selectorValid(x) && qs(x));
    return {
      origin: location.origin,
      logout: has(s.logout),
      user: has(s.user),
      pass: has(s.pass),
    };
  }

  async function runLogout(msg) {
    if (msg.expectedOrigin && location.origin !== msg.expectedOrigin) {
      return { ok: false, code: "ORIGIN_CHANGED", message: "페이지가 이동해 중단했습니다" };
    }
    const sel = (msg.sel || {}).logout;
    if (!sel) return { ok: false, code: "NO_SELECTOR", message: "로그아웃 셀렉터가 비어 있습니다" };
    if (!selectorValid(sel)) {
      return { ok: false, code: "BAD_SELECTOR", message: "로그아웃 셀렉터가 올바르지 않습니다" };
    }
    const el = qs(sel);
    if (!el) return { ok: false, code: "NOT_FOUND", message: "로그아웃 요소를 찾지 못했습니다" };
    if (el.disabled && !(await waitEnabled(el, BUTTON_ENABLE_WAIT))) {
      return { ok: false, code: "DISABLED", message: "로그아웃 요소가 비활성 상태입니다" };
    }
    clickEl(el);
    showToast("로그아웃 실행 ✓");
    return { ok: true, action: "logout" };
  }

  // ---- 메시지 라우팅 -----------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case "AF_PING":
        sendResponse({ ok: true, origin: location.origin });
        return;
      case "AF_TOAST":
        showToast(msg.text, msg.kind);
        sendResponse({ ok: true });
        return;
      case "AF_CHOOSE": {
        chooseAccount(msg.title || "계정 선택", msg.items || []).then((id) =>
          sendResponse({ ok: true, id })
        );
        return true; // 비동기 응답
      }
      case "AF_DETECT":
        sendResponse({ ok: true, ...detect(msg.sel) });
        return;
      case "AF_LOGOUT": {
        runLogout(msg)
          .then((r) => sendResponse(r))
          .catch((e) => sendResponse({ ok: false, code: "ERROR", message: e.message }));
        return true; // 비동기 응답
      }
      case "AF_FILL": {
        runFill(msg)
          .then((r) => sendResponse(r))
          .catch((e) => sendResponse({ ok: false, code: "ERROR", message: e.message }))
          .finally(() => {
            // 비밀번호 참조 제거
            msg.password = null;
          });
        return true; // 비동기 응답
      }
      default:
        return;
    }
  });
})();
