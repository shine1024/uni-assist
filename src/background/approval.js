// 2차 인증 OTP: 메일함 조회(네이티브 호스트)와 현재 탭 입력
import { APPROVAL_CONFIG } from "../lib/approval-config.js";
import { ApprovalError, createHostClient, messageForError } from "../lib/approval-flow.js";
import { pageFillOtp } from "./approval-page-actions.js";

function connectHost(hostName) {
  try {
    return createHostClient(chrome.runtime.connectNative(hostName));
  } catch {
    throw new ApprovalError("HOST_NOT_FOUND");
  }
}

const failure = (err) => ({ ok: false, code: err.code || "ERROR", message: messageForError(err) });

/** 가장 최근 인증 메일의 번호를 돌려준다. */
export async function latestApprovalOtp() {
  let host = null;
  try {
    host = connectHost(APPROVAL_CONFIG.hostName);
    const { code, receivedAt } = await host.latestOtp();
    return { ok: true, code, receivedAt };
  } catch (err) {
    return failure(err);
  } finally {
    if (host) host.close();
  }
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

/** 사이드 패널의 설치 상태 표시용 */
export async function approvalStatus() {
  let host = null;
  try {
    host = connectHost(APPROVAL_CONFIG.hostName);
    const { version } = await host.ping();
    return { hostOk: true, version };
  } catch (err) {
    return { hostOk: false, message: messageForError(err) };
  } finally {
    if (host) host.close();
  }
}
