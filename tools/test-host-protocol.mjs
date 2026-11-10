// 결재 로그인 호스트 프로토콜 테스트: 프레이밍 + 요청 처리 + 실제 프로세스 실행
// 실행: node tools/test-host-protocol.mjs  (먼저 host/ 에서 npm ci)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createDispatcher } from "../host/dispatch.js";
import { MAX_MESSAGE_BYTES, createFrameReader, encodeFrame } from "../host/framing.js";
import { Pop3Error } from "../host/pop3.js";

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

function collect() {
  const messages = [];
  const errors = [];
  return { messages, errors, push: createFrameReader((m) => messages.push(m), (e) => errors.push(e)) };
}

console.log("프레이밍");
{
  const frame = encodeFrame({ id: 1, text: "한글" });
  eq(frame.readUInt32LE(0), frame.length - 4, "길이는 리틀엔디언 4바이트");

  const split = collect();
  for (const byte of frame) split.push(Buffer.from([byte]));
  eq(split.messages, [{ id: 1, text: "한글" }], "1바이트씩 나뉘어 와도 파싱");

  const joined = collect();
  joined.push(Buffer.concat([encodeFrame({ id: 1 }), encodeFrame({ id: 2 }), encodeFrame({ id: 3 })]));
  eq(joined.messages.map((m) => m.id), [1, 2, 3], "여러 메시지가 붙어 와도 파싱");

  const mixed = collect();
  const whole = Buffer.concat([encodeFrame({ id: 1 }), encodeFrame({ id: 2 })]);
  mixed.push(whole.subarray(0, whole.length - 3));
  eq(mixed.messages.map((m) => m.id), [1], "완성된 메시지만 넘김");
  mixed.push(whole.subarray(whole.length - 3));
  eq(mixed.messages.map((m) => m.id), [1, 2], "나머지가 오면 이어서 파싱");

  const big = collect();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_MESSAGE_BYTES + 1, 0);
  big.push(header);
  eq(big.errors, ["too-large"], "1MB 초과 거부");

  const broken = collect();
  const bad = Buffer.from("{oops");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(bad.length, 0);
  broken.push(Buffer.concat([size, bad, encodeFrame({ id: 9 })]));
  eq([broken.errors, broken.messages.map((m) => m.id)], [["bad-json"], [9]], "깨진 JSON 뒤의 메시지는 계속 처리");

  let tooLarge = false;
  try {
    encodeFrame({ text: "x".repeat(MAX_MESSAGE_BYTES) });
  } catch {
    tooLarge = true;
  }
  eq(tooLarge, true, "1MB 초과 응답은 보내지 않음");
}

console.log("요청 처리");
{
  const sent = [];
  const secrets = { mail: "mail-pw" };
  const seen = {};
  const base = {
    version: "9.9.9",
    send: (m) => sent.push(m),
    signal: new AbortController().signal,
    loadConfig: () => ({}),
    getSecret: (a) => secrets[a],
    latestOtp: async (_c, password) => {
      seen.latestOtp = password;
      return { code: "87654321", receivedAt: null };
    },
  };
  const handle = createDispatcher(base);
  const last = () => sent[sent.length - 1];

  await handle({ id: 1, type: "ping" });
  eq(last(), { id: 1, ok: true, version: "9.9.9" }, "ping");
  await handle({ id: 10, type: "latestOtp" });
  eq(last(), { id: 10, ok: true, code: "87654321", receivedAt: null }, "latestOtp");
  eq(seen.latestOtp, "mail-pw", "latestOtp 는 메일 비밀번호만 사용");
  for (const type of ["getCredentials", "snapshot", "waitOtp"]) {
    await handle({ id: 11, type });
    eq(last().error.code, "BAD_REQUEST", `제거된 요청 거부: ${type}`);
  }
  await handle({ id: 5, type: "constructor" });
  eq(last().error.code, "BAD_REQUEST", "모르는 요청 거부");

  const failing = (patch) => createDispatcher({ ...base, ...patch });
  await failing({
    getSecret: () => {
      throw new Pop3Error("CREDENTIAL_MISSING", "없음");
    },
  })({ id: 6, type: "latestOtp" });
  eq(last(), { id: 6, ok: false, error: { code: "CREDENTIAL_MISSING", message: "없음" } }, "코드가 있는 오류 전달");

  await failing({
    latestOtp: async () => {
      throw new Error("leak mail-pw");
    },
  })({ id: 7, type: "latestOtp" });
  eq(last().error.code, "HOST_ERROR", "예상 밖 오류는 일반 코드로");
  eq(JSON.stringify(last()).includes("mail-pw"), false, "예상 밖 오류의 원문을 내보내지 않음");
}

console.log("출력 규칙");
for (const file of ["host.js", "dispatch.js", "framing.js", "credentials.js", "pop3.js"]) {
  const source = readFileSync(new URL(`../host/${file}`, import.meta.url), "utf8");
  eq(/console\.\w+/.test(source), false, `${file}: console 출력 없음`);
}

console.log("실제 호스트 프로세스");
{
  const child = spawn(process.execPath, [new URL("../host/host.js", import.meta.url).pathname], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const received = [];
  const push = createFrameReader((m) => received.push(m), () => received.push("frame-error"));
  child.stdout.on("data", push);
  const exited = new Promise((resolve) => child.once("exit", resolve));

  const frame = Buffer.concat([encodeFrame({ id: 1, type: "ping" }), encodeFrame({ id: 2, type: "nope" })]);
  child.stdin.write(frame.subarray(0, 5));
  await new Promise((resolve) => setTimeout(resolve, 50));
  child.stdin.write(frame.subarray(5));
  await new Promise((resolve) => setTimeout(resolve, 300));

  const byId = (id) => received.find((m) => m && m.id === id);
  eq(byId(1) && byId(1).ok, true, "ping 응답");
  eq(byId(2) && byId(2).error.code, "BAD_REQUEST", "잘못된 요청에 응답");
  child.stdin.end();
  const timeout = new Promise((resolve) => setTimeout(() => resolve("still-running"), 3000));
  eq(await Promise.race([exited, timeout]), 0, "stdin 이 닫히면 정상 종료");
  child.kill();
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
