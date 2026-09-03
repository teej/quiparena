#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
DATA_DIR="$ROOT_DIR/.data"
LOG_DIR="$DATA_DIR/logs"
RUN_DIR="$DATA_DIR/run"
ROOM_FILE="$DATA_DIR/room-code"
ROOM_STATUS_FILE="$ROOM_FILE.status.json"
TOKEN_FILE="$DATA_DIR/ingest-token"
LOOP_STOP_FILE="$RUN_DIR/loop.stop"
MODE_FILE="$RUN_DIR/mode"
PORT_FILE="$RUN_DIR/port"
VITE_PORT_FILE="$RUN_DIR/vite-port"
HOST_AGENT_ENABLED_FILE="$RUN_DIR/host-agent-enabled"
LOOP_ENABLED_FILE="$RUN_DIR/loop-enabled"
OPS_COMPONENTS="host-agent web vite loop"

usage() {
  printf '%s\n' \
    "usage: pnpm ops up [--dev] [--no-host-agent] [--no-loop] [--room CODE]" \
    "       pnpm ops down [--graceful]" \
    "       pnpm ops restart [--graceful]" \
    "       pnpm ops status" \
    "       pnpm ops logs <host-agent|web|vite|loop> [-f]" \
    "" \
    "up options:" \
    "  --dev            run the tsx server watcher and Vite (site port: VITE_PORT, default 5173)" \
    "  --no-host-agent  do not capture the screen; use --room or repo-root .data/room-code" \
    "  --no-loop        do not connect workers to a room" \
    "  --room CODE      initial room for the loop when --no-host-agent is set" \
    "" \
    "environment:" \
    "  PORT             web/API port (default 8787)" \
    "  VITE_PORT        development site port (default 5173)"
}

die() {
  printf 'ops: %s\n' "$*" >&2
  exit 1
}

ensure_dirs() {
  mkdir -p "$LOG_DIR" "$RUN_DIR"
}

validate_port() {
  local name=$1 value=$2
  case "$value" in
    ''|*[!0-9]*) die "$name must be a TCP port from 1 to 65535" ;;
  esac
  [ "$value" -ge 1 ] && [ "$value" -le 65535 ] \
    || die "$name must be a TCP port from 1 to 65535"
}

load_environment() {
  if [ -f "$ROOT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$ROOT_DIR/.env"
    set +a
  fi

  if [ -z "${INGEST_TOKEN:-}" ]; then
    if [ -s "$TOKEN_FILE" ]; then
      INGEST_TOKEN=$(tr -d '\r\n' < "$TOKEN_FILE")
    else
      umask 077
      if command -v openssl >/dev/null 2>&1; then
        INGEST_TOKEN=$(openssl rand -hex 32)
      else
        INGEST_TOKEN=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
      fi
      printf '%s\n' "$INGEST_TOKEN" > "$TOKEN_FILE"
    fi
  fi
  export INGEST_TOKEN
  PORT=${PORT:-8787}
  VITE_PORT=${VITE_PORT:-5173}
  HOST=${HOST:-127.0.0.1}
  validate_port PORT "$PORT"
  validate_port VITE_PORT "$VITE_PORT"
  WEB_INGEST_URL=${WEB_INGEST_URL:-ws://127.0.0.1:${PORT}/ingest}
  export HOST PORT VITE_PORT WEB_INGEST_URL
}

pid_file() {
  printf '%s/%s.pid\n' "$RUN_DIR" "$1"
}

component_pid() {
  local file
  file=$(pid_file "$1")
  [ -s "$file" ] || return 1
  tr -d '[:space:]' < "$file"
}

pid_alive() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

component_command_matches() {
  local name=$1 pid=$2 command
  command=$(ps -ww -p "$pid" -o command= 2>/dev/null || true)
  case "$name:$command" in
    host-agent:*packages/arena/dist/cli.js*host-agent*) return 0 ;;
    loop:*packages/arena/dist/cli.js*loop*) return 0 ;;
    web:*apps/web/dist/server/index.js*) return 0 ;;
    web:*tsx/dist/cli.mjs*watch*server/index.ts*) return 0 ;;
    vite:*vite/bin/vite.js*) return 0 ;;
    *) return 1 ;;
  esac
}

component_running() {
  local pid
  pid=$(component_pid "$1" 2>/dev/null || true)
  pid_alive "$pid"
}

