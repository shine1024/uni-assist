// 호스트 등록 파일 생성 (macOS·Windows 설치 스크립트 공용)
// 사용: node render-manifest.mjs <template> <output> <hostPath> <extensionId>
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const [template, output, hostPath, extensionId] = process.argv.slice(2);

if (!/^[a-p]{32}$/.test(extensionId || "")) {
  process.stderr.write("Invalid extension ID (expected 32 letters a-p)\n");
  process.exit(1);
}
if (!hostPath || !isAbsolute(hostPath)) {
  process.stderr.write("Host path must be absolute\n");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(template, "utf8"));
manifest.path = hostPath;
manifest.allowed_origins = [`chrome-extension://${extensionId}/`];
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
