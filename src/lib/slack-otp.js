// 2차 인증 OTP — 슬랙 DM 에서 인증 메일의 번호 찾기 (크롬 API 비의존 → 단위 테스트 가능)
//
// 메일→슬랙 연동이 인증 메일을 본인 DM 에 "메일 파일"로 올린다. 그 파일의 제목으로 인증 메일을 고르고
// 본문에서 8자리 번호를 꺼낸다. (unipost-2fa-helper 에서 검증한 방식)
// 토큰은 서비스 워커·사이드 패널에서만 다루고 웹페이지로 넘기지 않는다. 오류 메시지에 토큰·번호를 넣지 않는다.
import { ApprovalError } from "./approval-flow.js";

export const SLACK_API = "https://slack.com/api/";
export const SLACK_SCOPES = ["im:history", "im:read", "files:read"];
export const DEFAULT_TITLE_KEYWORD = "로그인 2차 인증 번호";
export const CODE_REGEX = /인증번호\D{0,20}?(\d{8})(?!\d)/;

// ---- 본문 해석 ------------------------------------------------------------

// 서비스 워커에는 DOMParser 가 없어 직접 디코딩한다.
export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

export function toText(s) {
  return decodeEntities(
    String(s || "")
      .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ");
}

/** 여러 후보(미리보기, 원본) 중 처음으로 번호가 나오는 곳에서 꺼낸다. 원본이 메일 JSON 이면 본문 필드를 본다. */
export function findCode(sources, codeRe = CODE_REGEX) {
  for (const src of sources) {
    if (!src) continue;
    let text = src;
    try {
      const mail = JSON.parse(src);
      if (mail && typeof mail === "object") {
        text = mail["body-plain"] || mail["body-plain-without-links"] || mail["body-html"] || src;
      }
    } catch {
      /* JSON 아님 */
    }
    const m = toText(text).match(codeRe);
    if (m) return m[1];
  }
  return null;
}

/** 최신순 메시지에서 아직 쓰지 않은 인증 메일 파일 후보를 고른다. */
export function otpCandidates(messages, { titleKeyword = DEFAULT_TITLE_KEYWORD, lastUsedTs = "0" } = {}) {
  const used = parseFloat(lastUsedTs) || 0;
  const out = [];
  for (const msg of messages || []) {
    if (!(parseFloat(msg.ts) > used)) continue;
    const file = (msg.files || []).find((f) => String(f.title || f.name || "").includes(titleKeyword));
    if (file) out.push({ ts: msg.ts, file });
  }
  return out.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
}

export const tsToIso = (ts) => {
  const ms = parseFloat(ts) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

// ---- OAuth ----------------------------------------------------------------

export function buildAuthUrl({ clientId, redirectUri, state, scopes = SLACK_SCOPES }) {
  return (
    "https://slack.com/oauth/v2/authorize?" +
    new URLSearchParams({ client_id: clientId, user_scope: scopes.join(","), redirect_uri: redirectUri, state })
  );
}

/** launchWebAuthFlow 가 돌려준 주소에서 code 를 꺼낸다. */
export function parseAuthRedirect(url, state) {
  const params = new URL(url).searchParams;
  const error = params.get("error");
  if (error) throw new ApprovalError(error === "access_denied" ? "SLACK_AUTH_CANCELLED" : "SLACK_AUTH_FAILED", error);
  if (params.get("state") !== state) throw new ApprovalError("SLACK_AUTH_FAILED", "state_mismatch");
  if (!params.get("code")) throw new ApprovalError("SLACK_AUTH_FAILED", "no_code");
  return params.get("code");
}

export function validateSlackConfig(cfg) {
  const ok = (v) => typeof v === "string" && v.trim() && !/^TODO\b/.test(v.trim());
  if (!cfg || !ok(cfg.clientId) || !ok(cfg.clientSecret)) throw new ApprovalError("SLACK_CONFIG_MISSING");
  return { clientId: cfg.clientId.trim(), clientSecret: cfg.clientSecret.trim() };
}

// ---- API ------------------------------------------------------------------

const API_ERRORS = {
  invalid_auth: "SLACK_TOKEN_INVALID",
  token_revoked: "SLACK_TOKEN_INVALID",
  token_expired: "SLACK_TOKEN_INVALID",
  not_authed: "SLACK_TOKEN_INVALID",
  account_inactive: "SLACK_TOKEN_INVALID",
  missing_scope: "SLACK_MISSING_SCOPE",
  channel_not_found: "SLACK_CHANNEL_NOT_FOUND",
  ratelimited: "SLACK_RATE_LIMITED",
};

/**
 * @param {string} token 사용자 토큰(xoxp-)
 * @param {typeof fetch} fetchFn
 */
export function createSlackClient(token, fetchFn = fetch) {
  async function call(method, params = {}) {
    let res;
    try {
      res = await fetchFn(`${SLACK_API}${method}?${new URLSearchParams(params)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      throw new ApprovalError("SLACK_NETWORK", e && e.message);
    }
    if (res.status === 429) throw new ApprovalError("SLACK_RATE_LIMITED");
    const data = await res.json().catch(() => null);
    if (!data) throw new ApprovalError("SLACK_ERROR", `${method} HTTP ${res.status}`);
    if (!data.ok) throw new ApprovalError(API_ERRORS[data.error] || "SLACK_ERROR", `${method}: ${data.error}`);
    return data;
  }

  return {
    call,
    async me() {
      const r = await call("auth.test");
      return { user: r.user, userId: r.user_id, team: r.team };
    },
    /** 본인과의 DM(나에게 보내기) 채널 */
    async findSelfDm(userId) {
      let cursor = "";
      for (let page = 0; page < 20; page++) {
        const params = { types: "im", limit: "200" };
        if (cursor) params.cursor = cursor;
        const r = await call("conversations.list", params);
        const self = (r.channels || []).find((c) => c.user === userId);
        if (self) return self.id;
        cursor = r.response_metadata && r.response_metadata.next_cursor;
        if (!cursor) break;
      }
      throw new ApprovalError("SLACK_DM_NOT_FOUND");
    },
    async codeFromFile(file, codeRe) {
      // 1) history 응답의 미리보기 → 2) files.info → 3) 원본 다운로드
      let code = findCode([file.plain_text, file.preview_plain_text, file.preview, file.simplified_html], codeRe);
      if (code) return code;
      const info = (await call("files.info", { file: file.id })).file || {};
      code = findCode([info.plain_text, info.preview_plain_text, info.preview, info.simplified_html], codeRe);
      if (code) return code;
      const url = info.url_private_download || info.url_private;
      if (!url) return null;
      try {
        const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
        return findCode([await res.text()], codeRe);
      } catch {
        throw new ApprovalError("SLACK_NETWORK");
      }
    },
    async revoke() {
      await call("auth.revoke");
    },
  };
}

/**
 * DM 에서 아직 쓰지 않은 가장 최근 인증번호. 없으면 null (호출한 쪽이 기다렸다 다시 묻는다).
 * @returns {Promise<{code:string, ts:string, receivedAt:string|null} | null>}
 */
export async function fetchLatestOtp(client, { channelId, oldest, lastUsedTs, titleKeyword, codeRe }) {
  const { messages = [] } = await client.call("conversations.history", {
    channel: channelId,
    oldest: String(oldest),
    limit: "20",
  });
  for (const { ts, file } of otpCandidates(messages, { titleKeyword, lastUsedTs })) {
    const code = await client.codeFromFile(file, codeRe);
    if (code) return { code, ts, receivedAt: tsToIso(ts) };
  }
  return null;
}

/** OAuth code → 사용자 토큰 */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri }, fetchFn = fetch) {
  let data;
  try {
    const res = await fetchFn(`${SLACK_API}oauth.v2.access`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    });
    data = await res.json();
  } catch (e) {
    throw new ApprovalError("SLACK_NETWORK", e && e.message);
  }
  if (!data || !data.ok) {
    const error = data ? String(data.error) : "no_response";
    const bad = /client_id|client_secret|redirect_uri/.test(error);
    throw new ApprovalError(bad ? "SLACK_CONFIG_INVALID" : "SLACK_AUTH_FAILED", `oauth.v2.access: ${error}`);
  }
  const token = data.authed_user && data.authed_user.access_token;
  if (!token) throw new ApprovalError("SLACK_MISSING_SCOPE");
  return token;
}
