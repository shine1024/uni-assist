// 결재 로그인 호스트의 POP3 조회 로직 테스트 (실제 메일 서버 없이 목으로 검증)
// 실행: node tools/test-host-pop3.mjs  (먼저 host/ 에서 npm ci)
import { readFileSync } from "node:fs";
import {
  Pop3Error,
  classifyLoginError,
  extractCode,
  htmlToPlain,
  latestOtp,
  matchesSender,
  normalizeConfig,
} from "../host/pop3.js";

let pass = 0;
let fail = 0;
function eq(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}\n    기대: ${JSON.stringify(expected)}\n    실제: ${JSON.stringify(actual)}`);
  }
}

const SENDER = "otp@corp.example";
const SECRET = "s3cret-mail-pw";
const config = normalizeConfig({
  pop3: { host: "mail.corp.example", port: 995, user: "me" },
  otp: {
    from: SENDER,
    subjectPattern: "인증번호",
    codePattern: "\\b(\\d{6})\\b",
  },
});

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const subject = `=?UTF-8?B?${b64("결재 인증번호 안내")}?=`;
const header = (from = SENDER, subj = subject) => `From: ${from}\r\nSubject: ${subj}\r\nMIME-Version: 1.0\r\n`;

function textMail(code, from) {
  return `${header(from)}Content-Type: text/plain; charset=utf-8\r\n\r\n인증번호는 ${code} 입니다.\r\n`;
}
function htmlMail(code) {
  return `${header()}Content-Type: text/html; charset=utf-8\r\n\r\n<style>.a{color:#654321}</style><p>인증번호 <b>${code}</b></p>\r\n`;
}
function base64Mail(code) {
  return `${header()}Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(`인증번호: ${code}`)}\r\n`;
}
const noCodeMail = () => `${header()}Content-Type: text/plain; charset=utf-8\r\n\r\n번호가 없는 메일\r\n`;

/** cycles[i] = i 번째 접속에서 보이는 메일 목록 또는 { openError } / { uidlError } / { hang:true } */
function mockServer(cycles) {
  const calls = [];
  let index = 0;
  const createClient = () => {
    const cycle = cycles[Math.min(index++, cycles.length - 1)];
    const raw = (num) => cycle.mails.find((m) => m.num === num).raw;
    const client = {
      async open() {
        calls.push("open");
        if (cycle.hang) await new Promise(() => {});
        if (cycle.openError) throw cycle.openError;
      },
      async uidl() {
        calls.push("uidl");
        if (cycle.uidlError) throw cycle.uidlError;
        return cycle.mails.map((m) => [m.num, m.uid]);
      },
      async top(num) {
        calls.push(`top:${num}`);
        return Buffer.from(raw(num).split("\r\n\r\n")[0] + "\r\n\r\n");
      },
      async retr(num) {
        calls.push(`retr:${num}`);
        return Buffer.from(raw(num));
      },
      async quit() {
        calls.push("quit");
      },
      destroy() {
        calls.push("destroy");
      },
    };
    return new Proxy(client, {
      get(target, prop) {
        if (!(prop in target) && typeof prop === "string") calls.push(`unexpected:${prop}`);
        return target[prop];
      },
    });
  };
  return { deps: { createClient }, calls };
}

async function failure(promise) {
  try {
    await promise;
    return "no-error";
  } catch (err) {
    return err.code;
  }
}

const mail = (num, uid, raw) => ({ num, uid, raw });
const connectFail = () => new Pop3Error("POP3_CONNECT_FAILED", "접속 실패");

