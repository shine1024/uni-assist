// 백그라운드 서비스 워커 (ES 모듈)
// 역할:
//  1) 툴바 아이콘 클릭 → 사이드 패널 열기
//  2) 단축키(commands) → 허용 사이트에서만 조합 결과를 추출·복사
//  3) 단축키 → 등록된 사이트에서 자동 로그인 / 로그인 상태면 로그아웃
//  4) 단축키 → 사이드 패널 열기·닫기 (페이지 내 단축키, 기본 F4)
import { applyTransforms, combineResults } from "../lib/transform.js";
import { urlMatches } from "../lib/match.js";
import { decryptString, secretMatchesKey } from "../lib/crypto.js";
import {
  accountCandidates,
  findDowngradedSites,
  findMatchingSites,
  findOriginMatchingSites,
  isLoginHotkeyTarget,
  logoutCandidates,
  toMatchPatterns,
} from "../lib/login-match.js";
import { getSettings, loadSites } from "../lib/login-store.js";
import * as vault from "../lib/vault.js";
import { isExtensionPage } from "../lib/approval-flow.js";
import {
  K_SLACK,
  approvalStatus,
  disconnectSlack,
  fetchApprovalOtp,
  fillOtpInActiveTab,
  isAutoFillSender,
  markApprovalOtpUsed,
  setAutoFill,
  syncAutoFillRegistration,
} from "./approval.js";

const CMD = "copy-combined";
const CMD_LOGIN = "auto-login";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[uni-assist] setPanelBehavior 실패:", err));
  // 등록한 콘텐츠 스크립트는 이후 새로 열리는 페이지에만 들어간다.
  // 설치·업데이트·다시 불러오기 직후에도 이미 열린 탭에서 F2/F4 가 바로 되도록 직접 심는다.
  syncHotkeyRegistration().then(injectHotkeyIntoOpenTabs);
  syncAutoFillRegistration();
});

chrome.runtime.onStartup.addListener(() => syncHotkeyRegistration());

// 슬랙 토큰이 storage.local 에 있으므로 콘텐츠 스크립트는 local 을 읽지 못하게 한다(콘텐츠 스크립트는 local 을 쓰지 않는다).
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});

// 슬랙 연결·자동 입력 설정이 바뀌면 포털 자동 입력 등록을 맞춘다
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[K_SLACK]) syncAutoFillRegistration();
});

