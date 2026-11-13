// Claude 로그인 인증 — 보안 링크 메일 해석·검사 테스트 (네트워크 없음)
// 실행: node tools/test-claude-login.mjs
import { readFileSync } from "node:fs";
import {
  CLAUDE_LOGIN_CONFIG as CFG,
  LINK_SOURCES,
  decodeMime,
  describeCodeText,
  describeSources,
  findMagicLink,
  isAllowedLink,
  isLoggedInPath,
  normalizeCode,
  senderAllowed,
  senderDomain,
} from "../src/lib/claude-login.js";
import { createSlackClient } from "../src/lib/slack-otp.js";

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

const LINK = "https://claude.ai/magic-link#a1B2c3D4e5-_.x9";
const mailJson = (over = {}) =>
  JSON.stringify({
    from: "Anthropic <no-reply-ab12cd@mail.anthropic.com>",
    subject: "Claude의 보안 링크가 도착했습니다",
    "body-html": `<table><tr><td><a href="${LINK.replace("#", "#")}" style="x">로그인</a></td></tr></table>`,
    "body-plain": `로그인: ${LINK}`,
    ...over,
  });

console.log("링크 검사");
eq(isAllowedLink(LINK), true, "claude.ai/magic-link#토큰 허용");
eq(isAllowedLink("https://claude.ai/magic-link"), false, "토큰 없음 거절");
eq(isAllowedLink("https://claude.ai/magic-link#"), false, "빈 토큰 거절");
eq(isAllowedLink("http://claude.ai/magic-link#abc"), false, "http 거절");
eq(isAllowedLink("https://claude.ai.evil.com/magic-link#abc"), false, "비슷한 도메인 거절");
eq(isAllowedLink("https://evil.com/?claude.ai/magic-link#abc"), false, "다른 도메인 거절");
eq(isAllowedLink("https://user@claude.ai/magic-link#abc"), false, "사용자 정보 포함 거절");
eq(isAllowedLink("https://claude.ai:8443/magic-link#abc"), false, "다른 포트 거절");
eq(isAllowedLink("https://claude.ai/login#abc"), false, "다른 경로 거절");
eq(isAllowedLink("not a url"), false, "주소 아님 거절");

console.log("보낸 사람");
eq(senderAllowed("Anthropic <no-reply-x1@mail.anthropic.com>"), true, "이름 <주소> 형식");
eq(senderAllowed("no-reply-x1@MAIL.anthropic.com"), true, "대소문자 무시");
eq(senderAllowed("x@mail.anthropic.com.evil.com"), false, "뒤에 붙인 도메인 거절");
eq(senderAllowed("x@evil-mail.anthropic.com"), false, "다른 하위 도메인 거절");
eq(senderAllowed(undefined), true, "보낸 사람 정보가 없으면 통과(제목·링크 검사로 판단)");
eq(senderDomain([{ address: "no-reply-x@mail.anthropic.com", name: "Anthropic" }]), "mail.anthropic.com", "슬랙 형식 from [{ address }]");

