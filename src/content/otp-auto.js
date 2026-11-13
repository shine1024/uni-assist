// 콘텐츠 스크립트 — 포털 2차 인증 화면 자동 입력 (설정에서 "자동 입력"을 켰을 때만 심긴다)
//
// 인증번호 입력칸이 보이면 서비스 워커에 슬랙 DM 조회를 반복 요청하고, 번호가 오면 넣고 확인을 누른다.
// 슬랙 토큰은 이 스크립트로 오지 않는다. 받는 것은 인증번호뿐이다.
// ES 모듈이 아니어서 ../lib/approval-config.js 를 import 할 수 없다 → 값을 복제해 두었다
// (tools/test-approval-flow.mjs 가 lib 와 일치하는지 검사한다).

(() => {
  // ---- ../lib/approval-config.js 와 같아야 하는 값 ------------------------
  const OTP_INPUT = "input.fid-authPass";
  const OTP_SUBMIT = ".bid-confirm";
  const SUBMIT_WAIT_MS = 3000;
  const POLL_INTERVAL_MS = 3000;
  const WAIT_MS = 180000;
  const LOOKBACK_SEC = 180;
  // -----------------------------------------------------------------------

  if (window.__uaOtpAuto) return;
  window.__uaOtpAuto = true;

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
      const button = visible(OTP_SUBMIT).find((el) => !el.disabled);
      if (button) {
        button.click();
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  let running = false;
  async function run(input) {
    if (running) return;
    running = true;
    const startedAt = Date.now();
    const oldest = Math.floor(startedAt / 1000) - LOOKBACK_SEC;
    toast("슬랙에서 인증번호를 찾는 중…");
    try {
      while (Date.now() - startedAt < WAIT_MS) {
        if (!input.isConnected || input.value) return; // 화면이 바뀌었거나 사용자가 직접 입력
        const r = await chrome.runtime.sendMessage({ type: "OTP_AUTO_FETCH", oldest });
        if (!r || !r.ok) {
          toast((r && r.message) || "인증번호를 가져오지 못했어요", "error", 5000);
          return;
        }
        if (!r.pending) {
          await chrome.runtime.sendMessage({ type: "OTP_AUTO_USED", ts: r.ts }); // 같은 메일 재사용 방지
          const submitted = await fill(input, r.code);
          toast(submitted ? "인증번호를 입력했어요" : "인증번호를 넣었어요 — 확인 버튼을 눌러 주세요", "ok", 4000);
          return;
        }
        await sleep(POLL_INTERVAL_MS);
      }
      toast("3분 안에 인증 메일이 오지 않았어요", "error", 5000);
    } catch (_) {
      toast("확장과 연결이 끊겼어요 — 페이지를 새로고침하세요", "error", 5000);
    } finally {
      running = false;
    }
  }

  function tryStart() {
    const [input] = visible(OTP_INPUT);
    if (input && !input.value) {
      run(input);
      return true;
    }
    return false;
  }

  if (tryStart()) return;
  // 성능: 화면이 자주 바뀌는 페이지에서도 확인은 CHECK_GAP_MS 에 한 번만 한다.
  // (확인할 때 보이는지 재느라 레이아웃 계산이 일어나므로 바뀔 때마다 하면 페이지가 느려질 수 있다)
  // 속성은 보임/숨김에 영향을 주는 것만 본다.
  const CHECK_GAP_MS = 250;
  let pending = null;
  const observer = new MutationObserver(() => {
    if (pending || running) return;
    pending = setTimeout(() => {
      pending = null;
      if (!running && document.querySelector(OTP_INPUT) && tryStart()) observer.disconnect();
    }, CHECK_GAP_MS);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden"],
  });
  setTimeout(() => {
    observer.disconnect(); // 화면이 끝내 안 뜨면 감시를 멈춘다
    clearTimeout(pending);
  }, 10 * 60 * 1000);
})();