// ---- 단축키 처리 ---------------------------------------------------------
chrome.commands.onCommand.addListener((command) => {
  if (command === CMD) runCopyCombined();
  else if (command === CMD_LOGIN) runAutoLogin();
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

// ==========================================================================
// 자동 로그인 (독립 모듈 — 위의 텍스트 추출 흐름과 상태를 공유하지 않는다)
// ==========================================================================

const AF_TIMEOUT_MS = 8000;

/** 자동 로그인 전용 콘텐츠 스크립트를 **최상위 프레임에만** 주입 (iframe 제외) */
async function ensureAutofill(tabId) {
  const target = { tabId, frameIds: [0] };
  // picker.css: 페이지 토스트(.__ua-toast) 스타일을 재사용한다
  await chrome.scripting.insertCSS({
    target,
    files: ["src/content/picker.css", "src/content/autofill.css"],
  });
  await chrome.scripting.executeScript({ target, files: ["src/content/autofill.js"] });
}

async function afSend(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
}

async function afToast(tabId, text, kind) {
  try {
    await ensureAutofill(tabId);
    await afSend(tabId, { type: "AF_TOAST", text, kind });
  } catch (_) {
    /* 주입 불가 페이지 */
  }
}

/** 아이디를 페이지 DOM에 그대로 넣지 않기 위한 마스킹 */
function maskUser(u) {
  const s = String(u || "");
  if (!s) return "(아이디 없음)";
  if (s.length <= 2) return s[0] + "*";
  return s.slice(0, 2) + "*".repeat(Math.min(6, s.length - 2));
}

/**
 * 단축키 / 패널의 테스트 버튼에서 호출.
 * @param {{siteId?:string, accountId?:string, tabId?:number}} [opts]
 */
/**
 * 단축키(F2) / 패널의 ▶ 버튼에서 호출. **로그인과 로그아웃을 모두 처리한다.**
 *
 * 판정 순서
 *   1) 로그아웃 요소가 페이지에 있으면 → 로그아웃 (복호화가 필요 없으므로 **잠겨 있어도 동작**)
 *   2) 아니면 → 자동 로그인 (잠금 해제 필요)
 *
 * @param {{siteId?:string, accountId?:string, tabId?:number}} [opts]
 */
async function runAutoLogin(opts = {}) {
  let tab;
  if (opts.tabId) {
    tab = await chrome.tabs.get(opts.tabId).catch(() => null);
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab || !tab.id) return { ok: false, message: "활성 탭을 찾을 수 없습니다" };

  const url = tab.url || "";
  if (!/^https?:/.test(url)) {
    return { ok: false, message: "http(s) 페이지에서만 동작합니다" };
  }

  if (!(await vault.acquireRunLock())) {
    return { ok: false, message: "이미 실행 중입니다" };
  }

  try {
    const sites = await loadSites();
    if (!sites.length) {
      await afToast(tab.id, "등록된 사이트가 없어요 — 사이드 패널에서 추가하세요", "error");
      return { ok: false, message: "등록된 사이트가 없습니다" };
    }

    const byId = (list) => (opts.siteId ? list.filter((s) => s.id === opts.siteId) : list);
    const enabled = (list) => list.filter((s) => s.autoLogin !== false);

    // 로그인: origin + 경로까지 엄격하게 (로그인 페이지를 경로로 구분할 수 있어야 하므로)
    const matches = enabled(byId(findMatchingSites(url, sites)));
    // 로그아웃: origin 만 일치하면 된다 — 로그인한 경로와 로그아웃하는 경로는 보통 다르다
    const originMatches = enabled(byId(findOriginMatchingSites(url, sites)));

    if (!matches.length && !originMatches.length) {
      const blocked = findDowngradedSites(url, sites);
      if (blocked.length) {
        const msg = "HTTPS로 등록된 사이트인데 HTTP로 접속했어요 — 보안상 중단합니다";
        await afToast(tab.id, msg, "error");
        flashBadge(tab.id, "!", "#f43f5e");
        return { ok: false, code: "DOWNGRADE", message: msg };
      }
      const msg = opts.siteId
        ? "현재 탭이 이 사이트의 주소와 일치하지 않습니다"
        : "등록된 사이트가 아니에요";
      await afToast(tab.id, msg, "error");
      return { ok: false, code: "NO_MATCH", message: msg };
    }

    await ensureAutofill(tab.id);

    // ---- 1) 로그인 상태면 로그아웃 (잠금 해제 불필요) --------------------
    let sawLoginForm = false;
    for (const site of logoutCandidates(originMatches)) {
      const d = await afSend(tab.id, { type: "AF_DETECT", sel: site.sel }).catch(() => null);
      if (!d) continue;
      if (d.user || d.pass) sawLoginForm = true;
      if (!d.logout) continue;

      const r = await afSend(tab.id, {
        type: "AF_LOGOUT",
        expectedOrigin: site.origin,
        sel: site.sel,
      }).catch((e) => ({ ok: false, message: e.message }));

      if (r && r.ok) {
        flashBadge(tab.id, "⇥", "#f59e0b");
      } else {
        await afToast(tab.id, (r && r.message) || "로그아웃 실패", "error");
        flashBadge(tab.id, "!", "#f43f5e");
      }
      return r || { ok: false, message: "응답이 없습니다" };
    }

    // ---- 2) 자동 로그인 ---------------------------------------------------
    if (!matches.length) {
      // origin 은 맞는데 경로가 달라 로그인 대상에서 빠진 경우 — 원인을 알려준다
      const scoped = originMatches.find((s) => s.matchPath);
      const msg = scoped
        ? `이 사이트는 경로 ${scoped.path} 에서만 로그인하도록 등록돼 있어요 (설정에서 '경로까지 일치'를 끄거나 URL을 고치세요)`
        : "등록된 사이트가 아니에요";
      await afToast(tab.id, msg, "error");
      return { ok: false, code: "PATH_MISMATCH", message: msg };
    }

    const candidates = accountCandidates(matches, { accountId: opts.accountId });
    if (!candidates.length) {
      const msg = "이 사이트에 등록된 계정이 없어요";
      await afToast(tab.id, msg, "error");
      return { ok: false, code: "NO_ACCOUNT", message: msg };
    }

    // 잠금 상태면 복호화 자체가 불가 → 사이드 패널에서 잠금 해제 요청
    const key = await vault.getUnlockedKey();
    if (!key) {
      await vault.setPending(tab.id, url);
      let opened = false;
      try {
        await chrome.sidePanel.open({ tabId: tab.id });
        opened = true;
      } catch (_) {
        /* 사용자 제스처 요구/미지원 → 안내로 대체 */
      }
      const msg = opened
        ? "마스터 비밀번호를 입력하면 이어서 로그인해요"
        : "사이드 패널을 열고 마스터 비밀번호를 입력하세요";
      await afToast(tab.id, msg, "error");
      flashBadge(tab.id, "🔒", "#f59e0b");
      return { ok: false, code: "LOCKED", message: msg };
    }

    // 후보가 둘 이상이면 **항상** 페이지 안에서 계정을 고르게 한다.
    // (기본 계정은 맨 앞 정렬·포커스만 담당 — 선택창을 건너뛰면 다른 계정을 쓸 수 없다)
    let chosen = candidates[0];
    if (candidates.length > 1) {
      const multiSite = new Set(candidates.map((c) => c.site.id)).size > 1;
      const items = candidates.map((c, i) => ({
        id: String(i),
        label: c.account.label || maskUser(c.account.username),
        sub: multiSite ? c.site.name || c.site.origin : "",
      }));
      const resp = await afSend(tab.id, {
        type: "AF_CHOOSE",
        title: "자동 로그인할 계정을 선택하세요",
        items,
      }).catch(() => null);
      if (!resp || resp.id == null) {
        return { ok: false, code: "CANCELLED", message: "취소했습니다" };
      }
      chosen = candidates[Number(resp.id)] || candidates[0];
    }

    const { site, account } = chosen;
    if (!account.secret) {
      const msg = "이 계정에 비밀번호가 등록되지 않았어요";
      await afToast(tab.id, msg, "error");
      return { ok: false, code: "NO_SECRET", message: msg };
    }

    let password;
    try {
      password = await decryptString(key, account.secret);
    } catch (_) {
      // 키 지문이 다르면 "다른 마스터 비밀번호로 암호화된 데이터"라고 원인을 짚어준다
      const sameKey = await secretMatchesKey(key, account.secret).catch(() => true);
      const msg = sameKey
        ? "비밀번호 복호화에 실패했어요 (저장된 데이터가 손상됐을 수 있어요)"
        : "이 비밀번호는 다른 마스터 비밀번호로 암호화됐어요 — 그 비밀번호로 잠금 해제하거나 비밀번호를 다시 저장하세요";
      await afToast(tab.id, msg, "error");
      flashBadge(tab.id, "!", "#f43f5e");
      return { ok: false, code: sameKey ? "DECRYPT_FAILED" : "KEY_MISMATCH", message: msg };
    }

    const r = await afSend(tab.id, {
      type: "AF_FILL",
      expectedOrigin: site.origin,
      sel: site.sel,
      username: account.username,
      password,
      autoSubmit: site.autoSubmit !== false,
      timeoutMs: AF_TIMEOUT_MS,
    }).catch((e) => ({ ok: false, message: e.message }));
    password = null;

    if (r && r.ok) {
      await vault.touchUnlock(); // 활동 기반 자동 잠금 연장
      flashBadge(tab.id, "✓", "#2dd4bf");
    } else {
      let msg = (r && r.message) || "자동 로그인 실패";
      // 로그아웃 셀렉터는 등록됐는데 둘 다 못 찾은 경우를 구분해 안내
      if (r && r.code === "USER_NOT_FOUND" && logoutCandidates(originMatches).length && !sawLoginForm) {
        msg = "로그인 입력창도, 로그아웃 요소도 찾지 못했어요 (셀렉터가 바뀌었을 수 있어요)";
      }
      await afToast(tab.id, msg, "error");
      flashBadge(tab.id, "!", "#f43f5e");
    }
    return r || { ok: false, message: "응답이 없습니다" };
  } catch (e) {
    await afToast(tab.id, "실행 실패: " + e.message, "error");
    flashBadge(tab.id, "!", "#f43f5e");
    return { ok: false, message: e.message };
  } finally {
    await vault.releaseRunLock();
  }
}

// ---- 사이드 패널 ↔ 서비스 워커 ------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  const approvalAction = {
    APPROVAL_STATUS: approvalStatus,
    APPROVAL_FETCH_OTP: () => fetchApprovalOtp(msg.oldest),
    APPROVAL_MARK_USED: () => markApprovalOtpUsed(msg.ts),
    APPROVAL_FILL_OTP: () => fillOtpInActiveTab(msg.code),
    APPROVAL_DISCONNECT: disconnectSlack,
    APPROVAL_SET_AUTOFILL: () => setAutoFill(msg.on),
  }[msg.type];
  if (approvalAction) {
    // 인증번호를 다루므로 웹페이지에 주입된 스크립트에서는 호출할 수 없게 한다.
    if (!isExtensionPage(sender, chrome.runtime.id)) return;
    approvalAction().then(sendResponse);
    return true;
  }
  const autoAction = {
    OTP_AUTO_FETCH: () => fetchApprovalOtp(msg.oldest),
    OTP_AUTO_USED: () => markApprovalOtpUsed(msg.ts),
  }[msg.type];
  if (autoAction) {
    // 포털 자동 입력 스크립트 — 자동 입력이 켜져 있고 포털 페이지일 때만 응답한다
    isAutoFillSender(sender).then((allowed) =>
      allowed ? autoAction().then(sendResponse) : sendResponse({ ok: false, code: "BAD_REQUEST" })
    );
    return true;
  }
  if (msg.type === "LOGIN_RUN") {
    runAutoLogin({ siteId: msg.siteId, accountId: msg.accountId, tabId: msg.tabId }).then(
      sendResponse
    );
    return true; // 비동기 응답
  }
  if (msg.type === "LOGIN_RETRY_PENDING") {
    vault.takePending().then(async (p) => {
      if (!p) return sendResponse({ ok: false, code: "NO_PENDING" });
      const tab = await chrome.tabs.get(p.tabId).catch(() => null);
      if (!tab || tab.url !== p.url) return sendResponse({ ok: false, code: "TAB_CHANGED" });
      sendResponse(await runAutoLogin({ tabId: p.tabId }));
    });
    return true;
  }
  if (msg.type === "PANEL_TOGGLE") {
    // chrome.sidePanel.open() 은 사용자 제스처를 요구하고, 제스처는 **await 를 만나면 사라진다.**
    // 그래서 여기서는 절대 await 하지 않고 동기적으로 호출한다 (열림 여부도 메모리 집합에서 즉시 판단).
    const tab = sender && sender.tab;
    if (!tab || tab.windowId == null) return;
    if (openPanelWindows.has(tab.windowId)) {
      if (chrome.sidePanel.close) {
        chrome.sidePanel.close({ windowId: tab.windowId }).catch((e) => {
          afToast(tab.id, "패널을 닫지 못했어요: " + e.message, "error");
        });
      } else {
        afToast(tab.id, "이 크롬 버전은 단축키로 패널을 닫을 수 없어요 (Chrome 141+ 필요)", "error");
      }
    } else {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => {
        afToast(tab.id, "패널을 열지 못했어요: " + e.message, "error");
      });
    }
    return; // 응답 불필요
  }
  if (msg.type === "LOGIN_HOTKEY") {
    // 페이지에서 눌린 단축키 — 활성 탭 추측 대신 **보낸 탭**을 그대로 쓴다
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) return;
    runAutoLogin({ tabId }).then(sendResponse);
    return true;
  }
  if (msg.type === "LOGIN_HOTKEY_TARGET") {
    // 콘텐츠 스크립트가 "이 페이지에서 F2 를 가로채도 되는지" 묻는다 (등록된 사이트만 true)
    const url = (sender && (sender.url || (sender.tab && sender.tab.url))) || "";
    loadSites()
      .then((sites) => sendResponse({ target: isLoginHotkeyTarget(url, sites) }))
      .catch(() => sendResponse({ target: false }));
    return true;
  }
  if (msg.type === "LOGIN_HAS_PENDING") {
    chrome.storage.session.get("ua_login_pending").then((bag) => {
      const p = bag.ua_login_pending;
      sendResponse({ pending: !!p && Date.now() - p.at < 120000 });
    });
    return true;
  }
});

