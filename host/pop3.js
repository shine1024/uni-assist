// 2차 인증 메일의 인증번호 조회 (POP3).
//
// 메일함은 읽기만 한다. 서버에 보내는 명령은 아래 createNodePop3Client 가 노출하는
// USER / PASS / UIDL / TOP / RETR / QUIT 뿐이고, 메일함을 바꾸는 명령은 호출 경로 자체가 없다.
//
// 비밀번호·인증번호·서버 응답 원문은 오류 메시지에 넣지 않는다.
// 이 프로세스의 stdout 은 Native Messaging 전용이므로 여기서는 아무것도 출력하지 않는다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Pop3Command from "node-pop3";
import { simpleParser } from "mailparser";

const ATTEMPT_LIMIT_MS = 15000;
const QUIT_GRACE_MS = 2000;

const CONNECT_MESSAGE = "메일 서버에 접속하지 못했어요";

export class Pop3Error extends Error {
  /** @param {string} code @param {string} message @param {string} [detail] 진단용 코드(서버 원문 아님) */
  constructor(code, message, detail) {
    super(message);
    this.name = "Pop3Error";
    this.code = code;
    this.detail = detail;
  }
}

function connectError(cause) {
  const detail = (cause && (cause.code || cause.eventName)) || undefined;
  return new Pop3Error("POP3_CONNECT_FAILED", CONNECT_MESSAGE, detail ? String(detail) : undefined);
}

// ---- 설정 --------------------------------------------------------------

const isBlank = (v) => typeof v !== "string" || !v.trim() || /^TODO\b/.test(v.trim());

function requireText(value, field) {
  if (isBlank(value)) throw new Pop3Error("CONFIG_INVALID", `설정값을 입력하세요: ${field}`);
  return value.trim();
}

function compile(pattern, field) {
  try {
    return new RegExp(requireText(pattern, field));
  } catch (err) {
    if (err instanceof Pop3Error) throw err;
    throw new Pop3Error("CONFIG_INVALID", `정규식이 올바르지 않아요: ${field}`);
  }
}

/** config.json 내용을 검증해 실행용 값으로 바꾼다. 평문 POP3 는 허용하지 않는다. */
export function normalizeConfig(raw) {
  const pop3 = (raw && raw.pop3) || {};
  const otp = (raw && raw.otp) || {};
  const port = pop3.port === undefined ? 995 : pop3.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 110) {
    throw new Pop3Error("CONFIG_INVALID", "POP3 는 TLS 포트(기본 995)만 사용할 수 있어요: pop3.port");
  }
  return {
    host: requireText(pop3.host, "pop3.host"),
    port,
    user: requireText(pop3.user, "pop3.user"),
    from: requireText(otp.from, "otp.from").toLowerCase(),
    subjectRe: compile(otp.subjectPattern, "otp.subjectPattern"),
    codeRe: compile(otp.codePattern, "otp.codePattern"),
  };
}

export function loadConfig(path =join(dirname(fileURLToPath(import.meta.url)), "config.json")) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Pop3Error("CONFIG_INVALID", "host/config.json 이 없어요. config.example.json 을 복사해 값을 채우세요");
  }
  try {
    return normalizeConfig(JSON.parse(text));
  } catch (err) {
    if (err instanceof Pop3Error) throw err;
    throw new Pop3Error("CONFIG_INVALID", "host/config.json 의 JSON 형식이 올바르지 않아요");
  }
}

// ---- 메일 판별 (순수) ----------------------------------------------------

export function htmlToPlain(html) {
  return String(html)
    .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[#a-z0-9]+;/gi, " ");
}

/** @returns {string|null} text 본문을 먼저, 없으면 html 에서 태그를 걷어낸 본문을 본다 */
export function extractCode(mail, codeRe) {
  const bodies = [mail.text, typeof mail.html === "string" ? htmlToPlain(mail.html) : ""];
  for (const body of bodies) {
    if (!body) continue;
    const match = body.match(codeRe);
    if (match) return match[1] ?? match[0];
  }
  return null;
}

/** 표시 이름이 아니라 실제 주소가, 그것도 정확히 1개일 때만 일치로 본다. */
export function matchesSender(mail, from) {
  const list = (mail.from && mail.from.value) || [];
  return list.length === 1 && typeof list[0].address === "string" && list[0].address.toLowerCase() === from;
}

async function parseMail(raw) {
  try {
    return await simpleParser(raw);
  } catch {
    return null;
  }
}

/** POP3 PASS 단계 오류 분류. 메일함 잠금 같은 일시 오류는 재시도할 수 있어야 한다. */
export function classifyLoginError(err) {
  if (typeof err?.command !== "string") return connectError(err);
  const temporary = /\[(IN-USE|SYS\/TEMP|LOGIN-DELAY)\]|lock|in use|busy|temporar|try again/i;
  if (temporary.test(String(err.message))) return connectError({ code: "MAILBOX_BUSY" });
  return new Pop3Error("POP3_AUTH_FAILED", "메일 로그인에 실패했어요. 메일 계정(전체 주소)과 비밀번호를 확인하세요");
}

// ---- 실제 POP3 클라이언트 ------------------------------------------------

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
  });
}