assert_no_components_running() {
  local name pid found=0
  for name in $OPS_COMPONENTS; do
    pid=$(component_pid "$name" 2>/dev/null || true)
    if pid_alive "$pid"; then
      printf 'ops: %s already running (pid %s)\n' "$name" "$pid" >&2
      found=1
    elif [ -n "$pid" ]; then
      rm -f "$(pid_file "$name")"
    fi
  done
  [ "$found" -eq 0 ] || exit 1
}

start_component() {
  local name=$1 cwd=$2 log pid
  shift 2
  log="$LOG_DIR/$name.log"
  (
    cd "$cwd"
    exec nohup "$@" >> "$log" 2>&1 </dev/null
  ) &
  pid=$!
  printf '%s\n' "$pid" > "$(pid_file "$name")"
  UP_STARTED="$name $UP_STARTED"
  sleep 1
  if ! pid_alive "$pid"; then
    tail -n 20 "$log" >&2 || true
    die "$name exited during startup"
  fi
  printf 'started %-10s pid %s  log %s\n' "$name" "$pid" ".data/logs/$name.log"
}

room_code() {
  [ -s "$ROOM_FILE" ] || return 1
  local code
  code=$(tr -d '\r\n[:space:]' < "$ROOM_FILE" | tr '[:lower:]' '[:upper:]')
  case "$code" in
    [A-Z][A-Z][A-Z][A-Z]) printf '%s\n' "$code" ;;
    *) return 1 ;;
  esac
}

host_status_confirms() {
  local code=$1
  ROOM_STATUS_FILE="$ROOM_STATUS_FILE" ROOM_CODE="$code" node -e '
    const fs = require("node:fs");
    try {
      const status = JSON.parse(fs.readFileSync(process.env.ROOM_STATUS_FILE, "utf8"));
      process.exit(status.confirmed === true && status.code === process.env.ROOM_CODE ? 0 : 1);
    } catch { process.exit(1); }
  '
}

ecast_confirms() {
  local code=$1 response
  response=$(curl --max-time 5 -fsS -A 'curl/8.7.1' \
    "https://ecast.jackboxgames.com/api/v2/rooms/$code" 2>/dev/null) || return 1
  ROOM_RESPONSE="$response" ROOM_CODE="$code" node -e '
    try {
      const value = JSON.parse(process.env.ROOM_RESPONSE);
      const tag = value?.body?.appTag;
      process.exit(value?.ok === true && value?.body?.code?.toUpperCase() === process.env.ROOM_CODE
        && (tag === "quiplash3" || tag === "quiplash3-tjsp") ? 0 : 1);
    } catch { process.exit(1); }
  '
}

wait_for_room() {
  local timeout=${OPS_ROOM_WAIT_SECONDS:-300} deadline code host_pid
  deadline=$(( $(date +%s) + timeout ))
  printf 'waiting for the host agent to publish an ecast-confirmed room'
  while [ "$(date +%s)" -lt "$deadline" ]; do
    host_pid=$(component_pid host-agent 2>/dev/null || true)
    pid_alive "$host_pid" || { printf '\n' >&2; die "host-agent exited while waiting for a room"; }
    code=$(room_code 2>/dev/null || true)
    if [ -n "$code" ] && host_status_confirms "$code" && ecast_confirms "$code"; then
      printf ' %s\n' "$code"
      ROOM_CODE=$code
      export ROOM_CODE
      return 0
    fi
    printf '.'
    sleep 2
  done
  printf '\n' >&2
  die "no confirmed room after ${timeout}s"
}

normalize_room_code() {
  local code
  code=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
  case "$code" in
    [A-Z][A-Z][A-Z][A-Z]) printf '%s\n' "$code" ;;
    *) return 1 ;;
  esac
}

wait_for_external_room() {
  local requested=${1:-} timeout=${OPS_ROOM_WAIT_SECONDS:-300} deadline code
  deadline=$(( $(date +%s) + timeout ))
  printf 'waiting for an ecast-confirmed room from --room or .data/room-code'
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -n "$requested" ]; then code=$requested; else code=$(room_code 2>/dev/null || true); fi
    if [ -n "$code" ] && ecast_confirms "$code"; then
      printf ' %s\n' "$code"
      ROOM_CODE=$code
      export ROOM_CODE
      return 0
    fi
    printf '.'
    sleep 2
  done
  printf '\n' >&2
  die "no confirmed room after ${timeout}s"
}

local_web_url() {
  printf 'http://127.0.0.1:%s\n' "$1"
}

