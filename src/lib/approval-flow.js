// 2차 인증 OTP 공통 로직 (크롬 API 비의존 → 단위 테스트 가능)
// 오류 안내에는 비밀번호와 인증번호를 넣지 않는다.

const MESSAGES = {
  CONFIG_INVALID: "메일 설정값을 확인하세요 (host/config.json)",
  HOST_NOT_FOUND: "OTP 호스트에 연결하지 못했어요. 설치 스크립트를 실행하세요",
  HOST_TIMEOUT: "OTP 호스트가 응답하지 않아요",
  HOST_ERROR: "OTP 호스트에서 오류가 발생했어요",
  BAD_REQUEST: "OTP 호스트 요청이 올바르지 않아요",
  CREDENTIAL_MISSING: "키체인에 메일 비밀번호가 없어요. 설치 스크립트로 등록하세요",
  POP3_AUTH_FAILED: "메일 로그인에 실패했어요. 메일 계정(전체 주소)과 비밀번호를 확인하세요",
  POP3_CONNECT_FAILED: "메일 서버에 접속하지 못했어요",
  UNSUPPORTED_UIDL: "메일 서버가 UIDL 을 지원하지 않아 사용할 수 없어요",
  OTP_PARSE_FAILED: "인증 메일에서 번호를 찾지 못했어요",
  OTP_NOT_FOUND: "최근 메일에서 인증 메일을 찾지 못했어요. 발신 주소와 제목 패턴을 확인하세요",
  OTP_INPUT_NOT_FOUND: "현재 탭에서 인증번호 입력칸을 찾지 못했어요",
  OTP_SUBMIT_NOT_FOUND: "현재 탭에서 확인 버튼을 찾지 못했어요",
  PAGE_ACTION_FAILED: "현재 탭에는 입력할 수 없어요",
};

export class ApprovalError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = "ApprovalError";
    this.code = code;
  }
}

export function messageForError(err) {
  return MESSAGES[err && err.code] || "인증번호를 가져오지 못했어요";
}

/** 일반 페이지의 콘텐츠 스크립트가 아니라 확장 자체 화면(사이드 패널)에서 온 요청만 인정한다. */
export function isExtensionPage(sender, extensionId) {
  return (
    !!sender &&
    sender.id === extensionId &&
    !sender.tab &&
    typeof sender.url === "string" &&
    sender.url.startsWith(`chrome-extension://${extensionId}/`)
  );
}

// ---- 호스트 연결 ---------------------------------------------------------

const HOST_REQUEST_MS = 30000;
const KEYCHAIN_PROMPT_MS = 60000;

/** Native Messaging 포트 위에서 요청과 응답을 id 로 짝짓는다. */
export function createHostClient(port) {
  let nextId = 1;
  let closed = false;
  const pending = new Map();

  function take(id) {
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      clearTimeout(entry.timer);
    }
    return entry;
  }

  port.onMessage.addListener((message) => {
    const entry = take(message && message.id);
    if (!entry) return;
    if (message.ok) entry.resolve(message);
    else entry.reject(new ApprovalError((message.error && message.error.code) || "HOST_ERROR"));
  });

  port.onDisconnect.addListener(() => {
    closed = true;
    for (const id of [...pending.keys()]) take(id).reject(new ApprovalError("HOST_NOT_FOUND"));
  });

  function request(type, params, timeoutMs) {
    if (closed) return Promise.reject(new ApprovalError("HOST_NOT_FOUND"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        take(id);
        reject(new ApprovalError("HOST_TIMEOUT"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ id, type, ...params });
    });
  }

  return {
    ping: () => request("ping", {}, HOST_REQUEST_MS),
    latestOtp: () => request("latestOtp", {}, KEYCHAIN_PROMPT_MS),
    close() {
      if (!closed) port.disconnect();
      closed = true;
      for (const id of [...pending.keys()]) take(id).reject(new ApprovalError("HOST_NOT_FOUND"));
    },
  };
}
