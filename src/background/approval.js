// 2차 인증 OTP: 슬랙 DM 조회와 현재 탭 입력, 포털 자동 입력 등록
//
// 슬랙 연결(OAuth)은 사이드 패널이 하고 결과를 storage.local 의 K_SLACK 에 저장한다(이 PC 전용, 동기화 안 함).
// 조회는 한 번씩만 한다. 메일이 아직 안 왔으면 { pending: true } 를 돌려주고, 기다리는 반복은 부른 쪽이 한다.
import { APPROVAL_CONFIG } from "../lib/approval-config.js";
import { ApprovalError, messageForError } from "../lib/approval-flow.js";
import { createSlackClient, fetchLatestOtp, validateSlackConfig } from "../lib/slack-otp.js";
import { pageFillOtp } from "./approval-page-actions.js";

export const K_SLACK = "ua_slack"; // { token, channelId, user, team, lastUsedTs, autoFill }
const AUTO_SCRIPT_ID = "ua-otp-auto";

const failure = (err) => ({ ok: false, code: err.code || "ERROR", message: messageForError(err) });

async function getSlack() {
  const { [K_SLACK]: s } = await chrome.storage.local.get(K_SLACK);
  return { token: "", channelId: "", user: "", team: "", lastUsedTs: "0", autoFill: false, ...(s || {}) };
}

async function patchSlack(patch) {
  await chrome.storage.local.set({ [K_SLACK]: { ...(await getSlack()), ...patch } });
}

/** 확장 폴더의 slack-config.json (git 제외). 없거나 TODO 면 SLACK_CONFIG_MISSING */
export async function loadSlackConfig() {
  let raw = null;
  try {
    raw = await (await fetch(chrome.runtime.getURL("slack-config.json"))).json();
  } catch {
    /* 파일 없음 */
  }
  return validateSlackConfig(raw);
}

/** 사이드 패널 표시용 */
export async function approvalStatus() {
  const s = await getSlack();
  let configured = true;
  try {
    await loadSlackConfig();
  } catch {
    configured = false;
  }
  return {
    ok: true,
    configured,
    connected: !!(s.token && s.channelId),
    user: s.user,
    team: s.team,
    autoFill: !!s.autoFill,
    redirectUrl: chrome.identity.getRedirectURL(),
  };
}

/** 아직 쓰지 않은 최근 인증번호를 한 번 조회한다. */
export async function fetchApprovalOtp(oldest) {
  try {
    const s = await getSlack();
    if (!s.token || !s.channelId) throw new ApprovalError("SLACK_NOT_CONNECTED");
    const since = Number.isFinite(oldest) ? oldest : Math.floor(Date.now() / 1000) - APPROVAL_CONFIG.lookbackSec;
    const found = await fetchLatestOtp(createSlackClient(s.token), {
      channelId: s.channelId,
      oldest: since,
      lastUsedTs: s.lastUsedTs,
      titleKeyword: APPROVAL_CONFIG.titleKeyword,
    });
    return found ? { ok: true, ...found } : { ok: true, pending: true };
  } catch (err) {
    return failure(err);
  }
}

/** 같은 메일의 번호를 다음 로그인에 다시 쓰지 않도록 표시한다. */
export async function markApprovalOtpUsed(ts) {
  if (typeof ts !== "string" || !/^\d+(\.\d+)?$/.test(ts)) return failure({ code: "BAD_REQUEST" });
  const s = await getSlack();
  if (parseFloat(ts) > parseFloat(s.lastUsedTs)) await patchSlack({ lastUsedTs: ts });
  return { ok: true };
}

/** 연결 해제: 토큰을 슬랙에서도 폐기하고 이 PC 에서 지운다. */
export async function disconnectSlack() {
  const s = await getSlack();
  if (s.token) {
    try {
      await createSlackClient(s.token).revoke();
    } catch {
      /* 이미 무효면 무시 */
    }
  }
  await patchSlack({ token: "", channelId: "", user: "", team: "", lastUsedTs: "0" });
  return { ok: true };
}

export async function setAutoFill(on) {
  await patchSlack({ autoFill: !!on });
  return { ok: true };
}

/** 현재 탭의 인증번호 칸에 입력하고 확인 버튼을 누른다. 인증번호 화면이 프레임 안에 있어도 찾는다. */
export async function fillOtpInActiveTab(code) {
  if (typeof code !== "string" || !/^\d+$/.test(code)) return failure({ code: "BAD_REQUEST" });
  const { selectors, submitWaitMs } = APPROVAL_CONFIG;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return failure({ code: "PAGE_ACTION_FAILED" });

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: pageFillOtp,
      args: [{ inputSelector: selectors.otpInput, submitSelector: selectors.otpSubmit, code, waitMs: submitWaitMs }],
    });
  } catch {
    return failure({ code: "PAGE_ACTION_FAILED" });
  }

  const answers = results.map((r) => r.result).filter(Boolean);
  if (answers.some((a) => a.ok)) return { ok: true };
  const submitMissing = answers.some((a) => a.code === "OTP_SUBMIT_NOT_FOUND");
  return failure({ code: submitMissing ? "OTP_SUBMIT_NOT_FOUND" : "OTP_INPUT_NOT_FOUND" });
}

// ---- 포털 자동 입력 -------------------------------------------------------

/** 자동 입력 요청은 자동 입력이 켜져 있고, 포털 페이지의 콘텐츠 스크립트에서 왔을 때만 받는다. */
export async function isAutoFillSender(sender) {
  const url = (sender && sender.tab && sender.url) || "";
  const onPortal = APPROVAL_CONFIG.portalMatches.some((p) => url.startsWith(p.replace(/\*$/, "")));
  if (!onPortal || sender.id !== chrome.runtime.id) return false;
  return !!(await getSlack()).autoFill;
}

/** 자동 입력이 켜져 있고 연결돼 있을 때만 포털에 감지 스크립트를 심는다. */
export async function syncAutoFillRegistration() {
  const s = await getSlack();
  try {
    const cur = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_SCRIPT_ID] });
    if (cur.length) await chrome.scripting.unregisterContentScripts({ ids: [AUTO_SCRIPT_ID] });
    if (!s.autoFill || !s.token || !s.channelId) return;
    await chrome.scripting.registerContentScripts([
      {
        id: AUTO_SCRIPT_ID,
        matches: APPROVAL_CONFIG.portalMatches,
        js: ["src/content/otp-auto.js"],
        css: ["src/content/picker.css"], // 페이지 토스트(.__ua-toast) 스타일
        runAt: "document_idle",
        allFrames: true,
        persistAcrossSessions: true,
      },
    ]);
  } catch {
    /* 등록 실패는 다음 변경 때 다시 시도한다 */
  }
}
