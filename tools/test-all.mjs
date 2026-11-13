// 전체 단위 테스트 실행 (node tools/test-all.mjs)
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const suites = ["test-transform.mjs", "test-login.mjs", "test-vault.mjs", "test-hotkey.mjs", "test-approval-flow.mjs", "test-slack-otp.mjs", "test-backup.mjs", "test-nav-order.mjs", "test-site-rules.mjs"];

let failed = 0;
for (const s of suites) {
  console.log(`\n=== ${s} ===`);
  const r = spawnSync(process.execPath, [join(here, s)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n❌ ${failed}개 스위트 실패` : "\n✅ 전체 스위트 통과");
process.exit(failed ? 1 : 0);
