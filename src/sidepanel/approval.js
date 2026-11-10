// 사이드 패널: 2차 인증 OTP 화면

const $ = (selector) => document.querySelector(selector);

let currentCode = "";

async function refreshStatus() {
  $("#approval-ext-id").textContent = chrome.runtime.id;
  $("#approval-host").textContent = "확인 중…";
  const status = await chrome.runtime.sendMessage({ type: "APPROVAL_STATUS" }).catch(() => null);
  $("#approval-host").textContent = status && status.hostOk ? `연결됨 v${status.version}` : "미설치";
}

function describeReceivedAt(iso) {
  if (!iso) return "수신 시각을 알 수 없어요. 방금 받은 메일인지 확인하세요";
  const received = new Date(iso);
  const minutes = Math.max(0, Math.floor((Date.now() - received.getTime()) / 60000));
  const time = received.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  return `${received.toLocaleDateString("ko-KR")} ${time} 수신 (${minutes ? `${minutes}분 전` : "방금"})`;
}

function showFillResult(text, isError) {
  const el = $("#approval-otp-result");
  el.textContent = text;
  el.classList.toggle("hidden", !text);
  el.classList.toggle("err", !!isError);
}

async function checkOtp() {
  const button = $("#btn-approval-otp");
  const code = $("#approval-otp-code");
  const info = $("#approval-otp-info");
  const actions = $("#approval-otp-actions");
  button.disabled = true;
  currentCode = "";
  code.classList.add("hidden");
  actions.classList.add("hidden");
  showFillResult("", false);
  info.classList.remove("hidden", "err");
  info.textContent = "메일함 확인 중…";

  const result = await chrome.runtime.sendMessage({ type: "APPROVAL_LATEST_OTP" }).catch(() => null);
  button.disabled = false;
  if (result && result.ok) {
    currentCode = result.code;
    code.textContent = result.code;
    code.classList.remove("hidden");
    actions.classList.remove("hidden");
    info.textContent = describeReceivedAt(result.receivedAt);
  } else {
    info.textContent = (result && result.message) || "메일함을 확인하지 못했어요";
    info.classList.add("err");
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

async function copyOtp() {
  let copied = true;
  try {
    await navigator.clipboard.writeText(currentCode);
  } catch {
    copied = copyWithSelection(currentCode);
  }
  const button = $("#btn-approval-otp-copy");
  button.textContent = copied ? "복사됨 ✓" : "복사 실패";
  clearTimeout(copyLabelTimer);
  copyLabelTimer = setTimeout(() => (button.textContent = "📋 복사"), 1500);
}

async function fillOtp() {
  const button = $("#btn-approval-otp-fill");
  button.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: "APPROVAL_FILL_OTP", code: currentCode }).catch(() => null);
  button.disabled = false;
  if (result && result.ok) showFillResult("입력하고 확인 버튼을 눌렀어요", false);
  else showFillResult((result && result.message) || "입력하지 못했어요", true);
}

export function initApprovalUI() {
  $("#btn-approval-otp").addEventListener("click", checkOtp);
  $("#btn-approval-otp-copy").addEventListener("click", copyOtp);
  $("#btn-approval-otp-fill").addEventListener("click", fillOtp);
  $("#btn-approval-check").addEventListener("click", refreshStatus);
}

export function onApprovalShown() {
  refreshStatus();
}
