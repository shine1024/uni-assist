// Claude 로그인 인증: 슬랙 DM 의 보안 링크 메일 → 숨긴 탭으로 링크 열기 → 인증 코드 읽기 → 탭 닫기
//
// 슬랙 연결은 「유니클라우드 2차 인증」과 공유한다(K_SLACK). 이 기능의 설정·사용 기록은 K_CLAUDE (이 PC 전용).
// 보안 링크는 이 모듈 안에서만 다룬다 — 저장·로그·오류 메시지에 넣지 않고, 페이지(콘텐츠 스크립트)에는 코드만 보낸다.
// 설계: docs/CLAUDE-LOGIN.md
import {
  CLAUDE_LOGIN_CONFIG as CFG,
  LINK_SOURCES,
  describeCodeText,
  describeSources,
  findMagicLink,
  isAllowedLink,
  isLoggedInPath,
  normalizeCode,
  senderDomain,
} from "../lib/claude-login.js";
import { ApprovalError, messageForError } from "../lib/approval-flow.js";
import { createSlackClient, otpCandidates, tsToIso } from "../lib/slack-otp.js";
import { getSlack } from "./approval.js";
import { pageFillOtp } from "./approval-page-actions.js";

export const K_CLAUDE = "ua_claude_login"; // { lastUsedTs, autoFill }
const AUTO_SCRIPT_ID = "ua-claude-auto";

const K_LAST = "ua_claude_last"; // storage.session — 최근 시도 단계 기록 (진단용, 링크·코드 없음)
const NOTE_KEEP = 10;
let noteChain = Promise.resolve();

/**
 * 진단용 기록. stage 는 짧은 이름, detail 은 경로·개수 같은 안전한 값만.
 * 최근 NOTE_KEEP 개를 남긴다. 같은 단계가 연달아 오면(메일 기다리는 중 반복) 새로 쌓지 않고 마지막 것만 고친다
 * — 기다리는 동안 앞선 실패 기록이 밀려나지 않게.
 */
function note(stage, detail = {}) {
  const entry = { stage, ...detail, at: new Date().toISOString() };
  noteChain = noteChain
    .then(async () => {
      const { [K_LAST]: prev } = await chrome.storage.session.get(K_LAST);
      const list = Array.isArray(prev) ? prev : [];
      if (list.length && list[list.length - 1].stage === stage) list[list.length - 1] = { ...entry, repeat: (list[list.length - 1].repeat || 1) + 1 };
      else list.push(entry);
      await chrome.storage.session.set({ [K_LAST]: list.slice(-NOTE_KEEP) });
    })
    .catch(() => {});
}

/** 탭 주소에서 경로만 (해시·쿼리 제외) */
const pathOf = (url) => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return "";
  }
};

const failure = (err) => ({ ok: false, code: err.code || "ERROR", message: messageForError(err) });

async function getState() {
  const { [K_CLAUDE]: s } = await chrome.storage.local.get(K_CLAUDE);
  return { lastUsedTs: "0", autoFill: false, ...(s || {}) };
}

async function patchState(patch) {
  await chrome.storage.local.set({ [K_CLAUDE]: { ...(await getState()), ...patch } });
}

async function markUsed(ts) {
  const s = await getState();
  if (parseFloat(ts) > parseFloat(s.lastUsedTs)) await patchState({ lastUsedTs: ts });
}

/** 사이드 패널 표시용 */
export async function claudeStatus() {
  const [slack, s] = await Promise.all([getSlack(), getState()]);
  return { ok: true, connected: !!(slack.token && slack.channelId), autoFill: !!s.autoFill };
}

/** 사용 기록 지우기 — 이미 쓴 메일도 다시 볼 수 있게 (링크가 일회용이 아닐 때 다시 시도용) */
export async function resetClaudeUsed() {
  await patchState({ lastUsedTs: "0" });
  return { ok: true };
}

export async function setClaudeAutoFill(on) {
  await patchState({ autoFill: !!on });
  return { ok: true };
}

// ---- 링크 페이지에서 코드 읽기 ---------------------------------------------

/**
 * 직렬화되어 링크 페이지에서 실행된다 — 바깥 변수를 참조하지 않는다. 코드가 나타날 때까지 기다려 { text } 를 돌려준다.
 * 끝내 못 찾으면 { hints } — 페이지 모양만(제목, 이름에 code 가 든 클래스·속성, 숫자 덩어리 개수). 값은 넣지 않는다.
 */
