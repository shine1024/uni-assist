// 콘텐츠 스크립트 — claude.ai 로그인 인증 코드 자동 입력 (「Claude 로그인 인증」에서 자동 입력을 켰을 때만 심긴다)
//
// 인증 코드 입력 단계가 보이면 서비스 워커에 조회를 반복 요청한다. 서비스 워커가 슬랙 DM 의 보안 링크를
// 숨긴 탭으로 열어 코드를 읽어 오면, 코드를 넣고 「이메일 주소 확인」을 누른다.
// 이 스크립트가 받는 것은 코드뿐이다(슬랙 토큰·보안 링크는 오지 않는다).
// ES 모듈이 아니어서 ../lib/claude-login.js 를 import 할 수 없다 → 값을 복제해 두었다
// (tools/test-claude-login.mjs 가 lib 와 일치하는지 검사한다).

(() => {
  // ---- ../lib/claude-login.js 의 CLAUDE_LOGIN_CONFIG 와 같아야 하는 값 ------
  const CODE_INPUT = '[data-step="code"][data-active] input#code';
  const SUBMIT = 'button[data-testid="continue"]';
  const SUBMIT_WAIT_MS = 3000;
  const POLL_INTERVAL_MS = 3000;
  const WAIT_MS = 180000;
  const LOOKBACK_SEC = 180;
  const LINK_PATH = "/magic-link";
  // -----------------------------------------------------------------------

  if (window.__uaClaudeAuto) return;
  window.__uaClaudeAuto = true;
  if (location.pathname === LINK_PATH) return; // 확장이 연 보안 링크 탭 — 여기서는 아무것도 안 한다

  const visible = (selector) =>
    [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let toastEl = null;
  let toastTimer = null;
  function toast(text, kind = "ok", ms = 0) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "__ua-toast";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.toggle("error", kind === "error");
    requestAnimationFrame(() => toastEl.classList.add("show"));
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => toastEl && toastEl.classList.remove("show"), ms);
  }

  async function fill(input, code) {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, code);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const deadline = Date.now() + SUBMIT_WAIT_MS;
    while (Date.now() < deadline) {
      const button = visible(SUBMIT).find((el) => !el.disabled);
      if (button) {
        button.click();
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  const hideToast = () => toastEl && toastEl.classList.remove("show");

  let running = false;
  // 한 번 끝난(성공·실패·시간 초과) 입력칸에는 다시 시작하지 않는다 — 코드 단계가 사라졌다 다시 보이면 새로 시작
  let doneFor = null;
  async function run(input) {
    if (running) return;
    running = true;
    const startedAt = Date.now();
    const oldest = Math.floor(startedAt / 1000) - LOOKBACK_SEC;
    toast("슬랙에서 Claude 보안 링크 메일을 찾는 중…");
    try {
      while (Date.now() - startedAt < WAIT_MS) {
        // 화면이 바뀌었거나(로그인 완료·이메일 변경) 사용자가 직접 입력했으면 멈춘다
        if (!input.isConnected || input.getClientRects().length === 0 || input.value) {
          hideToast();
          return;
        }
        const r = await chrome.runtime.sendMessage({ type: "CLAUDE_AUTO_FETCH", oldest });
        if (!r || !r.ok) {
          toast((r && r.message) || "인증 코드를 가져오지 못했어요", "error", 8000);
          return;
        }
        if (r.loggedIn) {
          // 링크를 여는 것만으로 로그인됐다 — 서비스 워커가 이 탭을 새로고침한다
          toast("보안 링크로 로그인했어요", "ok", 4000);
          return;
        }
        if (!r.pending) {
          if (input.value) return;
          const submitted = await fill(input, r.code);
          toast(submitted ? "인증 코드를 입력했어요" : "인증 코드를 넣었어요 — 「이메일 주소 확인」을 눌러 주세요", "ok", 4000);
          return;
        }
        await sleep(POLL_INTERVAL_MS);
      }
      toast("3분 안에 보안 링크 메일이 오지 않았어요", "error", 5000);
    } catch (_) {
      toast("확장과 연결이 끊겼어요 — 페이지를 새로고침하세요", "error", 5000);
    } finally {
      running = false;
      doneFor = input;
    }
  }

  function tryStart() {
    if (doneFor && (!doneFor.isConnected || doneFor.getClientRects().length === 0)) doneFor = null;
    const [input] = visible(CODE_INPUT);
    if (input && !input.value && input !== doneFor) {
      run(input);
      return true;
    }
    return false;
  }

  // 로그인 화면은 한 페이지 안에서 단계(이메일 → 코드)가 바뀐다. 코드 단계가 보일 때마다 시작한다.
  // 성능: 확인은 CHECK_GAP_MS 에 한 번만, 속성은 보임/단계에 영향을 주는 것만 본다.
  const CHECK_GAP_MS = 250;
  let pending = null;
  const observer = new MutationObserver(() => {
    if (pending || running) return;
    pending = setTimeout(() => {
      pending = null;
      if (!running) tryStart();
    }, CHECK_GAP_MS);
  });
  tryStart();
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden", "data-active"],
  });
  setTimeout(() => {
    observer.disconnect(); // 30분 동안 로그인하지 않으면 감시를 멈춘다
    clearTimeout(pending);
  }, 30 * 60 * 1000);
})();
