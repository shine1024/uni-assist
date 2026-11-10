#!/usr/bin/env node
// Native Messaging 호스트 진입점. Chrome 이 필요할 때 실행하고 포트가 끊기면 종료된다.
// stdout 은 프로토콜 전용이다. 다른 내용을 쓰면 Chrome 이 연결을 끊는다.
import { createDispatcher } from "./dispatch.js";
import { createFrameReader, encodeFrame } from "./framing.js";
import { getSecret } from "./credentials.js";
import { latestOtp, loadConfig } from "./pop3.js";

const VERSION = "0.1.0";

const controller = new AbortController();

function send(message) {
  process.stdout.write(encodeFrame(message));
}

function shutdown() {
  controller.abort();
  setTimeout(() => process.exit(0), 200);
}

const handle = createDispatcher({
  version: VERSION,
  send,
  signal: controller.signal,
  loadConfig,
  getSecret,
  latestOtp,
});

const push = createFrameReader(
  (message) => handle(message),
  (reason) => {
    send({ id: null, ok: false, error: { code: "BAD_REQUEST", message: "요청 형식이 올바르지 않아요" } });
    if (reason === "too-large") shutdown();
  },
);

process.stdout.on("error", shutdown);
process.stdin.on("data", push);
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
