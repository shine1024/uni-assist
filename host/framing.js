// Native Messaging 프레임: 4바이트 리틀엔디언 길이 + UTF-8 JSON

export const MAX_MESSAGE_BYTES = 1024 * 1024;

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_MESSAGE_BYTES) throw new Error("message too large");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * 청크가 어떻게 나뉘어 오든 완전한 메시지 단위로 넘겨 준다.
 * @param {(message: any) => void} onMessage
 * @param {(reason: "too-large"|"bad-json") => void} onError
 */
export function createFrameReader(onMessage, onError) {
  let buffer = Buffer.alloc(0);
  return function push(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (size > MAX_MESSAGE_BYTES) {
        buffer = Buffer.alloc(0);
        onError("too-large");
        return;
      }
      if (buffer.length < 4 + size) return;
      const body = buffer.subarray(4, 4 + size);
      buffer = buffer.subarray(4 + size);
      let message;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        onError("bad-json");
        continue;
      }
      onMessage(message);
    }
  };
}
