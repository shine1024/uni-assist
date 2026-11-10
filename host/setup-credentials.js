#!/usr/bin/env node
// 설치 스크립트가 호출한다. 비밀번호를 숨김 입력으로 받아 OS 키체인에 저장한다.
//   node host/setup-credentials.js            등록 (이미 있으면 Enter 로 유지)
//   node host/setup-credentials.js --remove   삭제
import { ACCOUNTS, deleteSecret, hasSecret, setSecret } from "./credentials.js";
import { askHidden } from "./prompt.js";

const say = (text) => process.stderr.write(`${text}\n`);

async function register() {
  for (const [account, label] of Object.entries(ACCOUNTS)) {
    const exists = hasSecret(account);
    const hint = exists ? " (Enter: 기존 값 유지)" : "";
    for (;;) {
      const value = await askHidden(`${label}${hint}: `);
      if (value) {
        setSecret(account, value);
        say(`  ${label} 저장 완료`);
        break;
      }
      if (exists) {
        say(`  ${label} 유지`);
        break;
      }
      say("  비밀번호를 입력하세요");
    }
  }
}

function remove() {
  for (const [account, label] of Object.entries(ACCOUNTS)) {
    deleteSecret(account);
    say(`  ${label} 삭제 완료`);
  }
}

try {
  if (process.argv.includes("--remove")) remove();
  else await register();
} catch (err) {
  say(`실패: ${err.message}`);
  process.exitCode = 1;
}