wait_for_web() {
  local base=$1 deadline web_pid
  deadline=$(( $(date +%s) + 30 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    web_pid=$(component_pid web 2>/dev/null || true)
    pid_alive "$web_pid" || die "web exited during startup"
    if curl --max-time 2 -fsS "$base/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "web health check did not pass within 30s"
}

wait_for_site() {
  local base=$1 deadline vite_pid
  deadline=$(( $(date +%s) + 30 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    vite_pid=$(component_pid vite 2>/dev/null || true)
    pid_alive "$vite_pid" || die "vite exited during startup"
    if curl --max-time 2 -fsS "$base/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "Vite did not serve the site within 30s"
}

write_runtime_config() {
  printf '%s\n' "$1" > "$MODE_FILE"
  printf '%s\n' "$PORT" > "$PORT_FILE"
  printf '%s\n' "$VITE_PORT" > "$VITE_PORT_FILE"
  printf '%s\n' "$2" > "$HOST_AGENT_ENABLED_FILE"
  printf '%s\n' "$3" > "$LOOP_ENABLED_FILE"
}

clear_runtime_config() {
  rm -f "$MODE_FILE" "$PORT_FILE" "$VITE_PORT_FILE" "$HOST_AGENT_ENABLED_FILE" "$LOOP_ENABLED_FILE"
}

cleanup_failed_up() {
  local status=$? name pid
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then
    for name in $UP_STARTED; do
      pid=$(component_pid "$name" 2>/dev/null || true)
      if pid_alive "$pid" && component_command_matches "$name" "$pid"; then
        kill -TERM "$pid" 2>/dev/null || true
      fi
    done
    clear_runtime_config
  fi
  exit "$status"
}

ops_up() {
  local mode=production start_host_agent=yes start_loop=yes requested_room="" argument
  while [ "$#" -gt 0 ]; do
    argument=$1
    shift
    case "$argument" in
      --dev) mode=development ;;
      --no-host-agent) start_host_agent=no ;;
      --no-loop) start_loop=no ;;
      --room)
        [ "$#" -gt 0 ] || die "--room requires a four-letter code"
        requested_room=$(normalize_room_code "$1") \
          || die "--room requires a four-letter code"
        shift
        ;;
      *) die "unknown up option: $argument" ;;
    esac
  done
  if [ -n "$requested_room" ] && [ "$start_host_agent" = yes ]; then
    die "--room may only be used with --no-host-agent"
  fi

  ensure_dirs
  load_environment
  assert_no_components_running
  rm -f "$LOOP_STOP_FILE"
  printf 'building workspace\n'
  (cd "$ROOT_DIR" && pnpm build)

  UP_STARTED=""
  trap cleanup_failed_up EXIT INT TERM
  write_runtime_config "$mode" "$start_host_agent" "$start_loop"

  if [ "$start_host_agent" = yes ]; then
    start_component host-agent "$ROOT_DIR" node "$ROOT_DIR/packages/arena/dist/cli.js" \
      host-agent --room-file "$ROOM_FILE"
  fi
  if [ "$start_loop" = yes ]; then
    if [ "$start_host_agent" = yes ]; then
      wait_for_room
    else
      if [ -n "$requested_room" ]; then printf '%s\n' "$requested_room" > "$ROOM_FILE"; fi
      wait_for_external_room "$requested_room"
    fi
  fi

  local base site store
  base=$(local_web_url "$PORT")
  store=${QUIPARENA_STORE:-db}
  if [ "$mode" = development ]; then
    start_component web "$ROOT_DIR/apps/web" env NODE_ENV=development \
      QUIPARENA_STORE="$store" HOST="$HOST" PORT="$PORT" \
      "$ROOT_DIR/apps/web/node_modules/.bin/tsx" watch server/index.ts
    start_component vite "$ROOT_DIR/apps/web" env PORT="$PORT" VITE_PORT="$VITE_PORT" \
      "$ROOT_DIR/apps/web/node_modules/.bin/vite" --host 127.0.0.1 \
      --port "$VITE_PORT" --strictPort
    site=$(local_web_url "$VITE_PORT")
  else
    start_component web "$ROOT_DIR" env NODE_ENV=production \
      QUIPARENA_STORE="$store" HOST="$HOST" PORT="$PORT" \
      node "$ROOT_DIR/apps/web/dist/server/index.js"
    site=$base
  fi
  wait_for_web "$base"
  if [ "$mode" = development ]; then wait_for_site "$site"; fi
  if [ "$start_loop" = yes ]; then
    start_component loop "$ROOT_DIR" node "$ROOT_DIR/packages/arena/dist/cli.js" \
      loop --room "$ROOM_CODE" --room-file "$ROOM_FILE" --ingest "$WEB_INGEST_URL" \
      --stop-file "$LOOP_STOP_FILE"
  fi
  trap - EXIT INT TERM
  printf 'lobby up  room %s  site %s\n' "${ROOM_CODE:-none}" "$site"
  if [ "$mode" = development ]; then printf 'api %s  vite port %s\n' "$base" "$VITE_PORT"; fi
}