console.log("인증번호 추출");
{
  const re = config.codeRe;
  eq(extractCode({ text: "번호 123456 입니다" }, re), "123456", "text 본문");
  eq(extractCode({ text: "", html: "<p>번호 <b>234567</b></p>" }, re), "234567", "html 본문");
  eq(extractCode({ html: "<style>a{color:#112233}</style><p>345678</p>" }, re), "345678", "style 안의 숫자는 무시");
  eq(extractCode({ html: "<p>&#123456; 번호 없음</p>" }, re), null, "숫자 엔티티를 번호로 오인하지 않음");
  eq(extractCode({ text: "번호 없음" }, re), null, "번호 없는 메일");
  eq(extractCode({ text: "인증번호456789입니다" }, re), "456789", "한글에 붙은 번호");
  eq(htmlToPlain("<div>a</div><!-- 999999 -->b").includes("999999"), false, "html 주석 제거");

  const example = JSON.parse(readFileSync(new URL("../host/config.example.json", import.meta.url), "utf8"));
  const eightDigits = new RegExp(example.otp.codePattern);
  const table = (code) =>
    `<p>발송일 20261110</p><table><tr><th>인증번호</th><td><span style="color:#e33">${code}</span></td></tr></table>`;
  eq(extractCode({ html: table("12663686") }, eightDigits), "12663686", "기본 패턴: 표 형식 8자리 메일");
  eq(extractCode({ text: "인증번호\n\n12663686\n" }, eightDigits), "12663686", "기본 패턴: 줄바꿈으로 나뉜 text 본문");
  eq(extractCode({ text: "인증번호를 입력하세요. 유효시간 5분\n인증번호: 12663686" }, eightDigits), "12663686", "기본 패턴: 안내 문구의 숫자는 건너뜀");
  eq(extractCode({ html: "<p>발송일 20261110</p>" }, eightDigits), null, "기본 패턴: 날짜를 번호로 오인하지 않음");
  eq(extractCode({ text: "인증번호 1266368" }, eightDigits), null, "기본 패턴: 7자리는 무시");
}

console.log("발신자 판별");
{
  const of = (...addresses) => ({ from: { value: addresses.map((address) => ({ address })) } });
  eq(matchesSender(of("OTP@Corp.Example"), SENDER), true, "대소문자 무시");
  eq(matchesSender(of("evil@x.example"), SENDER), false, "다른 발신자");
  eq(matchesSender(of(SENDER, "evil@x.example"), SENDER), false, "발신자가 여러 개면 거부");
  eq(matchesSender({}, SENDER), false, "From 없음");
}

console.log("설정 검증");
{
  const base = () => ({
    pop3: { host: "h", port: 995, user: "u" },
    otp: { from: "a@b", subjectPattern: "x", codePattern: "\\d" },
  });
  const codeOf = (mutate) => {
    const raw = base();
    mutate(raw);
    try {
      normalizeConfig(raw);
      return "ok";
    } catch (err) {
      return err.code;
    }
  };
  eq(codeOf(() => {}), "ok", "정상 설정");
  eq(codeOf((r) => (r.pop3.port = 110)), "CONFIG_INVALID", "평문 110 포트 거부");
  eq(codeOf((r) => (r.pop3.host = "TODO")), "CONFIG_INVALID", "TODO 값 거부");
  eq(codeOf((r) => (r.otp.subjectPattern = "(")), "CONFIG_INVALID", "잘못된 정규식 거부");
}

console.log("오류 분류");
{
  const server = (message) => Object.assign(new Error(message), { command: "PASS ***" });
  eq(classifyLoginError(server("invalid password")).code, "POP3_AUTH_FAILED", "인증 거부");
  eq(classifyLoginError(server("[IN-USE] mailbox busy")).code, "POP3_CONNECT_FAILED", "메일함 사용 중은 재시도 대상");
  eq(classifyLoginError(server("maildrop already locked")).code, "POP3_CONNECT_FAILED", "메일함 잠금은 재시도 대상");
  eq(classifyLoginError(new Error("close")).code, "POP3_CONNECT_FAILED", "소켓 오류");
  eq(classifyLoginError(server("bad " + SECRET)).message.includes(SECRET), false, "서버 원문을 메시지에 넣지 않음");
}

console.log("latestOtp: 메일 형식과 조건");
{
  for (const [name, raw, code] of [
    ["html 메일", htmlMail("555555"), "555555"],
    ["Base64 메일", base64Mail("666666"), "666666"],
  ]) {
    const server = mockServer([{ mails: [mail("1", "m", raw)] }]);
    eq((await latestOtp(config, SECRET, {}, server.deps)).code, code, name);
  }

  const wrong = mockServer([{ mails: [mail("1", "w", textMail("777777", "evil@x.example"))] }]);
  eq(await failure(latestOtp(config, SECRET, {}, wrong.deps)), "OTP_NOT_FOUND", "다른 발신자 메일 무시");
  eq(wrong.calls.includes("retr:1"), false, "헤더가 틀리면 본문을 받지 않음");

  const spoof = mockServer([{ mails: [mail("1", "s", textMail("777777", `"${SENDER}" <evil@x.example>`))] }]);
  eq(await failure(latestOtp(config, SECRET, {}, spoof.deps)), "OTP_NOT_FOUND", "표시 이름 위조 무시");

  const other = `${header(SENDER, "주간 공지")}Content-Type: text/plain\r\n\r\n888888\r\n`;
  const subj = mockServer([{ mails: [mail("1", "t", other)] }]);
  eq(await failure(latestOtp(config, SECRET, {}, subj.deps)), "OTP_NOT_FOUND", "제목이 다른 메일 무시");
}