// ==========================================================================
// 사이드 패널 열림 상태 추적 (F4 토글용)
//
// sidePanel 에는 "열려 있는지" 질의하는 API 가 없다. 그래서 패널이 열릴 때
// 포트를 연결해 두고, 끊기면 닫힌 것으로 본다.
// 포트가 연결돼 있는 동안 서비스 워커는 살아 있으므로 이 메모리 집합을 신뢰할 수 있고,
// 워커가 죽었다면 집합은 비어 있는데 그때는 패널도 닫힌 상태다.
// (열림 판단은 **동기적**이어야 한다 — storage 조회를 끼우면 사용자 제스처가 사라진다)
// ==========================================================================

const PANEL_PORT_PREFIX = "ua-sidepanel:";
const openPanelWindows = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name || !port.name.startsWith(PANEL_PORT_PREFIX)) return;
  const windowId = Number(port.name.slice(PANEL_PORT_PREFIX.length));
  if (!Number.isFinite(windowId)) return;
  openPanelWindows.add(windowId);
  port.onDisconnect.addListener(() => openPanelWindows.delete(windowId));
});

// ==========================================================================
// 페이지 내 단축키 (F2 / F4) — commands API 로 등록할 수 없는 키를 지원
//
// Chrome `commands` 는 Ctrl/Alt 를 반드시 포함해야 하고 F1~F12 를 지원하지 않는다(공식 문서).
// 그래서 등록된 사이트에만 `src/content/hotkey.js` 를 동적으로 심어 키를 직접 받는다.
// 사이트 목록이나 단축키 설정이 바뀌면 다시 등록한다.
// ==========================================================================

