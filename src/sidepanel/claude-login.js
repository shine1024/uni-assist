// 사이드 패널: Claude 로그인 인증 화면 (슬랙 DM 의 보안 링크 메일 → 인증 코드)
// 링크를 열고 코드를 읽는 일은 서비스 워커가 한다. 패널은 코드만 받는다.
import { CLAUDE_LOGIN_CONFIG as CFG } from "../lib/claude-login.js";
import { messageForError } from "../lib/approval-flow.js";

const $ = (selector) => document.querySelector(selector);

let current = null; // { code }
let waiting = null; // { cancelled }

async function refreshStatus() {
  const st = await chrome.runtime.sendMessage({ type: "CLAUDE_STATUS" }).catch(() => null);
  if (!st) return;
  $("#claude-slack-status").textContent = st.connected ? "연결됨" : "연결 안 됨";
  $("#claude-slack-status").classList.toggle("on", st.connected);
  $("#btn-claude-goto-slack").classList.toggle("hidden", st.connected);
  $("#claude-autofill").checked = st.autoFill;
  $("#claude-autofill").disabled = !st.connected;
}

function setInfo(text, isError = false) {
  const info = $("#claude-info");
  info.textContent = text;
  info.classList.toggle("hidden", !text);
  info.classList.toggle("err", isError);
}

function showResult(text, isError) {
  const el = $("#claude-result");
  el.textContent = text;
  el.classList.toggle("hidden", !text);
  el.classList.toggle("err", !!isError);
}

function describeReceivedAt(iso) {
  if (!iso) return "수신 시각을 알 수 없어요";
  const received = new Date(iso);
  const seconds = Math.max(0, Math.floor((Date.now() - received.getTime()) / 1000));
  const time = received.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${time} 메일 수신 (${seconds < 60 ? "방금" : `${Math.floor(seconds / 60)}분 전`})`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 아직 쓰지 않은 보안 링크 메일을 찾아 코드를 읽는다. 없으면 최대 3분 기다린다. 다시 누르면 취소. */
async function fetchCode() {
  const button = $("#btn-claude-fetch");
  if (waiting) {
    waiting.cancelled = true;
    if (waiting.stop) waiting.stop();
    setInfo("");
    return;
  }
  const job = (waiting = { cancelled: false });
  current = null;
  button.textContent = "취소";
  $("#claude-code").classList.add("hidden");
  $("#claude-actions").classList.add("hidden");
  showResult("", false);

  const startedAt = Date.now();
  const oldest = Math.floor(startedAt / 1000) - CFG.lookbackSec;
  const leftSec = () => Math.ceil((CFG.waitMs - (Date.now() - startedAt)) / 1000);
  // 남은 시간은 조회와 상관없이 1초마다 갱신한다 (링크를 여는 동안에도 멈추지 않게)
  const showCountdown = () => {
    const left = Math.max(0, leftSec());
    setInfo(`슬랙 DM 확인 중… 메일이 오면 링크를 열어 코드를 읽습니다 (${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")})`);
  };
  showCountdown();
  const ticker = setInterval(showCountdown, 1000);
  const stopTicker = () => clearInterval(ticker);
  job.stop = stopTicker;
  try {
    for (;;) {
      if (leftSec() <= 0) {
        stopTicker();
        setInfo("3분 안에 보안 링크 메일이 오지 않았어요", true);
        return;
      }
      const r = await chrome.runtime.sendMessage({ type: "CLAUDE_FETCH_CODE", oldest }).catch(() => null);
      if (!job.cancelled && (!r || !r.ok || !r.pending)) stopTicker();
      if (job.cancelled) {
        setInfo("");
        return;
      }
      if (!r || !r.ok) {
        setInfo((r && r.message) || "인증 코드를 가져오지 못했어요", true);
        return;
      }
      if (r.loggedIn) {
        // 같은 브라우저라 링크를 여는 것만으로 로그인됐다 — 코드는 없다
        setInfo(
          r.reloaded
            ? "보안 링크로 로그인했어요. claude.ai 로그인 화면을 새로고침했어요"
            : "보안 링크로 로그인했어요. claude.ai 탭을 새로고침하세요"
        );
        return;
      }
      if (!r.pending) {
        current = { code: r.code };
        $("#claude-code").textContent = r.code;
        $("#claude-code").classList.remove("hidden");
        $("#claude-actions").classList.remove("hidden");
        setInfo(describeReceivedAt(r.receivedAt));
        return;
      }
      await sleep(CFG.pollIntervalMs);
      if (job.cancelled) {
        setInfo("");
        return;
      }
    }
  } catch (err) {
    setInfo(messageForError(err), true);
  } finally {
    stopTicker();
    waiting = null;
    button.textContent = "보안 링크로 로그인";
  }
}

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

async function copyCode() {
  if (!current) return;
  let copied = true;
  try {
    await navigator.clipboard.writeText(current.code);
  } catch {
    copied = copyWithSelection(current.code);
  }
  const label = $("#btn-claude-copy").querySelector("span");
  label.textContent = copied ? "복사됨" : "복사 실패";
  clearTimeout(copyLabelTimer);
  copyLabelTimer = setTimeout(() => (label.textContent = "복사"), 1500);
}

async function fillCode() {
  if (!current) return;
  const button = $("#btn-claude-fill");
  button.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: "CLAUDE_FILL_CODE", code: current.code }).catch(() => null);
  button.disabled = false;
  if (result && result.ok) showResult("입력하고 「이메일 주소 확인」을 눌렀어요", false);
  else showResult((result && result.message) || "입력하지 못했어요", true);
}

async function runDiagnosis() {
  const out = $("#claude-diag-out");
  const button = $("#btn-claude-diag");
  button.disabled = true;
  out.textContent = "확인 중…";
  out.classList.remove("hidden");
  const r = await chrome.runtime.sendMessage({ type: "CLAUDE_DIAGNOSE" }).catch(() => null);
  button.disabled = false;
  out.textContent = r && r.ok ? JSON.stringify(r.report, null, 2) : (r && r.message) || "진단하지 못했어요";
  $("#btn-claude-diag-copy").classList.toggle("hidden", !(r && r.ok));
}

async function copyDiagnosis() {
  const text = $("#claude-diag-out").textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    copyWithSelection(text);
  }
  const label = $("#btn-claude-diag-copy").querySelector("span");
  label.textContent = "복사됨";
  setTimeout(() => (label.textContent = "복사"), 1500);
}

async function resetUsed() {
  await chrome.runtime.sendMessage({ type: "CLAUDE_RESET_USED" }).catch(() => null);
  setInfo("사용 기록을 지웠어요. 「보안 링크로 로그인」을 다시 누르세요");
}

export function initClaudeUI({ showView }) {
  $("#btn-claude-diag").addEventListener("click", runDiagnosis);
  $("#btn-claude-diag-copy").addEventListener("click", copyDiagnosis);
  $("#btn-claude-reset").addEventListener("click", resetUsed);
  $("#btn-claude-fetch").addEventListener("click", fetchCode);
  $("#btn-claude-copy").addEventListener("click", copyCode);
  $("#btn-claude-fill").addEventListener("click", fillCode);
  $("#btn-claude-goto-slack").addEventListener("click", () => showView("approval"));
  $("#claude-autofill").addEventListener("change", async (e) => {
    await chrome.runtime.sendMessage({ type: "CLAUDE_SET_AUTOFILL", on: e.target.checked }).catch(() => null);
    refreshStatus();
  });
}

export function onClaudeShown() {
  refreshStatus();
}
