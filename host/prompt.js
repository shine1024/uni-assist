// 터미널 숨김 입력 (macOS / Windows 공용). 입력값은 화면에 표시하지 않는다.

export function askHidden(label) {
  const input = process.stdin;
  if (!input.isTTY) return Promise.reject(new Error("터미널에서 직접 실행하세요"));
  process.stderr.write(label);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (settle, arg) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stderr.write("\n");
      settle(arg);
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish(resolve, value);
        if (ch === "\u0003") return finish(reject, new Error("취소했어요"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}
