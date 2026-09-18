#!/usr/bin/env bash
# Square Studio Linux service manager. Never source the env file as shell code.
set -Eeuo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="$ROOT/.env"
ENTRY="$ROOT/server/production.mjs"
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/service.pid"
LOG_FILE="$ROOT/logs/service.log"
INSTALL_TMP=""
NODE=""

say() { printf '%s\n' "$*"; }
fail() { say "错误：$*" >&2; exit 1; }
cleanup() {
  if [[ -n "$INSTALL_TMP" && "$INSTALL_TMP" == "$ROOT/.runtime/download."* ]]; then
    rm -rf -- "$INSTALL_TMP"
  fi
  return 0
}
trap cleanup EXIT
[[ "$(uname -s)" == Linux ]] || fail '这些脚本用于 Linux 服务器。'
cd -- "$ROOT"
for tool in flock sha256sum curl tar xz nohup; do
  command -v "$tool" >/dev/null || fail "缺少 $tool。请安装 curl、tar、xz-utils（CentOS/RHEL 为 xz）和 util-linux 后重试。"
done
mkdir -p -- "$RUN_DIR" "$ROOT/logs"
chmod 700 "$RUN_DIR" "$ROOT/logs"
exec 9>"$RUN_DIR/service.lock"
flock -w 600 9 || fail '其他启动/停止操作仍在进行，请稍后重试。'

