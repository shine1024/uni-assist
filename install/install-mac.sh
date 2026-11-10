#!/bin/bash
# Uni-Assist 2차 인증 OTP 호스트 설치 (macOS)
#   bash install/install-mac.sh              설치 또는 재설치
#   bash install/install-mac.sh --uninstall  제거
set -euo pipefail

HOST_NAME="com.unipost.approval_otp"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_DIR="$ROOT/host"
LAUNCHER="$HOST_DIR/run-host.sh"
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST="$CHROME_DIR/$HOST_NAME.json"

fail() { echo "오류: $1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js 를 찾을 수 없어요. Node.js 20.11 이상을 설치하세요."
NODE_BIN="$(command -v node)"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$MANIFEST" "$LAUNCHER"
  if [[ -d "$HOST_DIR/node_modules" ]]; then
    "$NODE_BIN" "$HOST_DIR/setup-credentials.js" --remove
  else
    echo "host/node_modules 가 없어 키체인 항목은 지우지 못했어요." >&2
  fi
  echo "제거를 마쳤어요."
  exit 0
fi

"$NODE_BIN" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 20 || (major === 20 && minor >= 11) ? 0 : 1);
' || fail "Node.js 20.11 이상이 필요해요. 현재: $("$NODE_BIN" -v)"

echo "1/4 의존성 설치"
(cd "$HOST_DIR" && npm ci --omit=dev)

[[ -f "$HOST_DIR/config.json" ]] || cp "$HOST_DIR/config.example.json" "$HOST_DIR/config.json"

echo
echo "2/4 확장 ID 입력"
echo "    chrome://extensions 의 Uni-Assist 도우미 카드에 표시된 ID 를 붙여 넣으세요."
read -r -p "확장 ID: " EXTENSION_ID

echo "3/4 호스트 등록"
# Chrome 은 셸 PATH 를 읽지 않으므로 node 절대경로로 실행한다.
printf '#!/bin/bash\nexec "%s" "%s" "$@"\n' "$NODE_BIN" "$HOST_DIR/host.js" > "$LAUNCHER"
chmod 755 "$LAUNCHER"
mkdir -p "$CHROME_DIR"
"$NODE_BIN" "$ROOT/install/render-manifest.mjs" \
  "$ROOT/install/host-manifest.template.json" "$MANIFEST" "$LAUNCHER" "$EXTENSION_ID"

echo "4/4 비밀번호를 키체인에 저장 (입력 내용은 표시되지 않아요)"
"$NODE_BIN" "$HOST_DIR/setup-credentials.js"

echo
echo "설치를 마쳤어요. host/config.json 값을 채운 뒤 확장을 새로고침하세요."
