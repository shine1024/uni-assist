// 사이드 패널: 2차 인증 OTP 화면 (슬랙 DM 에서 인증번호 가져오기)
import { APPROVAL_CONFIG } from "../lib/approval-config.js";
import { ApprovalError, messageForError } from "../lib/approval-flow.js";
import { loadSlackApp, saveSlackApp } from "../lib/slack-app.js";
import { buildAuthUrl, createSlackClient, exchangeCode, parseAuthRedirect } from "../lib/slack-otp.js";

const $ = (selector) => document.querySelector(selector);
const K_SLACK = "ua_slack"; // background/approval.js 와 같은 키

let current = null; // { code, ts }
let waiting = null; // { cancelled }

// ---- 슬랙 연결 ------------------------------------------------------------

async function refreshStatus() {
  const st = await chrome.runtime.sendMessage({ type: "APPROVAL_STATUS" }).catch(() => null);
  if (!st) return;
  $("#slack-status").textContent = st.connected ? "연결됨" : "연결 안 됨";
  $("#slack-status").classList.toggle("on", st.connected);
  $("#slack-user").textContent = st.connected ? `${st.user}${st.team ? ` · ${st.team}` : ""}` : "—";
  $("#slack-redirect").textContent = st.redirectUrl;
  configured = st.configured;
  // 앱 정보가 없으면 입력칸을 먼저 보여 준다(처음 한 번). 있으면 고급 → 변경 으로만 연다.
  if (!st.configured) showAppForm(true);
  else if (!editingApp) showAppForm(false);
  $("#btn-slack-connect").classList.toggle("hidden", st.connected);
  $("#btn-slack-connect").disabled = !st.configured;
  $("#btn-slack-disconnect").classList.toggle("hidden", !st.connected);
  $("#slack-token-box").classList.toggle("hidden", st.connected);
  $("#otp-autofill").checked = st.autoFill;
  $("#otp-autofill").disabled = !st.connected;
}

let configured = false;
let editingApp = false;

function showAppForm(show) {
  $("#slack-app-form").classList.toggle("hidden", !show);
  $("#btn-slack-app-cancel").classList.toggle("hidden", !(show && configured));
  if (!show) {
    editingApp = false;
    $("#slack-client-secret").value = "";
  }
}

async function editApp() {
  editingApp = true;
  try {
    $("#slack-client-id").value = (await loadSlackApp()).clientId;
  } catch {
    /* 아직 없음 */
  }
  $("#slack-client-secret").value = "";
  showAppForm(true);
  $("#slack-client-id").focus();
}

async function saveApp() {
  showSlackError(null);
  try {
    await saveSlackApp({ clientId: $("#slack-client-id").value, clientSecret: $("#slack-client-secret").value });
    showAppForm(false);
  } catch (err) {
    showSlackError(err);
    return;
  }
  refreshStatus();
}

function showSlackError(err) {
  const el = $("#slack-error");
  el.textContent = err ? messageForError(err) : "";
  el.classList.toggle("hidden", !err);
}

async function connectSlack() {
  const button = $("#btn-slack-connect");
  button.disabled = true;
  showSlackError(null);
  try {
    const { clientId, clientSecret } = await loadSlackApp();
    const redirectUri = chrome.identity.getRedirectURL();
    const state = crypto.randomUUID();

    let redirected;
    try {
      redirected = await chrome.identity.launchWebAuthFlow({
        url: buildAuthUrl({ clientId, redirectUri, state }),
        interactive: true,
      });
    } catch (e) {
      // 창을 닫았거나, 슬랙이 오류 화면(예: redirect_uri 불일치)을 보여 주어 돌아오지 못한 경우
      throw new ApprovalError("SLACK_AUTH_WINDOW", e && e.message);
    }
    const code = parseAuthRedirect(redirected, state);
    await saveConnection(await exchangeCode({ clientId, clientSecret, code, redirectUri }));
  } catch (err) {
    showSlackError(err);
  } finally {
    button.disabled = false;
    refreshStatus();
  }
}

/** 토큰이 유효한지 확인하고 본인 DM 을 찾아 이 PC 에 저장한다. */
async function saveConnection(token) {
  const client = createSlackClient(token);
  const me = await client.me();
  const channelId = await client.findSelfDm(me.userId);
  const { [K_SLACK]: prev } = await chrome.storage.local.get(K_SLACK);
  await chrome.storage.local.set({
    [K_SLACK]: { ...(prev || {}), token, channelId, user: me.user, team: me.team, lastUsedTs: "0" },
  });
}

/** OAuth 대신 이미 발급된 사용자 토큰(xoxp-)으로 연결한다. */
async function connectWithToken() {
  const input = $("#slack-token");
  const button = $("#btn-slack-token");
  const token = input.value.trim();
  showSlackError(null);
  if (!/^xoxp-[\w-]+$/.test(token)) {
    showSlackError(new ApprovalError("SLACK_TOKEN_FORMAT"));
    return;
  }
  button.disabled = true;
  try {
    await saveConnection(token);
    input.value = "";
  } catch (err) {
    showSlackError(err);
  } finally {
    button.disabled = false;
    refreshStatus();
  }
}

async function disconnectSlack() {
  if (!confirm("슬랙 연결을 해제할까요? 이 PC에 저장된 슬랙 토큰을 폐기합니다.")) return;
  await chrome.runtime.sendMessage({ type: "APPROVAL_DISCONNECT" }).catch(() => null);
  showSlackError(null);
  refreshStatus();
}

