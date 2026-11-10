#!/usr/bin/env node
// 브라우저 없이 메일 조회만 확인한다: node host/cli-test.js
// 키체인에 메일 비밀번호가 없으면 입력받는다. 인증번호는 메일과 대조할 수 있도록 끝 2자리만 표시한다.
import { getSecret, hasSecret } from "./credentials.js";
import { latestOtp, loadConfig } from "./pop3.js";
import { askHidden } from "./prompt.js";

const say = (text) => process.stderr.write(`${text}\n`);

async function main() {
  const config = loadConfig();
  const password = hasSecret("mail") ? getSecret("mail") : await askHidden(`메일 비밀번호 (${config.user}): `);
  const { code, receivedAt } = await latestOtp(config, password);
  say(`성공: ${code.length}자리 인증번호, 끝 2자리 ${code.slice(-2)}, 수신 ${receivedAt ?? "시각 알 수 없음"}`);
}

main().catch((err) => {
  const detail = err.detail ? ` (${err.detail})` : "";
  say(`실패: [${err.code || "ERROR"}] ${err.message}${detail}`);
  process.exitCode = 1;
});