console.log("메일에서 링크 찾기");
eq(findMagicLink([mailJson()]), LINK, "메일 JSON (html + plain 같은 링크)");
eq(findMagicLink([mailJson({ "body-html": `<a href="https://claude.ai/magic-link#a&amp;b">x</a>`, "body-plain": "" })]), "https://claude.ai/magic-link#a&b", "&amp; 디코딩");
eq(findMagicLink([mailJson({ from: "unipost_sw_ai@unipost.co.kr" })]), LINK, "회사 메일 전달로 보낸 사람이 바뀌어도 찾음 (링크 도메인으로 판단)");
eq(findMagicLink([JSON.stringify({ mail: { html: `<a href="${LINK}">로그인</a>` } })]), LINK, "필드 이름이 달라도(중첩 JSON) 찾음");
eq(findMagicLink([mailJson({ "body-html": `<a href="https://claude.ai.evil.com/magic-link#x">x</a>`, "body-plain": "" })]), null, "가짜 도메인 링크 무시");
eq(findMagicLink([mailJson({ "body-plain": "https://claude.ai/magic-link#other" })]), null, "서로 다른 링크가 둘이면 고르지 않음");
{
  // 메일 원본(MIME) — quoted-printable 은 76자마다 "=" 로 줄을 끊고 "=" 를 "=3D" 로 쓴다
  const token = "Zx9-" + "a".repeat(90) + "_Q";
  const html = `<a href=3D"https://claude.ai/magic-link#${token}" style=3D"x">=EB=A1=9C=EA=B7=B8=EC=9D=B8</a>`;
  const NL = String.fromCharCode(13, 10);
  const qp = html.match(/.{1,70}/g).join("=" + NL);
  const mime = [
    "From: Anthropic <no-reply-ab@mail.anthropic.com>",
    "Subject: =?UTF-8?B?Q2xhdWRl?=",
    'Content-Type: multipart/alternative; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    qp,
    "--b1--",
  ].join(NL);
  eq(findMagicLink([mime]), `https://claude.ai/magic-link#${token}`, "MIME quoted-printable 원본 (줄 끊김 복원)");
  eq(decodeMime(mime).includes("로그인"), true, "quoted-printable 한글 복원");
  const b64 = Buffer.from(`<a href="${LINK}">x</a>`).toString("base64");
  const mime64 = ["Content-Type: text/html", "Content-Transfer-Encoding: base64", "", b64, "--b2--"].join(NL);
  eq(findMagicLink([mime64]), LINK, "MIME base64 원본");
  eq(findMagicLink([{ name: "raw", text: "링크 없음" }, { name: "plain_text", text: `로그인 ( ${LINK} )` }]), LINK, "원본에 없으면 다음 후보(plain_text)");
  eq(LINK_SOURCES.includes("preview"), false, "잘릴 수 있는 미리보기는 링크 후보에서 제외");
  const d = describeSources([{ name: "raw", text: mime }]);
  eq([d[0].mime, d[0].links], [true, 1], "진단 요약: MIME 여부·링크 개수");
  eq(JSON.stringify(d).includes(token), false, "진단 요약에 링크가 들어가지 않음");
  eq(describeCodeText("12 ab"), { length: 5, digits: 2, letters: 2, other: 1 }, "코드 모양만 진단");
}
eq(findMagicLink([`<html><a href="${LINK}">로그인</a></html>`]), LINK, "JSON 이 아닌 원본 HTML");
eq(findMagicLink([null, "", "링크 없음"]), null, "링크 없음");
eq(findMagicLink([`"${LINK}"`]), LINK, "따옴표에서 끊음");

console.log("링크로 바로 로그인됐는지");
eq(["/new", "/", "/chats", "/project/abc"].map(isLoggedInPath), [true, true, true, true], "로그인 뒤 화면");
eq(["/login", "/login/sso", "/magic-link", "/logout"].map(isLoggedInPath), [false, false, false, false], "로그인·링크·로그아웃 화면은 아님");

console.log("코드");
eq(normalizeCode(" 123456 "), "123456", "공백 제거");
eq(normalizeCode("123-456"), "123456", "하이픈 제거");
eq(normalizeCode("12 34 56"), "123456", "띄어 쓴 숫자");
eq(normalizeCode("abc123"), null, "숫자 아님");
eq(normalizeCode("123"), null, "너무 짧음");
eq(normalizeCode("12345678901"), null, "너무 김");
eq(normalizeCode(null), null, "없음");

