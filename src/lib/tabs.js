// 활성 탭 조회 / 콘텐츠 스크립트 주입 — 텍스트 추출과 자동 로그인이 함께 쓰는 헬퍼

export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** 콘텐츠 스크립트를 주입할 수 있는 페이지인지 (chrome://, 웹스토어 등은 불가) */
export function injectable(url) {
  return /^(https?|file):/.test(url || "");
}

/** 요소 선택/추출용 콘텐츠 스크립트 주입 (중복 주입은 picker.js 내부에서 가드) */
export async function ensurePicker(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/content/picker.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content/picker.js"] });
}