console.log("latestOtp: 오류 처리");
{
  const auth = new Pop3Error("POP3_AUTH_FAILED", "실패");
  const denied = mockServer([{ openError: auth, mails: [] }]);
  eq(await failure(latestOtp(config, SECRET, {}, denied.deps)), "POP3_AUTH_FAILED", "인증 실패");
  eq(denied.calls.filter((c) => c === "open").length, 1, "인증 실패는 재시도 안 함");

  const noUidl = mockServer([{ uidlError: new Pop3Error("UNSUPPORTED_UIDL", "미지원"), mails: [] }]);
  eq(await failure(latestOtp(config, SECRET, {}, noUidl.deps)), "UNSUPPORTED_UIDL", "UIDL 미지원은 중단");

  const controller = new AbortController();
  const waiting = mockServer([{ hang: true, mails: [] }]);
  const aborted = failure(latestOtp(config, SECRET, { signal: controller.signal }, waiting.deps));
  setTimeout(() => controller.abort(), 10);
  eq(await aborted, "ABORTED", "포트가 끊기면 즉시 중단");
  eq(waiting.calls.includes("destroy"), true, "멈춘 소켓 정리");
}

console.log("latestOtp: 인증번호 확인");
{
  const dated = (code, date, from) => `Date: ${date}\r\n${textMail(code, from)}`;
  const older = mail("1", "a", dated("111111", "Tue, 10 Nov 2026 01:00:00 +0000"));
  const newer = mail("2", "b", dated("222222", "Tue, 10 Nov 2026 02:00:00 +0000"));
  const other = mail("3", "c", dated("333333", "Tue, 10 Nov 2026 03:00:00 +0000", "evil@x.example"));
  const latest = mockServer([{ mails: [older, newer, other] }]);
  eq(await latestOtp(config, SECRET, {}, latest.deps), { code: "222222", receivedAt: "2026-11-10T02:00:00.000Z" }, "가장 최근 인증 메일의 번호와 수신 시각");
  eq(latest.calls.includes("retr:3"), false, "다른 발신자 메일 본문은 받지 않음");
  eq(latest.calls.includes("top:1"), false, "찾은 뒤로는 이전 메일을 보지 않음");
  eq(latest.calls.at(-2), "quit", "조회 후 QUIT");

  const none = mockServer([{ mails: [other] }]);
  eq(await failure(latestOtp(config, SECRET, {}, none.deps)), "OTP_NOT_FOUND", "인증 메일이 없음");

  const noCode = mockServer([{ mails: [older, mail("2", "n", noCodeMail())] }]);
  eq(await failure(latestOtp(config, SECRET, {}, noCode.deps)), "OTP_PARSE_FAILED", "최신 메일에 번호가 없으면 이전 번호로 대체하지 않음");

  const undated = mockServer([{ mails: [mail("1", "u", textMail("444444"))] }]);
  eq(await latestOtp(config, SECRET, {}, undated.deps), { code: "444444", receivedAt: null }, "Date 헤더가 없어도 동작");

  const many = Array.from({ length: 40 }, (_, i) => mail(String(i + 1), `x${i}`, textMail("555555", "evil@x.example")));
  const scan = mockServer([{ mails: many }]);
  await failure(latestOtp(config, SECRET, {}, scan.deps));
  eq(scan.calls.filter((c) => c.startsWith("top:")).length, 30, "최근 30통까지만 확인");

  const down = mockServer([{ openError: connectFail(), mails: [] }]);
  eq(await failure(latestOtp(config, SECRET, {}, down.deps)), "POP3_CONNECT_FAILED", "접속 실패");
}

console.log("메일함 보존·출력 규칙");
{
  const server = mockServer([{ mails: [mail("1", "a", noCodeMail()), mail("2", "b", textMail("123123"))] }]);
  await latestOtp(config, SECRET, {}, server.deps);
  eq(server.calls.filter((c) => c.startsWith("unexpected:")), [], "허용된 명령 외 호출 없음");

  const source = readFileSync(new URL("../host/pop3.js", import.meta.url), "utf8");
  eq(/\bDELE\b/i.test(source), false, "메일 삭제 명령이 코드에 없음");
  eq(/console\.\w+/.test(source), false, "호스트 모듈에 console 출력 없음");
  eq(/process\.stdout/.test(source), false, "호스트 모듈이 stdout 에 쓰지 않음");
  eq(/tls:\s*true/.test(source), true, "TLS 고정");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