signal_component() {
  local name=$1 signal=$2 pid
  pid=$(component_pid "$name" 2>/dev/null || true)
  [ -n "$pid" ] || return 0
  if ! pid_alive "$pid"; then
    rm -f "$(pid_file "$name")"
    return 0
  fi
  component_command_matches "$name" "$pid" \
    || die "$name pid $pid does not match the command started by ops; refusing to signal it"
  kill "-$signal" "$pid"
}

wait_component_exit() {
  local name=$1 timeout=$2 pid deadline
  pid=$(component_pid "$name" 2>/dev/null || true)
  [ -n "$pid" ] || return 0
  deadline=$(( $(date +%s) + timeout ))
  while pid_alive "$pid" && [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 1
  done
  if pid_alive "$pid"; then
    return 1
  fi
  rm -f "$(pid_file "$name")"
  return 0
}

stop_after_term() {
  local name=$1
  if wait_component_exit "$name" 15; then
    return 0
  fi
  printf 'ops: %s did not exit after SIGTERM; sending SIGKILL\n' "$name" >&2
  signal_component "$name" KILL
  wait_component_exit "$name" 5 || die "$name did not exit"
}

ops_down() {
  local graceful=${1:-}
  [ -z "$graceful" ] || [ "$graceful" = "--graceful" ] || die "down accepts only --graceful"
  ensure_dirs
  load_environment

  if [ "$graceful" = "--graceful" ]; then
    local loop_pid timeout
    loop_pid=$(component_pid loop 2>/dev/null || true)
    if pid_alive "$loop_pid"; then
      : > "$LOOP_STOP_FILE"
      signal_component loop USR1
      timeout=${OPS_GRACEFUL_TIMEOUT_SECONDS:-1200}
      printf 'armed loop graceful stop; waiting up to %ss for the game boundary\n' "$timeout"
      if ! wait_component_exit loop "$timeout"; then
        printf 'ops: graceful timeout reached; aborting loop with SIGTERM\n' >&2
        signal_component loop TERM
        stop_after_term loop
      fi
    else
      rm -f "$(pid_file loop)"
    fi
    rm -f "$LOOP_STOP_FILE"
    signal_component vite TERM
    stop_after_term vite
    signal_component web TERM
    stop_after_term web
    signal_component host-agent TERM
    stop_after_term host-agent
  else
    signal_component loop TERM
    signal_component vite TERM
    signal_component web TERM
    signal_component host-agent TERM
    stop_after_term loop
    stop_after_term vite
    stop_after_term web
    stop_after_term host-agent
    rm -f "$LOOP_STOP_FILE"
  fi
  clear_runtime_config
  printf 'lobby down\n'
}

component_status() {
  local name=$1 pid uptime
  pid=$(component_pid "$name" 2>/dev/null || true)
  if pid_alive "$pid"; then
    uptime=$(ps -p "$pid" -o etime= 2>/dev/null | tr -d ' ' || true)
    if component_command_matches "$name" "$pid"; then
      printf '%-10s pid %-7s uptime %s\n' "$name" "$pid" "${uptime:-unknown}"
    else
      printf '%-10s pid %-7s MISMATCH\n' "$name" "$pid"
    fi
  elif [ -n "$pid" ]; then
    printf '%-10s stopped   stale pid %s\n' "$name" "$pid"
  else
    printf '%-10s stopped\n' "$name"
  fi
}

ops_status() {
  ensure_dirs
  load_environment
  local name code confirmed base site health games mode active_port active_vite_port host_agent_enabled loop_enabled
  mode=$(tr -d '[:space:]' < "$MODE_FILE" 2>/dev/null || true)
  case "$mode" in production|development) ;; *) mode=production ;; esac
  active_port=$(tr -d '[:space:]' < "$PORT_FILE" 2>/dev/null || true)
  case "$active_port" in ''|*[!0-9]*) active_port=$PORT ;; esac
  active_vite_port=$(tr -d '[:space:]' < "$VITE_PORT_FILE" 2>/dev/null || true)
  case "$active_vite_port" in ''|*[!0-9]*) active_vite_port=$VITE_PORT ;; esac
  host_agent_enabled=$(tr -d '[:space:]' < "$HOST_AGENT_ENABLED_FILE" 2>/dev/null || true)
  case "$host_agent_enabled" in yes|no) ;; *) host_agent_enabled=yes ;; esac
  loop_enabled=$(tr -d '[:space:]' < "$LOOP_ENABLED_FILE" 2>/dev/null || true)
  case "$loop_enabled" in yes|no) ;; *) loop_enabled=yes ;; esac

  for name in host-agent web; do component_status "$name"; done
  if [ "$mode" = development ] || [ -s "$(pid_file vite)" ]; then component_status vite; fi
  component_status loop

  base=$(local_web_url "$active_port")
  if [ "$mode" = development ]; then
    site=$(local_web_url "$active_vite_port")
    printf 'site       %s  (Vite port %s)\n' "$site" "$active_vite_port"
    printf 'api        %s\n' "$base"
  else
    site=$base
    printf 'site       %s\n' "$site"
  fi

  code=$(room_code 2>/dev/null || true)
  confirmed=no
  if [ -n "$code" ] && { [ "$host_agent_enabled" = yes ] || [ "$loop_enabled" = yes ]; } \
      && ecast_confirms "$code"; then
    if [ "$host_agent_enabled" = no ] || host_status_confirms "$code"; then confirmed=yes; fi
  fi
  printf 'room       %s  confirmed %s\n' "${code:-none}" "$confirmed"

  health=$(curl --max-time 3 -fsS "$base/api/health" 2>/dev/null || true)
  if [ -n "$health" ]; then
    HEALTH_JSON="$health" node -e '
      try {
        const value = JSON.parse(process.env.HEALTH_JSON);
        console.log(`current    ${value.currentGameId ?? "none"}`);
      } catch { console.log("current    unavailable"); }
    '
  else
    printf 'current    unavailable\n'
  fi

  games=$(curl --max-time 3 -fsS "$base/api/games" 2>/dev/null || true)
  if [ -n "$games" ]; then
    GAMES_JSON="$games" node -e '
      try {
        const rows = JSON.parse(process.env.GAMES_JSON);
        if (!Array.isArray(rows)) throw new Error();
        console.log(`games      ${rows.length}`);
        const last = rows[0];
        console.log(last
          ? `last game  ${last.id} / ${last.status} / ${last.roomCode} / ${last.startedAt}`
          : "last game  none");
      } catch { console.log("games      unavailable"); }
    '
  else
    printf 'games      unavailable\n'
  fi

  for name in host-agent web; do
    printf '\n[%s] last 3 lines\n' "$name"
    if [ -f "$LOG_DIR/$name.log" ]; then tail -n 3 "$LOG_DIR/$name.log"; else printf '(no log)\n'; fi
  done
  if [ "$mode" = development ] || [ -f "$LOG_DIR/vite.log" ]; then
    printf '\n[vite] last 3 lines\n'
    if [ -f "$LOG_DIR/vite.log" ]; then tail -n 3 "$LOG_DIR/vite.log"; else printf '(no log)\n'; fi
  fi
  printf '\n[loop] last 3 lines\n'
  if [ -f "$LOG_DIR/loop.log" ]; then tail -n 3 "$LOG_DIR/loop.log"; else printf '(no log)\n'; fi
}

ops_logs() {
  local name=${1:-} follow=${2:-}
  case "$name" in host-agent|web|vite|loop) ;; *) die "logs requires host-agent, web, vite, or loop" ;; esac
  [ -z "$follow" ] || [ "$follow" = "-f" ] || die "logs accepts only -f"
  ensure_dirs
  touch "$LOG_DIR/$name.log"
  if [ "$follow" = "-f" ]; then tail -n 100 -f "$LOG_DIR/$name.log"; else tail -n 100 "$LOG_DIR/$name.log"; fi
}

command=${1:-}
shift || true
case "$command" in
  up) ops_up "$@" ;;
  down) [ "$#" -le 1 ] || die "down accepts only --graceful"; ops_down "${1:-}" ;;
  restart)
    [ "$#" -le 1 ] || die "restart accepts only --graceful"
    ops_down "${1:-}"
    ops_up
    ;;
  status) [ "$#" -eq 0 ] || die "status accepts no arguments"; ops_status ;;
  logs) [ "$#" -ge 1 ] && [ "$#" -le 2 ] || die "logs requires a name and optional -f"; ops_logs "$@" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 1 ;;
esac