/**
 * TLS 전용 POP3 클라이언트.
 * @param {{host:string, port:number, user:string}} cfg
 * @param {string} password
 * @param {import("node:tls").TlsOptions} [tlsOptions] 테스트에서 사설 CA 를 넘길 때만 쓴다
 */
export function createNodePop3Client(cfg, password, tlsOptions) {
  const pop = new Pop3Command({
    host: cfg.host,
    port: cfg.port,
    tls: true,
    user: cfg.user,
    password,
    timeout: ATTEMPT_LIMIT_MS,
    parseStreamToString: false,
    tlsOptions,
  });

  return {
    async open() {
      try {
        await pop.connect();
      } catch (err) {
        throw connectError(err);
      }
      try {
        await pop.command("USER", cfg.user);
        await pop.command("PASS", password);
      } catch (err) {
        throw classifyLoginError(err);
      }
    },
    async uidl() {
      let rows;
      try {
        rows = await pop.UIDL();
      } catch (err) {
        if (typeof err?.command === "string") {
          throw new Pop3Error("UNSUPPORTED_UIDL", "메일 서버가 UIDL 을 지원하지 않아요");
        }
        throw connectError(err);
      }
      return rows.filter((row) => row.length >= 2).map(([num, uid]) => [String(num), String(uid)]);
    },
    async top(num) {
      try {
        return await readAll(await pop.TOP(Number(num), 0));
      } catch (err) {
        throw connectError(err);
      }
    },
    async retr(num) {
      try {
        return await readAll(await pop.RETR(Number(num)));
      } catch (err) {
        throw connectError(err);
      }
    },
    async quit() {
      await pop.QUIT();
    },
    destroy() {
      if (pop._socket) pop._socket.destroy();
    },
  };
}

// ---- 조회 흐름 ----------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 접속 1회. node-pop3 는 명령 대기 중 소켓이 끊기면 약속이 끝나지 않을 수 있어
 * 제한시간을 여기서 따로 걸고, 어떤 경우든 소켓을 정리한다.
 */
async function withSession(config, password, deps, limitMs, signal, work) {
  const client = deps.createClient(config, password);
  let timer;
  let onAbort;
  const bail = new Promise((_, reject) => {
    timer = setTimeout(() => reject(connectError({ code: "ATTEMPT_TIMEOUT" })), limitMs);
    if (!signal) return;
    onAbort = () => reject(new Pop3Error("ABORTED", "요청이 중단됐어요"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const run = (async () => {
      await client.open();
      return work(client);
    })();
    run.catch(() => {});
    const result = await Promise.race([run, bail]);
    await Promise.race([Promise.resolve().then(() => client.quit()), delay(QUIT_GRACE_MS)]).catch(() => {});
    return result;
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    client.destroy();
  }
}

const defaultDeps = { createClient: createNodePop3Client };

const LATEST_SCAN_LIMIT = 30;

/**
 * 받은편지함에서 가장 최근 인증 메일의 번호를 읽는다. 메일 번호가 클수록 나중에 도착한 메일이다.
 * 이전 번호일 수 있으므로 수신 시각을 함께 돌려준다.
 */
export async function latestOtp(config, password, { signal } = {}, deps = defaultDeps) {
  const found = await withSession(config, password, deps, ATTEMPT_LIMIT_MS, signal, async (client) => {
    const rows = (await client.uidl()).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, LATEST_SCAN_LIMIT);
    for (const [num] of rows) {
      const header = await parseMail(await client.top(num));
      if (!header || !matchesSender(header, config.from) || !config.subjectRe.test(header.subject || "")) continue;
      const mail = await parseMail(await client.retr(num));
      const valid = header.date instanceof Date && !Number.isNaN(header.date.getTime());
      return {
        code: (mail && extractCode(mail, config.codeRe)) || null,
        receivedAt: valid ? header.date.toISOString() : null,
        matched: true,
      };
    }
    return { matched: false };
  });
  if (!found.matched) throw new Pop3Error("OTP_NOT_FOUND", "최근 메일에서 인증 메일을 찾지 못했어요");
  if (!found.code) throw new Pop3Error("OTP_PARSE_FAILED", "인증 메일에서 번호를 찾지 못했어요");
  return { code: found.code, receivedAt: found.receivedAt };
}
