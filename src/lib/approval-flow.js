// 2차 인증 OTP 공통 로직 (크롬 API 비의존 → 단위 테스트 가능)
// 오류 안내에는 토큰과 인증번호를 넣지 않는다.

const MESSAGES = {
  SLACK_CONFIG_MISSING: "슬랙 앱 정보(Client ID / Client Secret)를 입력하세요",
  SLACK_CONFIG_INVALID: "슬랙 앱 정보(Client ID/Secret, Redirect URL)를 확인하세요",
  SLACK_NOT_CONNECTED: "슬랙에 연결되지 않았어요. 아래에서 슬랙으로 연결하세요",
  SLACK_AUTH_CANCELLED: "슬랙 연결을 취소했어요",
  SLACK_AUTH_WINDOW:
    "슬랙 창에서 돌아오지 못했어요. 창을 닫았거나, 슬랙 앱 Redirect URLs 에 아래 주소가 등록되지 않았을 수 있어요",
  SLACK_AUTH_FAILED: "슬랙 연결에 실패했어요. 다시 시도하세요",
  SLACK_TOKEN_FORMAT: "사용자 토큰(xoxp- 로 시작)을 붙여 넣으세요",
  SLACK_TOKEN_INVALID: "슬랙 연결이 만료됐어요. 다시 연결하세요",
  SLACK_MISSING_SCOPE: "슬랙 앱 권한(User Token Scopes)을 확인하세요",
  SLACK_DM_NOT_FOUND: "본인 DM 을 찾지 못했어요",
  SLACK_CHANNEL_NOT_FOUND: "DM 채널을 찾지 못했어요. 다시 연결하세요",
  SLACK_RATE_LIMITED: "슬랙 요청이 너무 많아요. 잠시 뒤 다시 시도하세요",
  SLACK_NETWORK: "슬랙에 접속하지 못했어요",
  SLACK_ERROR: "슬랙에서 오류가 발생했어요",
  OTP_TIMEOUT: "3분 안에 인증 메일이 오지 않았어요",
  OTP_INPUT_NOT_FOUND: "현재 탭에서 인증번호 입력칸을 찾지 못했어요",
  OTP_SUBMIT_NOT_FOUND: "현재 탭에서 확인 버튼을 찾지 못했어요",
  PAGE_ACTION_FAILED: "현재 탭에는 입력할 수 없어요",
  BAD_REQUEST: "요청이 올바르지 않아요",
};

export class ApprovalError extends Error {
  /** @param {string} code @param {string} [detail] 진단용 원인(슬랙 오류 코드 등). 토큰·번호는 넣지 않는다 */
  constructor(code, detail) {
    super(code);
    this.name = "ApprovalError";
    this.code = code;
    this.detail = detail;
  }
}

// 원인은 짧은 식별자 형태일 때만 덧붙인다(서버가 돌려준 긴 문장·값이 화면에 새지 않도록).
const SAFE_DETAIL = /^[\w .:/'-]{1,80}$/;

export function messageForError(err) {
  const base = MESSAGES[err && err.code] || "인증번호를 가져오지 못했어요";
  const detail = err && typeof err.detail === "string" ? err.detail.trim() : "";
  return detail && SAFE_DETAIL.test(detail) ? `${base} (${detail})` : base;
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
