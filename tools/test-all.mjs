// 전체 단위 테스트 실행 (node tools/test-all.mjs)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const suites = ["test-transform.mjs", "test-login.mjs", "test-vault.mjs", "test-hotkey.mjs", "test-approval-flow.mjs"];
// 호스트 테스트는 npm 의존성이 필요하다. 설치 전이면 건너뛰되 알려 준다.
if (existsSync(join(here, "..", "host", "node_modules"))) suites.push("test-host-pop3.mjs", "test-host-protocol.mjs");
else console.log("⚠ host/node_modules 없음: 호스트 테스트 건너뜀 (host/ 에서 npm ci)");

let failed = 0;
for (const s of suites) {
  console.log(`\n=== ${s} ===`);
  const r = spawnSync(process.execPath, [join(here, s)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n❌ ${failed}개 스위트 실패` : "\n✅ 전체 스위트 통과");
process.exit(failed ? 1 : 0);