console.log("슬랙 메일 파일 후보");
{
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    const json = (body) => ({ status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.pathname === "/api/files.info")
      return json({ ok: true, file: { id: "F2", preview: "https://claude.ai/magic-link#trunc", plain_text: `로그인 ${LINK}`, url_private_download: "https://files.slack.com/F2" } });
    if (u.host === "files.slack.com") return { status: 200, text: async () => mailJson() };
    return json({ ok: false, error: "unknown" });
  };
  const client = createSlackClient("xoxp-test", fetchFn);
  const { sources } = await client.fileSources({ id: "F2" });
  eq(sources.map((x) => x.name), ["raw", "plain_text", "preview"], "원본 + files.info 본문 필드");
  const pick = findMagicLink(LINK_SOURCES.map((n) => sources.find((x) => x.name === n)).filter(Boolean));
  eq(pick, LINK, "잘린 미리보기가 아니라 원본의 링크");
  eq(calls.some((c) => c.startsWith("https://files.slack.com/")), true, "원본 다운로드");
}

console.log("범위·권한");
{
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const auto = read("src/content/claude-auto.js");
  const dup = (name) => (auto.match(new RegExp(`const ${name} = ([^;]+);`)) || [])[1];
  const q = (s) => (s.includes('"') ? `'${s}'` : JSON.stringify(s));
  eq(
    [dup("CODE_INPUT"), dup("SUBMIT"), dup("SUBMIT_WAIT_MS"), dup("POLL_INTERVAL_MS"), dup("WAIT_MS"), dup("LOOKBACK_SEC"), dup("LINK_PATH")],
    [
      q(CFG.selectors.codeInput),
      q(CFG.selectors.submit),
      String(CFG.submitWaitMs),
      String(CFG.pollIntervalMs),
      String(CFG.waitMs),
      String(CFG.lookbackSec),
      JSON.stringify(CFG.linkPath),
    ],
    "claude-auto.js 복제 값이 claude-login.js 와 일치"
  );
  eq(/token|magic-link#|tabs\./.test(auto), false, "자동 입력 스크립트는 토큰·링크·탭을 다루지 않음");

  const bg = read("src/background/claude-login.js") + read("src/lib/claude-login.js");
  eq(/console\.\w+/.test(bg), false, "console 출력 없음 (링크가 로그에 남지 않게)");
  eq(/chrome\.storage\.sync/.test(bg), false, "동기화 저장소에 두지 않음");
  eq(/storage\.\w+\.set\([^)]*link/i.test(bg), false, "링크를 저장하지 않음");
  eq(/active:\s*true/.test(bg) && /tabs\.update\(backTo/.test(bg), true, "링크 탭은 잠깐 앞으로 띄우고 원래 탭으로 돌아감 (D4 변경 — 숨긴 탭은 화면을 안 그림)");
  eq(/tabs\.remove\(tab\.id\)/.test(bg), true, "링크 탭을 닫는다");

  const sw = read("src/background/service-worker.js");
  eq(/CLAUDE_AUTO_FETCH[\s\S]{0,200}isClaudeAutoSender/.test(sw), true, "자동 입력 요청은 보낸 곳을 확인");
  {
    // 진단 기록(note)에는 링크·읽은 글자·코드 변수를 그대로 넣지 않는다 (모양 요약 describeCodeText 만 허용)
    const notes = read("src/background/claude-login.js").match(/\bnote\([^\n]*\);/g) || [];
    const leaky = notes
      .map((n) => n.replace(/"[^"]*"/g, '""').replace(/describeCodeText\(text\)/g, ""))
      .filter((n) => /\b(link|text)\b/.test(n) || /[{,]\s*code\s*[,}]/.test(n));
    eq([notes.length > 5, leaky], [true, []], "진단 기록에 링크·코드 변수를 넣지 않음");
  }
  eq(/claudeAction[\s\S]{0,300}isExtensionPage/.test(sw), true, "패널 요청은 확장 페이지에서만");

  const html = read("src/sidepanel/sidepanel.html");
  eq(html.includes('data-view="claude"') && html.includes('id="view-claude"'), true, "새 메뉴 「Claude 로그인 인증」 (D1)");
  eq(/id="claude-autofill"(?![^>]*checked)/.test(html), true, "자동 입력은 기본 꺼짐 (D2)");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
