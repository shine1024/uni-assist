// 백그라운드 서비스 워커 (ES 모듈)
// 역할:
//  1) 툴바 아이콘 클릭 → 사이드 패널 열기
//  2) 단축키(commands) → 허용 사이트에서만 조합 결과를 추출·복사
import { applyTransforms, combineResults } from "../lib/transform.js";
import { urlMatches } from "../lib/match.js";

const CMD = "copy-combined";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[uni-assist] setPanelBehavior 실패:", err));
});

// ---- 단축키 처리 ---------------------------------------------------------
chrome.commands.onCommand.addListener((command) => {
  if (command === CMD) runCopyCombined();
});

async function runCopyCombined() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  const url = tab.url || "";

  if (!/^(https?|file):/.test(url)) return; // 주입 불가 페이지

  const { allowedPatterns = [], current } = await chrome.storage.local.get([
    "allowedPatterns",
    "current",
  ]);

  // 핵심: 허용된 사이트에서만 동작
  if (!urlMatches(url, allowedPatterns)) return;

  const state = current && Array.isArray(current.rules) ? current : null;
  if (!state || state.rules.length === 0) {
    return flashBadge(tab.id, "✗", "#f43f5e");
  }

  try {
    await ensurePicker(tab.id);
    const descriptors = state.rules.map((r) => ({
      id: r.id,
      selector: r.selector,
      index: r.index,
      source: r.source,
      attrName: r.attrName,
    }));
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "EXTRACT_ALL",
      rules: descriptors,
    });
    const values = (resp && resp.values) || {};
    const missing = (resp && resp.missing) || [];

    const computed = state.rules.map((r) => {
      const raw = values[r.id] != null ? values[r.id] : r.rawText;
      const { result } = applyTransforms(raw, r);
      return { result, enabled: r.enabled };
    });

    const text = combineResults(computed, state.combine);
    await copyToClipboard(text);

    const note = missing.length ? "복사됨 ✓ (일부 요소 못 찾음)" : "복사됨 ✓";
    chrome.tabs.sendMessage(tab.id, { type: "TOAST", text: note }).catch(() => {});
    flashBadge(tab.id, "✓", "#2dd4bf");
  } catch (e) {
    console.error("[uni-assist] 복사 실패:", e);
    chrome.tabs
      .sendMessage(tab.id, { type: "TOAST", text: "복사 실패", kind: "error" })
      .catch(() => {});
    flashBadge(tab.id, "!", "#f43f5e");
  }
}

// ---- 콘텐츠 스크립트 주입 ------------------------------------------------
async function ensurePicker(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/content/picker.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content/picker.js"] });
}

// ---- 오프스크린 문서로 클립보드 복사 -------------------------------------
async function setupOffscreen() {
  const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
  if (has) return;
  try {
    await chrome.offscreen.createDocument({
      url: "src/offscreen/offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: "조합 결과를 클립보드에 복사",
    });
  } catch (e) {
    // 동시 생성 경합 등은 무시 (이미 존재하면 OK)
  }
}

async function copyToClipboard(text) {
  await setupOffscreen();
  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "COPY_TO_CLIPBOARD",
    text,
  });
}

// ---- 아이콘 배지로 결과 표시 ---------------------------------------------
async function flashBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text, tabId });
    setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }).catch(() => {}), 1600);
  } catch (e) {
    /* 탭이 닫혔을 수 있음 */
  }
}
