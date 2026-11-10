// 확장의 요청을 처리해 응답을 만든다. 입출력과 분리해 단독으로 테스트할 수 있다.

const KNOWN_CODES = new Set([
  "BAD_REQUEST",
  "CONFIG_INVALID",
  "CREDENTIAL_MISSING",
  "POP3_AUTH_FAILED",
  "POP3_CONNECT_FAILED",
  "UNSUPPORTED_UIDL",
  "OTP_PARSE_FAILED",
  "OTP_NOT_FOUND",
  "ABORTED",
]);

/** 예상하지 못한 오류의 원문에는 민감한 값이 섞일 수 있으므로 내보내지 않는다. */
function toErrorPayload(err) {
  if (err && KNOWN_CODES.has(err.code)) return { code: err.code, message: err.message };
  return { code: "HOST_ERROR", message: "호스트에서 오류가 발생했어요" };
}

/**
 * @param {{
 *   version: string,
 *   send: (message: object) => void,
 *   signal: AbortSignal,
 *   loadConfig: () => any,
 *   getSecret: (account: "mail") => string,
 *   latestOtp: Function,
 * }} deps
 */
export function createDispatcher(deps) {
  const handlers = {
    ping: async () => ({ version: deps.version }),
    latestOtp: async () => {
      const config = deps.loadConfig();
      return deps.latestOtp(config, deps.getSecret("mail"), { signal: deps.signal });
    },
  };

  return async function handle(request) {
    const id = request && request.id;
    const handler = request && Object.hasOwn(handlers, request.type) ? handlers[request.type] : null;
    if (!handler) {
      deps.send({ id, ok: false, error: { code: "BAD_REQUEST", message: "알 수 없는 요청이에요" } });
      return;
    }
    try {
      deps.send({ id, ok: true, ...(await handler(request)) });
    } catch (err) {
      deps.send({ id, ok: false, error: toErrorPayload(err) });
    }
  };
}