const HOTKEY_SCRIPT_ID = "ua-login-hotkey";

async function unregisterHotkey() {
  try {
    const cur = await chrome.scripting.getRegisteredContentScripts({ ids: [HOTKEY_SCRIPT_ID] });
    if (cur.length) await chrome.scripting.unregisterContentScripts({ ids: [HOTKEY_SCRIPT_ID] });
  } catch (_) {
    /* 등록된 적이 없으면 무시 */
  }
}

/** 등록된(자동 로그인 ON) 사이트에만 키 리스너를 심는다. 사이트가 없으면 아예 심지 않는다. */
const ALL_SITES_MATCHES = ["http://*/*", "https://*/*"];

async function syncHotkeyRegistration() {
  let patterns = [];
  try {
    const [sites, settings] = await Promise.all([loadSites(), getSettings()]);
    const authOn = settings.hotkey && settings.hotkey.enabled !== false;
    const panelOn = settings.panelHotkey && settings.panelHotkey.enabled !== false;
    if (authOn || panelOn) {
      // 패널 토글(F4)은 어디서든 쓰고 싶은 기능이라 기본은 모든 http(s) 페이지.
      // 끄면 등록된 로그인 사이트에만 리스너를 심는다(범위 최소화).
      patterns = settings.hotkeyAllSites === false ? toMatchPatterns(sites) : ALL_SITES_MATCHES;
    }
  } catch (e) {
    console.error("[uni-assist] 단축키 등록 정보 로드 실패:", e.message);
    return;
  }

  await unregisterHotkey();
  if (!patterns.length) return; // 빈 matches 로는 등록할 수 없다

  const script = {
    id: HOTKEY_SCRIPT_ID,
    js: ["src/content/hotkey.js"],
    runAt: "document_start",
    allFrames: false,
    persistAcrossSessions: true,
  };
  try {
    await chrome.scripting.registerContentScripts([{ ...script, matches: patterns }]);
  } catch (e) {
    // 일부 환경에서 포트가 포함된 매치 패턴이 거부될 수 있어 포트를 뺀 패턴으로 재시도한다.
    //  (포트를 생략한 패턴은 모든 포트에 일치하고, 실제 포트 검증은 siteMatches 가 다시 한다)
    try {
      if (patterns === ALL_SITES_MATCHES) throw e; // 포트가 없는 패턴이라 재시도할 게 없다
      const sites = await loadSites();
      const fallback = toMatchPatterns(sites, { withPort: false });
      if (!fallback.length) throw e;
      await chrome.scripting.registerContentScripts([{ ...script, matches: fallback }]);
      console.warn("[uni-assist] 포트 없는 매치 패턴으로 단축키를 등록했습니다:", e.message);
    } catch (e2) {
      console.error("[uni-assist] 페이지 내 단축키 등록 실패:", e2.message);
    }
  }
}

