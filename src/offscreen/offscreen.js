// 오프스크린 문서 — 서비스 워커의 요청을 받아 클립보드에 텍스트를 복사한다.
// (서비스 워커에는 DOM/포커스가 없어 navigator.clipboard 사용이 어려우므로 textarea+execCommand 사용)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen" || msg.type !== "COPY_TO_CLIPBOARD") return;
  let ok = false;
  try {
    const ta = document.getElementById("ta");
    ta.value = msg.text == null ? "" : String(msg.text);
    ta.focus();
    ta.select();
    ok = document.execCommand("copy");
    ta.value = "";
  } catch (e) {
    ok = false;
  }
  sendResponse({ ok });
  return false;
});