async function pageReadLinkCode({ selector, waitMs }) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const el = document.querySelector(selector);
    const text = el && (el.textContent || el.value || "").trim();
    if (text) return { text };
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const names = new Set();
  for (const node of document.querySelectorAll("body *")) {
    for (const c of node.classList) if (/code/i.test(c)) names.add("." + c);
    for (const a of node.getAttributeNames()) if (/code/i.test(a)) names.add("[" + a + "]");
    if (names.size >= 15) break;
  }
  const bodyText = (document.body && document.body.innerText) || "";
  return {
    hints: {
      title: document.title.slice(0, 60),
      path: location.pathname,
      hasHash: location.hash.length > 1,
      visibility: document.visibilityState,
      codeNames: [...names],
      digitRuns: (bodyText.match(/\b\d{4,10}\b/g) || []).length,
      textLength: bodyText.length,
      headings: [...document.querySelectorAll("h1,h2,h3")].map((h) => h.textContent.trim().slice(0, 40)).slice(0, 4),
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 링크 탭에서 코드를 한 번 확인한다 (기다리지 않음). withHints 면 못 찾았을 때 페이지 모양을 돌려준다.
 * 페이지가 이동 중이면 스크립트가 실패할 수 있다 → null (다음 확인 때 다시 본다)
 */
async function probeCode(tabId, withHints) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageReadLinkCode,
      args: [{ selector: CFG.selectors.linkCode, waitMs: 0 }],
    });
    const answer = (r && r.result) || {};
    return withHints ? answer.hints || null : answer.text || null;
  } catch {
    return null;
  }
}

/**
 * 로그인 화면에 머물러 있는 claude.ai 탭을 새로고침한다 (링크로 로그인된 뒤 로그인 화면은 저절로 넘어가지 않는다).
 * 로그인·링크 화면에 있는 탭 + 링크를 열기 전에 보던 claude.ai 탭.
 */
async function reloadLoginTabs(alsoTabId) {
  const tabs = await chrome.tabs.query({ url: CFG.matches }).catch(() => []);
  let count = 0;
  for (const t of tabs) {
    let path = "";
    try {
      path = new URL(t.url).pathname;
    } catch {
      continue;
    }
    if (t.id === alsoTabId || !isLoggedInPath(path)) {
      chrome.tabs.reload(t.id).catch(() => {});
      count++;
    }
  }
  return count;
}

/**
 * 보안 링크를 탭으로 열고, 로그인이 끝나거나 코드가 보이면 탭을 닫은 뒤 원래 보던 탭으로 돌아간다.
 * 링크 페이지는 탭이 보이지 않으면(visibility hidden) 화면을 그리지 않아서(2026-11-13 진단으로 확인)
 * 숨긴 탭(active:false)으로는 안 된다 → 잠깐 앞으로 띄운다.
 * @returns {Promise<{loggedIn: true, backTo?: number} | {code: string}>}
 */
async function openMagicLink(link, openerTab) {
  let tab;
  let backTo = openerTab && openerTab.id;
  try {
    let windowId = openerTab && openerTab.windowId;
    if (windowId == null) {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active) {
        windowId = active.windowId;
        backTo = active.id;
      }
    }
    const opener = backTo ? await chrome.tabs.get(backTo).catch(() => null) : null;
    tab = await chrome.tabs.create({
      url: link,
      active: true,
      ...(windowId != null ? { windowId } : {}),
      ...(opener ? { index: opener.index + 1, openerTabId: opener.id } : {}),
    });
  } catch {
    throw new ApprovalError("CLAUDE_TAB_FAILED");
  }
  try {
    // 링크 탭을 지켜보며 둘 중 먼저 오는 것을 기다린다
    //  ① 탭이 /magic-link 에서 claude.ai 의 다른 화면으로 넘어감 → 같은 브라우저라 링크가 바로 로그인시킨 것 (2026-11-13 실제 확인)
    //  ② 링크 페이지에 인증 코드가 나타남 → 코드를 읽어 로그인 화면에 넣는다
    const startedAt = Date.now();
    const deadline = startedAt + CFG.linkPageWaitMs;
    let opened = false;
    while (Date.now() < deadline) {
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t) {
        note("링크 탭이 닫힘");
        throw new ApprovalError("CLAUDE_CODE_NOT_FOUND");
      }
      let u = null;
      try {
        u = new URL(t.url || t.pendingUrl || "");
      } catch {
        /* 아직 주소 없음 */
      }
      if (u && t.status === "complete") {
        if (u.origin !== CFG.linkOrigin) {
          note("링크 페이지가 다른 곳으로 이동", { page: pathOf(u.href) });
          throw new ApprovalError("CLAUDE_CODE_NOT_FOUND");
        }
        if (u.pathname !== CFG.linkPath) {
          if (isLoggedInPath(u.pathname)) {
            note("링크로 바로 로그인됨", { page: pathOf(u.href), ms: Date.now() - startedAt });
            await sleep(CFG.loginSettleMs); // 로그인 쿠키·세션 정리가 끝나도록 잠깐 둔다
            return { loggedIn: true, backTo };
          }
          note("링크 페이지가 다른 곳으로 이동", { page: pathOf(u.href) });
          throw new ApprovalError("CLAUDE_CODE_NOT_FOUND");
        }
        if (!opened) {
          opened = true;
          note("링크 페이지 열림", { ms: Date.now() - startedAt });
        }
        const text = await probeCode(tab.id, false);
        if (text) {
          const code = normalizeCode(text);
          if (!code) {
            note("코드 형식이 다름", { shape: describeCodeText(text) });
            throw new ApprovalError("CLAUDE_CODE_NOT_FOUND");
          }
          note("코드 읽음");
          return { code };
        }
      }
      await sleep(400);
    }
    const t = await chrome.tabs.get(tab.id).catch(() => null);
    const hints = t && t.status === "complete" ? await probeCode(tab.id, true) : null;
    note("시간 초과", { page: t ? pathOf(t.url) : "탭 닫힘", status: t && t.status, hints });
    throw new ApprovalError("CLAUDE_CODE_NOT_FOUND");
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
    if (backTo) chrome.tabs.update(backTo, { active: true }).catch(() => {});
  }
}

