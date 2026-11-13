// 오프스크린 문서 — 서비스 워커의 요청을 받아 클립보드에 텍스트를 복사하고, OTP 등록용 QR 이미지를 해석한다.
// (서비스 워커에는 DOM/포커스가 없어 navigator.clipboard 사용이 어려우므로 copy 이벤트 + execCommand 사용)
//
// clearAfterMs: OTP 코드를 복사한 경우 그 시간 뒤 클립보드를 비운다.
//   단, 그 사이 사용자가 다른 것을 복사했으면 건드리지 않는다(읽어서 비교 — clipboardRead 권한).
//   타이머는 이 문서에 둔다(서비스 워커는 30초 유휴 시 종료돼 타이머가 사라질 수 있다).

let clearTimer = null;
let lastCopied = null;

function writeClipboard(text) {
  // copy 이벤트에서 직접 데이터를 넣으면 빈 문자열도 쓸 수 있다(선택 영역 방식은 빈 값 복사가 안 됨)
  const onCopy = (e) => {
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  };
  document.addEventListener("copy", onCopy);
  try {
    return document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", onCopy);
  }
}

function readClipboard() {
  const ta = document.getElementById("ta");
  ta.value = "";
  ta.focus();
  const ok = document.execCommand("paste");
  const text = ta.value;
  ta.value = "";
  return ok ? text : null;
}

function scheduleClear(text, ms) {
  clearTimeout(clearTimer);
  lastCopied = text;
  clearTimer = setTimeout(() => {
    clearTimer = null;
    try {
      const cur = readClipboard();
      if (cur !== null && cur === lastCopied) writeClipboard("");
    } catch (_) {
      /* 읽을 수 없으면 건드리지 않는다 */
    }
    lastCopied = null;
  }, ms);
}

// ---- QR 해석 ------------------------------------------------------------------
// jsQR(257KB)은 처음 스캔할 때만 불러온다. 서비스 워커에 두면 워커가 깰 때마다(페이지 단축키 문의 등) 읽게 된다.
let jsQRPromise = null;
const loadJsQR = () => (jsQRPromise ||= import("../vendor/jsqr.js").then((m) => m.default));

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지를 읽지 못했어요"));
    img.src = dataUrl;
  });
}

async function decodeQr(dataUrl) {
  const [jsQR, img] = await Promise.all([loadJsQR(), loadImage(dataUrl)]);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  try {
    // 원본 크기 → 실패하면 축소해서 다시 (아주 큰 화면에서는 축소본이 더 잘 읽힌다)
    for (const scale of [1, 0.5]) {
      const w = (canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)));
      const h = (canvas.height = Math.max(1, Math.round(img.naturalHeight * scale)));
      ctx.drawImage(img, 0, 0, w, h);
      const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "attemptBoth" });
      if (r && r.data) return r.data;
    }
    return null;
  } finally {
    // 캡처·이미지 내용을 남기지 않는다
    canvas.width = canvas.height = 0;
    img.src = "";
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "DECODE_QR") {
    if (sender.id !== chrome.runtime.id || typeof msg.dataUrl !== "string" || !msg.dataUrl.startsWith("data:image/")) {
      sendResponse({ ok: false });
      return;
    }
    decodeQr(msg.dataUrl)
      .then((text) => sendResponse({ ok: true, text }))
      .catch(() => sendResponse({ ok: false }));
    return true; // 비동기 응답
  }
  if (msg.type !== "COPY_TO_CLIPBOARD") return;
  let ok = false;
  const text = msg.text == null ? "" : String(msg.text);
  try {
    ok = writeClipboard(text);
  } catch (e) {
    ok = false;
  }
  if (ok && msg.clearAfterMs > 0) scheduleClear(text, msg.clearAfterMs);
  else if (ok) {
    // 다른 내용을 복사했으므로 예약된 지우기는 취소
    clearTimeout(clearTimer);
    lastCopied = null;
  }
  sendResponse({ ok });
  return false;
});