start_ticks() {
  local stat
  [[ -r "/proc/$1/stat" ]] || return 1
  IFS= read -r stat < "/proc/$1/stat" || return 1
  stat="${stat##*) }"
  # Fields after the closing process name start at field 3; starttime is field 22.
  set -- $stat
  printf '%s' "${20}"
}
load_record() {
  PID=''; TICKS=''; SERVICE_URL=''
  [[ -f "$PID_FILE" ]] || return 1
  { IFS= read -r PID; IFS= read -r TICKS; IFS= read -r SERVICE_URL; } < "$PID_FILE" || return 1
  [[ "$PID" =~ ^[0-9]+$ && "$TICKS" =~ ^[0-9]+$ ]] || return 1
}
is_owned_process() {
  [[ -n "${PID:-}" && -r "/proc/$PID/cmdline" ]] || return 1
  [[ "$(start_ticks "$PID" 2>/dev/null || true)" == "$TICKS" ]] || return 1
  tr '\0' '\n' < "/proc/$PID/cmdline" | grep -Fqx -- "$ENTRY"
}
health_ok() {
  local response
  response="$(curl --noproxy '*' --fail --silent --max-time 2 "$SERVICE_URL/healthz" 2>/dev/null)" || return 1
  printf '%s' "$response" | grep -Eq '"service"[[:space:]]*:[[:space:]]*"square-studio"' || return 1
  printf '%s' "$response" | grep -Eq '"pid"[[:space:]]*:[[:space:]]*'"$PID"'([[:space:]]*[,}])'
}
node_supported() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a===22&&b>=12)||a===24?0:1)' >/dev/null 2>&1
}
ensure_node() {
  local candidate arch filename checksum extracted
  candidate="$(command -v node || true)"
  if [[ -n "$candidate" ]] && node_supported "$candidate"; then
    NODE="$candidate"
  elif [[ -x "$ROOT/.runtime/node/bin/node" ]] && node_supported "$ROOT/.runtime/node/bin/node"; then
    NODE="$ROOT/.runtime/node/bin/node"
  else
    case "$(uname -m)" in
      x86_64|amd64) arch=x64 ;;
      aarch64|arm64) arch=arm64 ;;
      *) fail '自动安装支持 Linux x64 / arm64；其他架构请自行安装 Node.js 22.12+ 或 24。' ;;
    esac
    mkdir -p "$ROOT/.runtime"
    INSTALL_TMP="$(mktemp -d "$ROOT/.runtime/download.XXXXXXXX")"
    say '正在从 nodejs.org 下载 Node.js 22 LTS（仅安装到项目 .runtime，不改动系统）…'
    curl --fail --location --retry 3 --connect-timeout 20 --max-time 120 \
      'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' -o "$INSTALL_TMP/SHASUMS256.txt"
    filename="$(awk -v arch="$arch" '$2 ~ ("^node-v22\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$INSTALL_TMP/SHASUMS256.txt")"
    [[ "$filename" =~ ^node-v22\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || fail '无法识别官方 Node.js 下载清单。'
    checksum="$(awk -v name="$filename" '$2 == name {print $1}' "$INSTALL_TMP/SHASUMS256.txt")"
    [[ "$checksum" =~ ^[a-fA-F0-9]{64}$ ]] || fail 'Node.js SHA-256 校验值无效。'
    curl --fail --location --retry 3 --connect-timeout 20 --max-time 600 \
      "https://nodejs.org/dist/latest-v22.x/$filename" -o "$INSTALL_TMP/$filename"
    (cd "$INSTALL_TMP" && printf '%s  %s\n' "$checksum" "$filename" | sha256sum -c -) || fail 'Node.js 下载校验失败。'
    tar -xJf "$INSTALL_TMP/$filename" -C "$INSTALL_TMP"
    extracted="${filename%.tar.xz}"
    node_supported "$INSTALL_TMP/$extracted/bin/node" || fail 'Node.js 无法在当前系统运行。官方 Linux 二进制需要 glibc >= 2.28；CentOS 7 等旧系统请先升级。'
    if [[ -e "$ROOT/.runtime/node" ]]; then
      mv -- "$ROOT/.runtime/node" "$ROOT/.runtime/node.previous.$(date +%s).$$"
    fi
    mv -- "$INSTALL_TMP/$extracted" "$ROOT/.runtime/node"
    NODE="$ROOT/.runtime/node/bin/node"
    cleanup
    INSTALL_TMP=''
  fi
  NODE="$(readlink -f "$NODE")"
  export PATH="$(dirname "$NODE"):$PATH"
  command -v npm >/dev/null || fail '当前 Node.js 没有 npm，请安装完整 Node.js 运行时。'
}
prepare_config() {
  "$NODE" "$ROOT/scripts/configure-env.mjs" || fail "无法准备 .env 配置。"
  local settings
  settings="$("$NODE" --env-file="$ENV_FILE" --input-type=module -e '
    import { readServiceEnvironment } from "./server/config.mjs";
    const e=readServiceEnvironment(); const port=e.PORT||"8081", host=e.HOST||"0.0.0.0";
    if(!/^\d+$/.test(port)||+port<1||+port>65535) throw new Error("PORT 必须为 1–65535 的整数");
    if(!/^[a-zA-Z0-9.:-]+$/.test(host)) throw new Error("HOST 格式无效");
    if(!(e.ADMIN_USER||"admin").trim()) throw new Error("ADMIN_USER 不能为空");
    if(!e.ADMIN_PASSWORD||e.ADMIN_PASSWORD.length<16) throw new Error("ADMIN_PASSWORD 至少需要 16 个字符");
    console.log(host); console.log(port);
  ')" || fail '请检查 .env 配置。'
  BIND_HOST="${settings%%$'\n'*}"
  SERVICE_PORT="${settings##*$'\n'}"
  case "$BIND_HOST" in
    0.0.0.0) SERVICE_URL="http://127.0.0.1:$SERVICE_PORT" ;;
    ::) SERVICE_URL="http://[::1]:$SERVICE_PORT" ;;
    *:*) SERVICE_URL="http://[$BIND_HOST]:$SERVICE_PORT" ;;
    *) SERVICE_URL="http://$BIND_HOST:$SERVICE_PORT" ;;
  esac
}
source_hash() {
  {
    for directory in src public scripts server worker .openai; do
      [[ ! -d "$directory" ]] || find "$directory" -type f -print0
    done
    find . -maxdepth 1 -type f \( -name 'package*.json' -o -name 'vite.config.*' -o -name 'index.html' \) -print0
  } | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d ' ' -f 1
}
prepare_build() {
  local deps_hash build_hash saved_deps='' saved_build=''
  [[ -f package-lock.json ]] || fail '缺少 package-lock.json，无法执行可靠的 npm ci 安装。'
  deps_hash="$( { sha256sum package.json package-lock.json; "$NODE" --version; uname -sm; } | sha256sum | cut -d ' ' -f 1)"
  [[ ! -f "$RUN_DIR/dependencies.sha256" ]] || saved_deps="$(cat "$RUN_DIR/dependencies.sha256")"
  if [[ "$deps_hash" != "$saved_deps" || ! -f node_modules/vite/package.json ]]; then
    say '正在安装项目依赖…'
    npm ci --include=dev --no-audit --no-fund
    printf '%s\n' "$deps_hash" > "$RUN_DIR/dependencies.sha256"
  fi
  build_hash="$( { source_hash; printf '%s\n' "$deps_hash"; } | sha256sum | cut -d ' ' -f 1)"
  [[ ! -f "$RUN_DIR/build.sha256" ]] || saved_build="$(cat "$RUN_DIR/build.sha256")"
  if [[ "$build_hash" != "$saved_build" || ! -f dist/client/index.html ]]; then
    say '检测到首次运行或代码更新，正在构建网站…'
    npm run build
    printf '%s\n' "$build_hash" > "$RUN_DIR/build.sha256"
  else
    say '代码未变化，复用已有构建。'
  fi
}
stop_service() {
  if ! load_record || ! is_owned_process; then
    say '服务已停止（未发现本目录对应的运行进程）。'
    rm -f -- "$PID_FILE"
    return 0
  fi
  say "正在停止服务（PID $PID），等待正在进行的请求完成…"
  kill -TERM "$PID" 2>/dev/null || true
  local deadline=$((SECONDS + 310))
  while is_owned_process; do
    if (( SECONDS >= deadline )); then
      say '停止等待已超过 310 秒，服务仍在退出中。为保护正在发布的内容，没有强制终止。' >&2
      say '请查看 logs/service.log，稍后运行 bash status.sh 或再次停止。' >&2
      return 1
    fi
    sleep 1
  done
  rm -f -- "$PID_FILE"
  say '服务已停止。'
}
start_service() {
  if load_record && is_owned_process; then
    if health_ok; then
      say "服务已在运行（PID $PID），无需重复启动：$SERVICE_URL"
      return 0
    fi
    fail "本目录的服务进程仍在运行（PID $PID），但健康检查未通过。请查看 logs/service.log 或执行 bash restart.sh。"
  fi
  rm -f -- "$PID_FILE"
  [[ -f "$ENTRY" ]] || fail '缺少 server/production.mjs，请拉取完整项目代码。'
  ensure_node
  prepare_config
  prepare_build
  say "正在启动 Square Studio，监听 $BIND_HOST:$SERVICE_PORT…"
  # Closing lock fd 9 in the child is essential: the daemon must not retain the script lock.
  nohup "$NODE" --env-file="$ENV_FILE" "$ENTRY" >> "$LOG_FILE" 2>&1 < /dev/null 9>&- &
  PID=$!
  TICKS="$(start_ticks "$PID")"
  printf '%s\n%s\n%s\n' "$PID" "$TICKS" "$SERVICE_URL" > "$PID_FILE.tmp"
  mv -- "$PID_FILE.tmp" "$PID_FILE"
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if ! kill -0 "$PID" 2>/dev/null; then
      rm -f -- "$PID_FILE"
      tail -n 30 "$LOG_FILE" >&2
      fail '服务启动失败。请根据日志检查端口占用或配置。'
    fi
    if is_owned_process && health_ok; then
      say "服务已启动（PID $PID），关闭 SSH 后仍会运行。"
      say "  本机检查：$SERVICE_URL"
      if [[ "$BIND_HOST" == 0.0.0.0 || "$BIND_HOST" == :: ]]; then
        local address
        address="$(hostname -I 2>/dev/null | awk '{print $1}')"
        [[ -z "$address" ]] || say "  服务器地址：http://$address:$SERVICE_PORT"
        say "  远程访问：http://服务器IP:$SERVICE_PORT（需放行该端口的防火墙/安全组）"
      fi
      say '  状态：bash status.sh | 停止：bash stop.sh | 重启：bash restart.sh'
      say '  日志：logs/service.log'
      return 0
    fi
    sleep 1
  done
  say '60 秒内健康检查未通过，正在停止此次启动的进程。' >&2
  stop_service || true
  tail -n 30 "$LOG_FILE" >&2
  fail '服务启动超时，请查看 logs/service.log。'
}
status_service() {
  if load_record && is_owned_process; then
    if health_ok; then
      say "运行正常（PID $PID）"
      say "配置文件：$ENV_FILE（修改后需 restart）"
      say "本机健康检查地址：$SERVICE_URL（浏览器远程访问请使用服务器 IP）"
      say "日志：$LOG_FILE"
      return 0
    fi
    say "进程运行中（PID $PID），健康检查未通过；请查看 $LOG_FILE。" >&2
    return 1
  fi
  say '服务未运行。'
  return 3
}
case "${1:-}" in
  start) start_service ;;
  stop) stop_service ;;
  restart) stop_service && start_service ;;
  status) status_service ;;
  *) fail '用法：bash start.sh | bash stop.sh | bash restart.sh | bash status.sh' ;;
esac