// ---- 조회 ----------------------------------------------------------------

let inflight = null;

/**
 * 아직 쓰지 않은 보안 링크 메일을 한 번 조회한다. 메일이 없으면 { pending: true }.
 * 메일이 있으면 링크를 열어 코드를 읽는다. 링크는 열면 소모될 수 있으므로 **열기 전에** 사용함으로 표시한다.
 * 패널과 자동 입력이 동시에 물으면 링크는 한 번만 열고 같은 결과를 함께 돌려준다.
 * @param {number} [oldest] 이 시각(초) 이후 메일만
 * @param {chrome.tabs.Tab} [openerTab] 링크 탭을 이 탭 옆에 연다
 */
export function fetchClaudeCode(oldest, openerTab) {
  if (!inflight) inflight = fetchOnce(oldest, openerTab).finally(() => (inflight = null));
  return inflight;
}

/** 메일 파일에서 보안 링크 — 원본, simplified_html, plain_text 순 (미리보기는 잘릴 수 있어 쓰지 않음) */
async function linkFromFile(client, file) {
  const { sources } = await client.fileSources(file);
  const byName = Object.fromEntries(sources.map((x) => [x.name, x]));
  return findMagicLink(LINK_SOURCES.map((n) => byName[n]).filter(Boolean));
}

async function fetchOnce(oldest, openerTab) {
  try {
    const slack = await getSlack();
    if (!slack.token || !slack.channelId) throw new ApprovalError("SLACK_NOT_CONNECTED");
    const s = await getState();
    const since = Number.isFinite(oldest) ? oldest : Math.floor(Date.now() / 1000) - CFG.lookbackSec;
    const client = createSlackClient(slack.token);
    const { messages = [] } = await client.call("conversations.history", {
      channel: slack.channelId,
      oldest: String(since),
      limit: "20",
    });
    const [latest] = otpCandidates(messages, { titleKeyword: CFG.titleKeyword, lastUsedTs: s.lastUsedTs });
    if (!latest) {
      note("메일 기다리는 중", { messages: messages.length });
      return { ok: true, pending: true };
    }
    const link = await linkFromFile(client, latest.file);
    if (!link || !isAllowedLink(link)) {
      // 메일은 왔는데 링크를 못 찾음 — 기다려도 소용없으므로 바로 알린다
      note("메일에서 링크를 못 찾음");
      throw new ApprovalError("CLAUDE_LINK_NOT_FOUND");
    }
    await markUsed(latest.ts);
    note("링크 여는 중");
    const result = await openMagicLink(link, openerTab);
    const meta = { ts: latest.ts, receivedAt: tsToIso(latest.ts) };
    if (result.loggedIn) {
      const reloaded = await reloadLoginTabs(result.backTo);
      return { ok: true, loggedIn: true, reloaded, ...meta };
    }
    return { ok: true, code: result.code, ...meta };
  } catch (err) {
    if (err && err.code && !String(err.code).startsWith("CLAUDE_")) note("오류", { code: err.code });
    return failure(err);
  }
}

