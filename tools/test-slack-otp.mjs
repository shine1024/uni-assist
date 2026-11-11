// 2차 인증 OTP — 슬랙 DM 조회 테스트 (가짜 fetch 로 검증, 네트워크 없음)
// 실행: node tools/test-slack-otp.mjs
import {
  buildAuthUrl,
  createSlackClient,
  exchangeCode,
  fetchLatestOtp,
  findCode,
  otpCandidates,
  parseAuthRedirect,
  toText,
  validateSlackConfig,
} from "../src/lib/slack-otp.js";

let pass = 0;
let fail = 0;
function eq(actual, expected, name) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}\n    기대: ${JSON.stringify(expected)}\n    실제: ${JSON.stringify(actual)}`);
  }
}
async function codeOf(promiseOrFn) {
  try {
    await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
    return "no-error";
  } catch (e) {
    return e.code || e.message;
  }
}

/** routes: { "method": (params) => body } — slack.com/api/<method> 응답, 그 밖의 URL 은 files 다운로드 */
function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = new URL(url);
    const method = u.pathname.replace("/api/", "");
    const handler = routes[u.hostname === "slack.com" ? method : u.href];
    if (!handler) throw new Error("no route " + url);
    const body = handler(Object.fromEntries(u.searchParams), init);
    if (body && body.__status) return { status: body.__status, json: async () => ({}), text: async () => "" };
    return { status: 200, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
}

const TITLE = "로그인 2차 인증 번호";

console.log("본문에서 번호 찾기");
eq(findCode(["인증번호 12345678"]), "12345678", "기본 형식");
eq(findCode(["인증번호 : 87654321 입니다"]), "87654321", "콜론과 공백");
eq(findCode(["<p>인증번호&nbsp;<b>11223344</b></p>"]), "11223344", "HTML·엔티티");
eq(findCode(["인증번호 123456789"]), null, "9자리는 거부");
eq(findCode([null, "", "본문 없음", "인증번호 55556666"]), "55556666", "여러 후보 중 첫 일치");
eq(findCode([JSON.stringify({ "body-plain": "인증번호 99990000" })]), "99990000", "메일 JSON 원본");
eq(toText("<style>.a{}</style>A&amp;B"), " A&B", "스타일 제거·엔티티 해제");

console.log("후보 메일 고르기");
const messages = [
  { ts: "1700000100.000200", files: [{ id: "F3", title: `[유니포스트] ${TITLE} 발급 안내` }] },
  { ts: "1700000050.000100", files: [{ id: "F2", title: "다른 메일" }] },
  { ts: "1700000200.000300", files: [{ id: "F4", name: `${TITLE}.eml` }] },
  { ts: "1700000010.000000", text: "파일 없음" },
];
eq(otpCandidates(messages, { titleKeyword: TITLE }).map((c) => c.file.id), ["F4", "F3"], "제목 문구로 고르고 최신순");
eq(
  otpCandidates(messages, { titleKeyword: TITLE, lastUsedTs: "1700000100.000200" }).map((c) => c.file.id),
  ["F4"],
  "이미 쓴 메일과 그 이전은 제외"
);

console.log("DM 조회");
{
  const calls = [];
  const fetchFn = fakeFetch(
    {
      "conversations.history": (p) => {
        eq([p.channel, p.oldest, p.limit], ["D1", "1700000000", "20"], "history 요청 값");
        return { ok: true, messages };
      },
      "files.info": (p) =>
        p.file === "F4"
          ? { ok: true, file: { id: "F4", url_private_download: "https://files.slack.com/F4" } }
          : { ok: true, file: { preview: "인증번호 33334444" } },
      "https://files.slack.com/F4": () => "본문 인증번호 12121212",
    },
    calls
  );
  const client = createSlackClient("xoxp-test", fetchFn);
  const found = await fetchLatestOtp(client, { channelId: "D1", oldest: 1700000000, lastUsedTs: "0", titleKeyword: TITLE });
  eq([found.code, found.ts], ["12121212", "1700000200.000300"], "미리보기에 없으면 원본을 받아 번호를 찾음");
  eq(found.receivedAt, new Date(1700000200000.3).toISOString(), "수신 시각");
  eq(calls.every((c) => c.init.headers && c.init.headers.Authorization === "Bearer xoxp-test"), true, "모든 요청에 토큰 헤더");

  const none = await fetchLatestOtp(createSlackClient("t", fakeFetch({ "conversations.history": () => ({ ok: true, messages: [] }) })), {
    channelId: "D1",
    oldest: 1,
    lastUsedTs: "0",
    titleKeyword: TITLE,
  });
  eq(none, null, "아직 메일이 없으면 null (기다렸다 다시 묻는다)");
}

console.log("오류 분류");
{
  const withError = (error) => createSlackClient("t", fakeFetch({ "auth.test": () => ({ ok: false, error }) }));
  eq(await codeOf(withError("invalid_auth").me()), "SLACK_TOKEN_INVALID", "만료·폐기된 토큰");
  eq(await codeOf(withError("missing_scope").me()), "SLACK_MISSING_SCOPE", "권한 부족");
  eq(await codeOf(withError("something_new").me()), "SLACK_ERROR", "모르는 오류");
  const rate = createSlackClient("t", fakeFetch({ "auth.test": () => ({ __status: 429 }) }));
  eq(await codeOf(rate.me()), "SLACK_RATE_LIMITED", "429 는 요청 과다");
  const offline = createSlackClient("t", async () => {
    throw new TypeError("Failed to fetch");
  });
  eq(await codeOf(offline.me()), "SLACK_NETWORK", "네트워크 오류");
}

console.log("본인 DM 찾기");
{
  let page = 0;
  const client = createSlackClient(
    "t",
    fakeFetch({
      "conversations.list": (p) => {
        page++;
        return p.cursor
          ? { ok: true, channels: [{ id: "D_SELF", user: "U1" }] }
          : { ok: true, channels: [{ id: "D_OTHER", user: "U2" }], response_metadata: { next_cursor: "c2" } };
      },
    })
  );
  eq(await client.findSelfDm("U1"), "D_SELF", "다음 페이지까지 찾아봄");
  eq(page, 2, "두 페이지 조회");
  const empty = createSlackClient("t", fakeFetch({ "conversations.list": () => ({ ok: true, channels: [] }) }));
  eq(await codeOf(empty.findSelfDm("U1")), "SLACK_DM_NOT_FOUND", "없으면 안내");
}

console.log("OAuth");
{
  const url = new URL(buildAuthUrl({ clientId: "C1", redirectUri: "https://x.chromiumapp.org/", state: "S" }));
  eq(
    [url.origin + url.pathname, url.searchParams.get("user_scope"), url.searchParams.get("state")],
    ["https://slack.com/oauth/v2/authorize", "im:history,im:read,files:read", "S"],
    "인증 주소에 사용자 권한과 state"
  );
  eq(parseAuthRedirect("https://x.chromiumapp.org/?code=abc&state=S", "S"), "abc", "code 추출");
  eq(await codeOf(() => parseAuthRedirect("https://x.chromiumapp.org/?code=abc&state=EVIL", "S")), "SLACK_AUTH_FAILED", "state 불일치 거부");
  eq(await codeOf(() => parseAuthRedirect("https://x.chromiumapp.org/?error=access_denied&state=S", "S")), "SLACK_AUTH_CANCELLED", "사용자가 거부");

  eq(await codeOf(() => validateSlackConfig(null)), "SLACK_CONFIG_MISSING", "설정 파일 없음");
  eq(await codeOf(() => validateSlackConfig({ clientId: "TODO", clientSecret: "TODO" })), "SLACK_CONFIG_MISSING", "예시 값 그대로");
  eq(validateSlackConfig({ clientId: " C1 ", clientSecret: "S1" }), { clientId: "C1", clientSecret: "S1" }, "정상 값");

  const calls = [];
  const ok = fakeFetch({ "oauth.v2.access": () => ({ ok: true, authed_user: { access_token: "xoxp-1" } }) }, calls);
  eq(await exchangeCode({ clientId: "C1", clientSecret: "S1", code: "abc", redirectUri: "r" }, ok), "xoxp-1", "사용자 토큰 발급");
  eq([calls[0].init.method, calls[0].init.body.get("client_secret")], ["POST", "S1"], "Secret 은 POST 본문으로만 보냄");
  const badSecret = fakeFetch({ "oauth.v2.access": () => ({ ok: false, error: "bad_client_secret" }) });
  eq(await codeOf(exchangeCode({ clientId: "C", clientSecret: "S", code: "c", redirectUri: "r" }, badSecret)), "SLACK_CONFIG_INVALID", "Secret 오타");
  const noUser = fakeFetch({ "oauth.v2.access": () => ({ ok: true, access_token: "xoxb-bot" }) });
  eq(await codeOf(exchangeCode({ clientId: "C", clientSecret: "S", code: "c", redirectUri: "r" }, noUser)), "SLACK_MISSING_SCOPE", "사용자 토큰이 없으면 권한 안내");
}

console.log("슬랙 앱 정보 저장");
{
  const sync = {};
  let file = null;
  globalThis.chrome = {
    runtime: { getURL: (p) => `chrome-extension://x/${p}` },
    storage: {
      sync: {
        get: async (k) => (k in sync ? { [k]: sync[k] } : {}),
        set: async (o) => Object.assign(sync, o),
      },
    },
  };
  globalThis.fetch = async () => {
    if (!file) throw new TypeError("not found");
    return { json: async () => file };
  };
  const { K_SLACK_APP, loadSlackApp, saveSlackApp } = await import("../src/lib/slack-app.js");

  eq(await codeOf(loadSlackApp()), "SLACK_CONFIG_MISSING", "저장된 값도 파일도 없으면 입력 안내");
  file = { clientId: "C-file", clientSecret: "S-file" };
  eq(await loadSlackApp(), { clientId: "C-file", clientSecret: "S-file" }, "예전 slack-config.json 이 있으면 읽음");
  eq(sync[K_SLACK_APP], { clientId: "C-file", clientSecret: "S-file" }, "읽은 값은 동기화 저장소로 옮김");
  file = null;
  eq((await loadSlackApp()).clientId, "C-file", "이후에는 파일 없이도 동작");
  eq(await codeOf(saveSlackApp({ clientId: "C2", clientSecret: " " })), "SLACK_CONFIG_MISSING", "빈 Secret 거부");
  await saveSlackApp({ clientId: " C2 ", clientSecret: "S2" });
  eq(sync[K_SLACK_APP], { clientId: "C2", clientSecret: "S2" }, "패널에서 입력한 값 저장");
  eq(K_SLACK_APP.startsWith("ua_"), false, "백업 파일에 들어가지 않는 키(ua_ 접두어 없음)");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