// ---- 인증번호 확인 --------------------------------------------------------

function describeReceivedAt(iso) {
  if (!iso) return "수신 시각을 알 수 없어요";
  const received = new Date(iso);
  const seconds = Math.max(0, Math.floor((Date.now() - received.getTime()) / 1000));
  const time = received.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${time} 수신 (${seconds < 60 ? "방금" : `${Math.floor(seconds / 60)}분 전`})`;
}

function showFillResult(text, isError) {
  const el = $("#approval-otp-result");
  el.textContent = text;
  el.classList.toggle("hidden", !text);
  el.classList.toggle("err", !!isError);
}

function setInfo(text, isError = false) {
  const info = $("#approval-otp-info");
  info.textContent = text;
  info.classList.toggle("hidden", !text);
  info.classList.toggle("err", isError);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 아직 쓰지 않은 인증번호를 찾는다. 없으면 메일이 올 때까지 최대 3분 기다린다. 다시 누르면 취소. */
async function checkOtp() {
  const button = $("#btn-approval-otp");
  if (waiting) {
    waiting.cancelled = true;
    return;
  }
  const job = (waiting = { cancelled: false });
  current = null;
  button.textContent = "취소";
  $("#approval-otp-code").classList.add("hidden");
  $("#approval-otp-actions").classList.add("hidden");
  showFillResult("", false);

  const startedAt = Date.now();
  const oldest = Math.floor(startedAt / 1000) - APPROVAL_CONFIG.lookbackSec;
  try {
    for (;;) {
      const left = Math.ceil((APPROVAL_CONFIG.waitMs - (Date.now() - startedAt)) / 1000);
      if (left <= 0) throw new ApprovalError("OTP_TIMEOUT");
      setInfo(`슬랙 DM 확인 중… 메일이 오면 바로 표시합니다 (${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")})`);
      const r = await chrome.runtime.sendMessage({ type: "APPROVAL_FETCH_OTP", oldest }).catch(() => null);
      if (job.cancelled) {
        setInfo("");
        return;
      }
      if (!r || !r.ok) {
        setInfo((r && r.message) || "인증번호를 가져오지 못했어요", true);
        return;
      }
      if (!r.pending) {
        current = { code: r.code, ts: r.ts };
        $("#approval-otp-code").textContent = r.code;
        $("#approval-otp-code").classList.remove("hidden");
        $("#approval-otp-actions").classList.remove("hidden");
        setInfo(describeReceivedAt(r.receivedAt));
        return;
      }
      await sleep(APPROVAL_CONFIG.pollIntervalMs);
      if (job.cancelled) {
        setInfo("");
        return;
      }
    }
  } catch (err) {
    setInfo(messageForError(err), true);
  } finally {
    waiting = null;
    button.textContent = "인증번호 확인";
  }
}

const markUsed = () =>
  current && chrome.runtime.sendMessage({ type: "APPROVAL_MARK_USED", ts: current.ts }).catch(() => null);

function copyWithSelection(text) {
  const area = document.createElement("textarea");
  area.value = text;
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  return copied;
}

let copyLabelTimer;

async function copyOtp() {
  if (!current) return;
  let copied = true;
  try {
    await navigator.clipboard.writeText(current.code);
  } catch {
    copied = copyWithSelection(current.code);
  }
  if (copied) markUsed();
  const label = $("#btn-approval-otp-copy").querySelector("span");
  label.textContent = copied ? "복사됨" : "복사 실패";
  clearTimeout(copyLabelTimer);
  copyLabelTimer = setTimeout(() => (label.textContent = "복사"), 1500);
}

async function fillOtp() {
  if (!current) return;
  const button = $("#btn-approval-otp-fill");
  button.disabled = true;
  const result = await chrome.runtime
    .sendMessage({ type: "APPROVAL_FILL_OTP", code: current.code })
    .catch(() => null);
  button.disabled = false;
  if (result && result.ok) {
    markUsed();
    showFillResult("입력하고 확인 버튼을 눌렀어요", false);
  } else {
    showFillResult((result && result.message) || "입력하지 못했어요", true);
  }
}

export function initApprovalUI() {
  $("#btn-approval-otp").addEventListener("click", checkOtp);
  $("#btn-approval-otp-copy").addEventListener("click", copyOtp);
  $("#btn-approval-otp-fill").addEventListener("click", fillOtp);
  $("#btn-slack-connect").addEventListener("click", connectSlack);
  $("#btn-slack-disconnect").addEventListener("click", disconnectSlack);
  $("#btn-slack-token").addEventListener("click", connectWithToken);
  $("#btn-slack-app-edit").addEventListener("click", editApp);
  $("#btn-slack-app-save").addEventListener("click", saveApp);
  $("#btn-slack-app-cancel").addEventListener("click", () => showAppForm(false));
  $("#slack-client-secret").addEventListener("keydown", (e) => e.key === "Enter" && saveApp());
  $("#slack-token").addEventListener("keydown", (e) => e.key === "Enter" && connectWithToken());
  $("#otp-autofill").addEventListener("change", async (e) => {
    await chrome.runtime.sendMessage({ type: "APPROVAL_SET_AUTOFILL", on: e.target.checked }).catch(() => null);
    refreshStatus();
  });
}

export function onApprovalShown() {
  refreshStatus();
}