/**
 * 진단: 최근 30분 DM 의 메일 파일과 마지막 시도 결과. 링크·코드·본문은 넣지 않는다(길이·개수·도메인만).
 */
export async function diagnoseClaude() {
  try {
    const slack = await getSlack();
    const s = await getState();
    const { [K_LAST]: last } = await chrome.storage.session.get(K_LAST);
    const out = {
      slack: !!(slack.token && slack.channelId),
      autoFill: !!s.autoFill,
      lastUsed: tsToIso(s.lastUsedTs),
      history: Array.isArray(last) ? last : last ? [last] : [],
      title: CFG.titleKeyword,
      mails: [],
    };
    if (!out.slack) return { ok: true, report: out };
    const client = createSlackClient(slack.token);
    const { messages = [] } = await client.call("conversations.history", {
      channel: slack.channelId,
      oldest: String(Math.floor(Date.now() / 1000) - 1800),
      limit: "20",
    });
    for (const msg of messages) {
      for (const file of msg.files || []) {
        const title = String(file.title || file.name || "");
        const match = title.includes(CFG.titleKeyword);
        const item = {
          at: tsToIso(msg.ts),
          title: title.slice(0, 60),
          titleMatch: match,
          used: !(parseFloat(msg.ts) > parseFloat(s.lastUsedTs)),
          filetype: file.filetype || file.mimetype || "",
        };
        if (match && out.mails.filter((m) => m.titleMatch).length < 2) {
          const { info, sources } = await client.fileSources(file);
          item.from = senderDomain(info.from || file.from);
          item.sources = describeSources(sources);
          item.linkFound = !!findMagicLink(LINK_SOURCES.map((n) => sources.find((x) => x.name === n)).filter(Boolean));
        }
        out.mails.push(item);
        if (out.mails.length >= 8) break;
      }
    }
    return { ok: true, report: out };
  } catch (err) {
    return failure(err);
  }
}

/** 현재 탭(claude.ai 로그인 화면)의 코드 칸에 입력하고 「이메일 주소 확인」을 누른다. */
export async function fillClaudeCodeInActiveTab(code) {
  if (!normalizeCode(code)) return failure({ code: "BAD_REQUEST" });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !String(tab.url || "").startsWith(CFG.linkOrigin + "/")) return failure({ code: "CLAUDE_INPUT_NOT_FOUND" });
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageFillOtp,
      args: [{ inputSelector: CFG.selectors.codeInput, submitSelector: CFG.selectors.submit, code, waitMs: CFG.submitWaitMs }],
    });
  } catch {
    return failure({ code: "PAGE_ACTION_FAILED" });
  }
  const r = results && results[0] && results[0].result;
  if (r && r.ok) return { ok: true };
  return failure({ code: r && r.code === "OTP_SUBMIT_NOT_FOUND" ? "CLAUDE_SUBMIT_NOT_FOUND" : "CLAUDE_INPUT_NOT_FOUND" });
}

// ---- 로그인 화면 자동 입력 -------------------------------------------------

/** 자동 입력 요청은 켜져 있고, claude.ai 최상위 프레임의 콘텐츠 스크립트에서 왔을 때만 받는다. */
export async function isClaudeAutoSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) return false;
  if (!String(sender.url || "").startsWith(CFG.linkOrigin + "/")) return false;
  return !!(await getState()).autoFill;
}

/** 자동 입력이 켜져 있고 슬랙이 연결돼 있을 때만 claude.ai 에 감지 스크립트를 심는다. */
export async function syncClaudeAutoRegistration() {
  const [slack, s] = await Promise.all([getSlack(), getState()]);
  try {
    const cur = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_SCRIPT_ID] });
    if (cur.length) await chrome.scripting.unregisterContentScripts({ ids: [AUTO_SCRIPT_ID] });
    if (!s.autoFill || !slack.token || !slack.channelId) return;
    await chrome.scripting.registerContentScripts([
      {
        id: AUTO_SCRIPT_ID,
        matches: CFG.matches,
        js: ["src/content/claude-auto.js"],
        css: ["src/content/picker.css"], // 페이지 토스트(.__ua-toast) 스타일
        runAt: "document_idle",
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
    // 등록은 새로 여는 페이지에만 들어가므로 이미 열린 claude.ai 탭에도 심는다(스크립트가 중복 실행을 막는다)
    const tabs = await chrome.tabs.query({ url: CFG.matches }).catch(() => []);
    for (const tab of tabs) {
      chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["src/content/picker.css"] }).catch(() => {});
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content/claude-auto.js"] }).catch(() => {});
    }
  } catch {
    /* 등록 실패는 다음 변경 때 다시 시도한다 */
  }
}
