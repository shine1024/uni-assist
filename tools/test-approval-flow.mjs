// 2차 인증 OTP 테스트 (브라우저 없이 가짜 입출력으로 검증)
// 실행: node tools/test-approval-flow.mjs
import { readFileSync } from "node:fs";
import { createHostClient, isExtensionPage, messageForError } from "../src/lib/approval-flow.js";
import { pageFillOtp } from "../src/background/approval-page-actions.js";

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

async function failure(promise) {
  try {
    await promise;
    return "no-error";
  } catch (err) {
    return err.code;
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("요청 출처");
{
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const panel = { id, url: `chrome-extension://${id}/src/sidepanel/sidepanel.html` };
  eq(isExtensionPage(panel, id), true, "사이드 패널 허용");
  eq(isExtensionPage({ ...panel, tab: { id: 1 }, url: "https://evil.example/" }, id), false, "웹페이지 콘텐츠 스크립트 거부");
  eq(isExtensionPage({ ...panel, id: "other" }, id), false, "다른 확장 거부");
  eq(isExtensionPage(undefined, id), false, "발신자 없음 거부");
}

console.log("호스트 포트");
{
  function fakePort() {
    const listeners = {};
    return {
      sent: [],
      disconnected: false,
      onMessage: { addListener: (fn) => (listeners.message = fn) },
      onDisconnect: { addListener: (fn) => (listeners.disconnect = fn) },
      postMessage(message) {
        this.sent.push(message);
      },
      disconnect() {
        this.disconnected = true;
      },
      emit: (message) => listeners.message(message),
      drop: () => listeners.disconnect(),
    };
  }

  const port = fakePort();
  const client = createHostClient(port);
  const first = client.latestOtp();
  const second = client.ping();
  eq(port.sent[0], { id: 1, type: "latestOtp" }, "latestOtp 요청 형식");
  port.emit({ id: 2, ok: true, version: "1" });
  port.emit({ id: 1, ok: true, code: "87654321", receivedAt: null });
  eq([(await first).code, (await second).version], ["87654321", "1"], "응답 순서가 달라도 id 로 짝지음");

  const third = client.latestOtp();
  port.emit({ id: 3, ok: false, error: { code: "CREDENTIAL_MISSING", message: "x" } });
  eq(await failure(third), "CREDENTIAL_MISSING", "호스트 오류 코드 전달");

  const waiting = client.latestOtp();
  port.drop();
  eq(await failure(waiting), "HOST_NOT_FOUND", "포트가 끊기면 실패로 끝남");
  eq(await failure(client.ping()), "HOST_NOT_FOUND", "끊긴 뒤 요청은 즉시 실패");

  const quiet = fakePort();
  const closing = createHostClient(quiet);
  const inFlight = closing.ping();
  closing.close();
  eq(quiet.disconnected, true, "close 는 포트를 끊음");
  eq(await failure(inFlight), "HOST_NOT_FOUND", "대기 중인 요청 정리");
  eq(typeof closing.getCredentials, "undefined", "결재 비밀번호 요청 경로 없음");
}

console.log("안내 문구");
{
  eq(messageForError({ code: "OTP_NOT_FOUND" }).includes("인증 메일"), true, "인증 메일 없음 안내");
  eq(messageForError({ code: "POP3_AUTH_FAILED" }).includes("계정"), true, "로그인 실패는 계정도 확인하도록 안내");
  eq(messageForError({ code: "OTP_INPUT_NOT_FOUND" }).includes("입력칸"), true, "입력칸 없음 안내");
}

console.log("페이지 입력");
{
  class FakeInput {
    value = "";
    events = [];
    focused = false;
    rects = 1;
    getClientRects() {
      return { length: this.rects };
    }
    focus() {
      this.focused = true;
    }
    dispatchEvent(event) {
      this.events.push(event.type);
    }
  }
  const fakeButton = (disabled = false, rects = 1) => ({
    disabled,
    clicks: 0,
    getClientRects: () => ({ length: rects }),
    click() {
      this.clicks++;
    },
  });
  globalThis.HTMLInputElement = class {};
  Object.defineProperty(globalThis.HTMLInputElement.prototype, "value", {
    set(v) {
      this._nativeSet = true;
      this.value = v;
    },
    get() {
      return "";
    },
    configurable: true,
  });
  const page = (inputs, buttons) => {
    globalThis.document = { querySelectorAll: (s) => (s === "#in" ? inputs : s === "#ok" ? buttons : []) };
  };
  const run = (waitMs = 0) => pageFillOtp({ inputSelector: "#in", submitSelector: "#ok", code: "12663686", waitMs });

  const input = new FakeInput();
  const button = fakeButton();
  page([input], [button]);
  eq(await run(), { ok: true }, "입력 후 확인 성공");
  await tick();
  eq([input.value, input.focused, input.events, button.clicks], ["12663686", true, ["input", "change"], 1], "값 입력, 이벤트 발생, 확인 1회 클릭");

  page([], [button]);
  eq(await run(), { ok: false, code: "OTP_INPUT_NOT_FOUND" }, "입력칸이 없으면 아무것도 누르지 않음");

  const hidden = new FakeInput();
  hidden.rects = 0;
  page([hidden], [fakeButton()]);
  eq((await run()).code, "OTP_INPUT_NOT_FOUND", "보이지 않는 입력칸은 사용 안 함");

  const skipped = fakeButton(false, 0);
  const shown = fakeButton();
  page([new FakeInput()], [skipped, shown]);
  await run();
  await tick();
  eq([skipped.clicks, shown.clicks], [0, 1], "보이는 확인 버튼만 클릭");

  const disabled = fakeButton(true);
  page([new FakeInput()], [disabled]);
  eq((await run()).code, "OTP_SUBMIT_NOT_FOUND", "비활성 버튼은 누르지 않음");

  const late = fakeButton(true);
  page([new FakeInput()], [late]);
  setTimeout(() => (late.disabled = false), 20);
  eq(await run(500), { ok: true }, "입력 뒤 버튼이 활성화되면 클릭");
  await tick();
  eq(late.clicks, 1, "활성화 후 1회 클릭");
}

console.log("현재 탭 입력");
{
  const calls = [];
  let answer = () => [{ result: { ok: true } }];
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 5 }] },
    scripting: {
      executeScript: async (options) => {
        calls.push(options);
        return answer();
      },
    },
  };
  const { fillOtpInActiveTab } = await import("../src/background/approval.js");

  eq(await fillOtpInActiveTab("12663686"), { ok: true }, "입력 성공");
  eq([calls[0].target, calls[0].args[0].inputSelector, calls[0].args[0].submitSelector], [{ tabId: 5, allFrames: true }, "input.fid-authPass", ".bid-confirm"], "지정한 입력칸·버튼을 현재 탭 전체 프레임에서 찾음");
  eq(calls[0].args[0].code, "12663686", "인증번호 전달");

  answer = () => [{ result: { ok: false, code: "OTP_INPUT_NOT_FOUND" } }, { result: { ok: true } }];
  eq((await fillOtpInActiveTab("1")).ok, true, "프레임 안의 화면에서 성공");

  answer = () => [{ result: { ok: false, code: "OTP_INPUT_NOT_FOUND" } }];
  eq((await fillOtpInActiveTab("1")).code, "OTP_INPUT_NOT_FOUND", "입력칸 없음");

  answer = () => [{ result: { ok: false, code: "OTP_INPUT_NOT_FOUND" } }, { result: { ok: false, code: "OTP_SUBMIT_NOT_FOUND" } }];
  eq((await fillOtpInActiveTab("1")).code, "OTP_SUBMIT_NOT_FOUND", "입력칸은 있고 버튼이 없음");

  answer = () => {
    throw new Error("chrome://");
  };
  eq((await fillOtpInActiveTab("1")).code, "PAGE_ACTION_FAILED", "주입할 수 없는 탭");

  const before = calls.length;
  eq((await fillOtpInActiveTab("<img>")).code, "BAD_REQUEST", "숫자가 아니면 거부");
  eq(calls.length, before, "거부하면 페이지를 건드리지 않음");
}

console.log("범위·권한");
{
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const manifest = JSON.parse(read("manifest.json"));
  eq(manifest.permissions.includes("nativeMessaging"), true, "nativeMessaging 권한");
  eq(Object.hasOwn(manifest.commands, "approval-login"), false, "결재대기함 단축키 제거");
  const keys = Object.values(manifest.commands).map((c) => c.suggested_key.default);
  eq(new Set(keys).size, keys.length, "단축키 중복 없음");

  const sources = ["src/lib/approval-flow.js", "src/lib/approval-config.js", "src/background/approval.js", "src/background/approval-page-actions.js"];
  const combined = sources.map(read).join("\n");
  eq(/console\.\w+/.test(combined), false, "console 출력 없음");
  eq(/chrome\.storage/.test(combined), false, "chrome.storage 에 저장하지 않음");

  const panel = read("src/sidepanel/sidepanel.html") + read("src/sidepanel/approval.js") + read("src/background/service-worker.js");
  eq(/APPROVAL_RUN|btn-approval-run|결재대기함/.test(panel), false, "결재대기함 열기 화면·요청 제거");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