async function injectHotkeyIntoOpenTabs() {
  let reg;
  try {
    [reg] = await chrome.scripting.getRegisteredContentScripts({ ids: [HOTKEY_SCRIPT_ID] });
  } catch (_) {
    return;
  }
  if (!reg) return; // 단축키가 모두 꺼져 있음
  const tabs = await chrome.tabs.query({ url: reg.matches }).catch(() => []);
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ["src/content/hotkey.js"] })
        .catch(() => {}) // 크롬 웹스토어 등 주입할 수 없는 페이지
    )
  );
}

// 사이트/설정이 바뀌면(이 PC에서든 동기화로든) 등록을 갱신
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  const touched = Object.keys(changes).some(
    (k) => k.startsWith("ua_site_") || k === "ua_login_index" || k === "ua_login_settings"
  );
  if (touched) syncHotkeyRegistration();
});

// 서비스 워커가 깨어날 때 등록 상태를 한 번 확인한다.
// (onInstalled/onStartup 이 어떤 이유로든 돌지 않은 경우 — 예: 확장 재로드 직후 — 를 메우기 위함)
// 브라우저 세션당 1회만 수행하도록 session 플래그로 가드해, 워커가 자주 깨어나도 낭비되지 않게 한다.
(async () => {
  const FLAG = "ua_hotkey_synced";
  try {
    const bag = await chrome.storage.session.get(FLAG);
    if (bag[FLAG]) return;
    await chrome.storage.session.set({ [FLAG]: true });
    await syncHotkeyRegistration();
  } catch (_) {
    /* 기동 시점 경합은 무시 — onInstalled/onStartup 이 다시 처리한다 */
  }
})();
