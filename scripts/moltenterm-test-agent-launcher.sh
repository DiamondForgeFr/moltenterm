#!/usr/bin/env bash
# Copyright 2026, DiamondForge
# SPDX-License-Identifier: Apache-2.0

# Shell-level test of the claude launcher of local MoltenTerm terminals (FR-SHELL-036, DS-SHELL-044/045): with a fake
# claude that records its arguments, environment, stdin and parent, in a temporary HOME and data folder, it checks
# - the PATH order the shell integration scripts give in bash, zsh and fish (when installed): the launcher first, even
#   when the user's startup files prepend ~/.local/bin, where Claude Code's installer puts claude (TC-SHELL-062);
# - an integrated run: --settings <generated file> first, the user's arguments unchanged, stdin, exit code, the same
#   process (a signal sent to the launcher reaches the agent), the generated file's content and modes;
# - the MoltenTerm browser (FR-SHELL-037): --mcp-config=<file> first, declaring molten-browser with the absolute path
#   of molten; nothing of it with --strict-mcp-config or when the user has a molten-browser; their --mcp-config kept;
# - that the status line in the generated file prints the user's status line byte for byte, through the real relay;
# - pass-through commands and step-asides (nothing added), a missing claude (exit 127), and that no user file changed;
# - the codex launcher (FR-SHELL-038), with a fake codex and a fake user notify: the -c overrides first, the
#   generated notify run as Codex runs it (the user's notify gets the same payload, once), the user's own -c notify
#   left alone, pass-through commands and step-asides;
# - the launcher's overhead (NFR-SHELL-020: at most 50 ms at the 95th percentile).
# MoltenTerm itself is not running: the launcher's report finds no wavesrv and is dropped, as when MoltenTerm is slow.
#
# Usage: scripts/moltenterm-test-agent-launcher.sh [path/to/wsh]   (default: the wsh of this platform in dist/bin,
# built by `task build:backend`)

# Single quotes hold commands for other shells (SC2016); pass and fail never fail (SC2015).
# shellcheck disable=SC2016,SC2015,SC2012

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
wsh="${1:-}"
if [ -z "${wsh}" ]; then
    goos="$(uname -s | tr '[:upper:]' '[:lower:]')"
    arch="$(uname -m)"
    case "${arch}" in
        x86_64) arch="x64" ;;
        aarch64) arch="arm64" ;;
    esac
    wsh="$(ls "${root}"/dist/bin/wsh-*-"${goos}"."${arch}" 2>/dev/null | head -n 1 || true)"
fi
if [ -z "${wsh}" ] || [ ! -x "${wsh}" ]; then
    echo "wsh binary not found: run task build:backend or pass its path" >&2
    exit 2
fi
command -v python3 >/dev/null || { echo "python3 is needed to read JSON and time runs" >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
data="${work}/data with space"
bin="${data}/bin"
agents="${bin}/agents"
home="${work}/home"
project="${home}/src/app"
mkdir -p "${agents}" "${home}/.local/bin" "${home}/.claude" "${project}/.git" "${work}/rc"
cp "${wsh}" "${bin}/wsh"
ln -s wsh "${bin}/molten"
ln -s ../wsh "${agents}/claude"
ln -s ../wsh "${agents}/codex"
log="${work}/claude.log"
codexlog="${work}/codex.log"
notifylog="${work}/notify.log"

# A fake codex (FR-SHELL-038): it records its arguments, one per line, and its exit code is FAKE_EXIT.
cat >"${home}/.local/bin/codex" <<'EOF'
#!/bin/sh
{
    for a in "$@"; do printf 'arg=%s\n' "$a"; done
    printf 'launched=%s\n' "${MOLTENTERM_AGENT_LAUNCHED-unset}"
} >>"${FAKE_CODEX_LOG:?}"
exit "${FAKE_EXIT:-0}"
EOF
chmod +x "${home}/.local/bin/codex"
# The user's own notify: it records each argument it gets, NUL-terminated.
cat >"${work}/user-notify.sh" <<'EOF'
#!/bin/sh
for a in "$@"; do printf '%s\0' "$a"; done >>"${FAKE_NOTIFY_LOG:?}"
EOF
chmod +x "${work}/user-notify.sh"
mkdir -p "${home}/.codex"
printf 'model = "o3"\nnotify = ["%s", "--from", "codex"]\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n' "${work}/user-notify.sh" >"${home}/.codex/config.toml"
printf '{"never":"read"}\n' >"${home}/.codex/auth.json"
chmod 000 "${home}/.codex/auth.json"

cat >"${home}/.local/bin/claude" <<'EOF'
#!/bin/sh
log="${FAKE_LOG:?}"
{
    for a in "$@"; do printf 'arg=%s\n' "$a"; done
    printf 'launched=%s\n' "${MOLTENTERM_AGENT_LAUNCHED-unset}"
    printf 'ppid=%s\n' "$PPID"
    if [ -n "${FAKE_STDIN:-}" ]; then printf 'stdin=%s\n' "$(cat)"; fi
} >>"$log"
if [ -n "${FAKE_WAIT:-}" ]; then
    trap 'echo got=TERM >>"$log"; exit 143' TERM
    echo ready >>"$log"
    while :; do sleep 0.05; done
fi
exit "${FAKE_EXIT:-0}"
EOF
chmod +x "${home}/.local/bin/claude"

user_statusline='printf "%s|" "$(cat | wc -c | tr -d " ")"; printf "marker '"'"'q'"'"' %s\n" "$PWD"'
python3 - "${home}/.claude/settings.json" "${user_statusline}" <<'EOF'
import json, sys
json.dump({"statusLine": {"type": "command", "command": sys.argv[2], "padding": 1},
           "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "./my-log.sh"}]}]}}, open(sys.argv[1], "w"))
EOF
echo '{"mcpServers":{"github":{"command":"gh-mcp"}}}' >"${home}/.claude.json"
echo '{"mcpServers":{"db":{"command":"db-mcp"}}}' >"${project}/.mcp.json"
echo '{"mcpServers":{"other":{"command":"other-mcp"}}}' >"${project}/other.json"
mine="${home}/src/mine"
mkdir -p "${mine}/.git"
echo '{"mcpServers":{"molten-browser":{"command":"molten","args":["mcp","browser"]}}}' >"${mine}/.mcp.json"
printf 'export PATH="$HOME/.local/bin:$PATH"\n' >"${home}/.zshrc"
printf 'export PATH="$HOME/.local/bin:$PATH"\n' >"${home}/.bash_profile"
mkdir -p "${home}/.config/fish"
printf 'set -gx PATH $HOME/.local/bin $PATH\n' >"${home}/.config/fish/config.fish"

hash_user_files() {
    find "${home}" -type f \( -name '*.json' -o -name '*.toml' -o -name '.zshrc' \) ! -name auth.json -print0 | sort -z | xargs -0 shasum | shasum
    ls -l "${home}/.codex/auth.json"
}
before="$(hash_user_files)"

failures=0
fail() {
    echo "FAIL: $*" >&2
    failures=$((failures + 1))
}
pass() {
    echo "ok: $*"
}

# Render the integration scripts as InitRcFiles does: single-quoted paths (the data folder has a space).
render() {
    sed -e "s|{{.WSHBINDIR}}|'${bin}'|g" -e "s|{{.AGENTBINDIR}}|'${agents}'|g" -e "s|{{.AGENTBINDIR_FISH}}|'${agents}'|g" "$1" >"$2"
}
si="${root}/pkg/util/shellutil/shellintegration"
mkdir -p "${work}/rc/zsh" "${work}/rc/bash" "${work}/rc/fish"
render "${si}/zsh_zshrc.sh" "${work}/rc/zsh/.zshrc"
render "${si}/zsh_zshenv.sh" "${work}/rc/zsh/.zshenv"
render "${si}/zsh_zprofile.sh" "${work}/rc/zsh/.zprofile"
render "${si}/zsh_zlogin.sh" "${work}/rc/zsh/.zlogin"
render "${si}/bash_bashrc.sh" "${work}/rc/bash/.bashrc"
cp "${si}/bash_preexec.sh" "${work}/rc/bash/bash_preexec.sh"
render "${si}/fish_wavefish.sh" "${work}/rc/fish/wave.fish"

base_env=(env -i HOME="${home}" USER="${USER:-me}" TERM=xterm-256color LANG=en_US.UTF-8 PATH="/usr/bin:/bin:/usr/sbin:/sbin" FAKE_LOG="${log}")
probe='printf "\nwhich=%s\n" "$(command -v claude)"; printf "first=%s\n" "${PATH%%:*}"; printf "dirvar=%s\n" "$MOLTENTERM_AGENTBINDIR"'
check_path() {
    local shell="$1" out="$2"
    local which first dirvar
    which="$(printf '%s\n' "${out}" | sed -n 's/^which=//p' | tail -n 1)"
    first="$(printf '%s\n' "${out}" | sed -n 's/^first=//p' | tail -n 1)"
    dirvar="$(printf '%s\n' "${out}" | sed -n 's/^dirvar=//p' | tail -n 1)"
    if [ "${which}" = "${agents}/claude" ] && [ "${first}" = "${agents}" ] && [ "${dirvar}" = "${agents}" ]; then
        pass "${shell}: which claude is the launcher, first on PATH after the user's startup files"
    else
        fail "${shell}: which=${which} first=${first} MOLTENTERM_AGENTBINDIR=${dirvar}"
    fi
}
if command -v zsh >/dev/null; then
    out="$("${base_env[@]}" ZDOTDIR="${work}/rc/zsh" zsh -l -i -c "${probe}" 2>/dev/null || true)"
    check_path zsh "${out}"
fi
out="$("${base_env[@]}" bash --rcfile "${work}/rc/bash/.bashrc" -i -c "${probe}" 2>/dev/null || true)"
check_path bash "${out}"
if command -v fish >/dev/null; then
    out="$("${base_env[@]}" fish -C "source '${work}/rc/fish/wave.fish'" -c 'printf "\nwhich=%s\nfirst=%s\ndirvar=%s\n" (command -v claude) $PATH[1] $MOLTENTERM_AGENTBINDIR' 2>/dev/null || true)"
    check_path fish "${out}"
else
    echo "skip: fish is not installed"
fi

# The pane's environment: what the shell integration gives a local terminal.
pane_path="${agents}:${home}/.local/bin:${bin}:/usr/bin:/bin"
pane_env=("${base_env[@]}" PATH="${pane_path}" MOLTENTERM_AGENTBINDIR="${agents}" WAVETERM_BLOCKID=block-test WAVETERM_JWT=not-a-token)
cd "${project}"

: >"${log}"
code=0
printf 'piped input' | "${pane_env[@]}" FAKE_STDIN=1 FAKE_EXIT=7 sh -c 'claude -p "say ok" --model opus; rc=$?; echo "shellpid=$$" >>"$FAKE_LOG"; exit $rc' || code=$?
args="$(sed -n 's/^arg=//p' "${log}")"
mcpconfig="$(printf '%s\n' "${args}" | sed -n '1s/^--mcp-config=//p')"
settings="$(printf '%s\n' "${args}" | sed -n '3p')"
want_rest="$(printf -- '-p\nsay ok\n--model\nopus')"
if [ -n "${mcpconfig}" ] && [ "$(printf '%s\n' "${args}" | sed -n '2p')" = "--settings" ] && [ "$(printf '%s\n' "${args}" | sed -n '4,$p')" = "${want_rest}" ]; then
    pass "integrated run: --mcp-config=<file> then --settings <file> first, the user's arguments unchanged"
else
    fail "integrated run arguments: ${args}"
fi
case "${mcpconfig}" in
    "${data}/molten/agent-launch/claude-mcp-"*.json) pass "the MCP config is in MoltenTerm's data folder" ;;
    *) fail "mcp config path ${mcpconfig}" ;;
esac
if [ -f "${mcpconfig}" ]; then
    python3 - "${mcpconfig}" "${bin}/molten" <<'EOF' && pass "MCP config: molten-browser runs MoltenTerm's molten by its absolute path, owner-only" || fail "MCP config content: $(cat "${mcpconfig}")"
import json, os, sys
doc = json.load(open(sys.argv[1]))
assert doc == {"mcpServers": {"molten-browser": {"type": "stdio", "command": sys.argv[2], "args": ["mcp", "browser"]}}}, doc
assert os.stat(sys.argv[1]).st_mode & 0o777 == 0o600
EOF
    out="$("${base_env[@]}" "${bin}/molten" mcp browser --help 2>&1 || true)"
    printf '%s' "${out}" | grep -q 'stdio MCP server' && pass "the configured command is a molten that serves mcp browser" || fail "molten mcp browser --help: ${out}"
else
    fail "no MCP config written"
fi
grep -q '^stdin=piped input$' "${log}" && pass "stdin reaches the agent" || fail "stdin: $(cat "${log}")"
grep -q '^launched=claude$' "${log}" && pass "the agent's processes are marked as nested" || fail "MOLTENTERM_AGENT_LAUNCHED: $(cat "${log}")"
ppid="$(sed -n 's/^ppid=//p' "${log}")"
shellpid="$(sed -n 's/^shellpid=//p' "${log}")"
[ -n "${ppid}" ] && [ "${ppid}" = "${shellpid}" ] && pass "the agent replaced the launcher (its parent is the shell)" || fail "ppid ${ppid}, shell ${shellpid}"
[ "${code}" = 7 ] && pass "exit code passed through" || fail "exit code ${code}, want 7"

browser_skipped() {
    local label="$1" want="$2"
    shift 2
    : >"${log}"
    "$@" || true
    local got
    got="$(sed -n 's/^arg=//p' "${log}" | tr '\n' ' ')"
    if grep -q -- '^arg=--mcp-config=' "${log}" || ! grep -q -- '^arg=--settings$' "${log}"; then
        fail "${label}: ${got}"
    else
        pass "${label}: no molten-browser added, the rest is (${got% })"
    fi
    if [ -n "${want}" ] && [ "$(sed -n 's/^arg=//p' "${log}" | sed -n '3,$p' | tr '\n' ' ')" != "${want}" ]; then
        fail "${label}: the user's arguments changed: ${got}"
    fi
}
browser_skipped "--strict-mcp-config" "--strict-mcp-config --mcp-config other.json -p x " "${pane_env[@]}" claude --strict-mcp-config --mcp-config other.json -p x
browser_skipped "a molten-browser of the user's (.mcp.json)" "-p x " sh -c 'cd "$0" && exec "$@"' "${mine}" "${pane_env[@]}" claude -p x
: >"${log}"
"${pane_env[@]}" claude --mcp-config other.json -p x || true
if [ "$(sed -n 's/^arg=//p' "${log}" | sed -n '4,$p' | tr '\n' ' ')" = "--mcp-config other.json -p x " ] && grep -q -- '^arg=--mcp-config=' "${log}"; then
    pass "the user's own --mcp-config is kept next to MoltenTerm's"
else
    fail "user --mcp-config: $(sed -n 's/^arg=//p' "${log}" | tr '\n' ' ')"
fi

case "${settings}" in
    "${data}/molten/agent-launch/claude-"*.json) pass "the generated file is in MoltenTerm's data folder" ;;
    *) fail "settings path ${settings}" ;;
esac
if [ -f "${settings}" ]; then
    mode="$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777), oct(os.stat(os.path.dirname(sys.argv[1])).st_mode & 0o777))' "${settings}")"
    [ "${mode}" = "0o600 0o700" ] && pass "owner-only file and folder" || fail "modes ${mode}"
    python3 - "${settings}" "${user_statusline}" <<'EOF' && pass "generated settings: state hooks, session link, wrapped status line, nothing else" || fail "generated settings content"
import json, sys
doc = json.load(open(sys.argv[1]))
assert set(doc) == {"hooks", "statusLine"}, doc.keys()
hooks = doc["hooks"]
assert set(hooks) == {"UserPromptSubmit", "PostToolUse", "Notification", "Stop", "SessionStart"}, hooks.keys()
assert hooks["SessionStart"][0]["hooks"][0]["command"] == '[ -n "$WAVETERM_BLOCKID" ] && molten agent session --agent claude --stdin || true'
assert hooks["Stop"][0]["hooks"][0]["command"] == '[ -n "$WAVETERM_BLOCKID" ] && molten agent state done --agent claude || true'
line = doc["statusLine"]
assert line["type"] == "command" and line["padding"] == 1, line
assert line["command"].startswith("command -v molten >/dev/null 2>&1 && exec molten agent statusline -- "), line
EOF
    statusline_cmd="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["statusLine"]["command"])' "${settings}")"
    input='{"model":{"display_name":"Opus"},"cwd":"/x","rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1900000000}}}'
    mine="$(printf '%s' "${input}" | "${base_env[@]}" sh -c "${user_statusline}" | od -c)"
    relayed="$(printf '%s' "${input}" | "${pane_env[@]}" sh -c "${statusline_cmd}" | od -c)"
    [ "${mine}" = "${relayed}" ] && pass "the status line prints the user's bytes through the relay" || fail "status line: mine ${mine} relayed ${relayed}"
    outside="$(printf '%s' "${input}" | "${base_env[@]}" sh -c "${statusline_cmd}" | od -c)"
    [ "${mine}" = "${outside}" ] && pass "the status line prints the user's bytes where molten is not on PATH" || fail "status line outside: ${outside}"
fi

: >"${log}"
"${pane_env[@]}" FAKE_WAIT=1 sh -c 'exec claude' &
pid=$!
for _ in $(seq 1 100); do grep -q ready "${log}" 2>/dev/null && break; sleep 0.05; done
kill -TERM "${pid}" 2>/dev/null || true
wait "${pid}" 2>/dev/null || true
grep -q '^got=TERM$' "${log}" && pass "a signal sent to the launcher's pid reaches the agent" || fail "SIGTERM: $(cat "${log}")"

nothing_added() {
    local label="$1"
    shift
    : >"${log}"
    "$@" || true
    local got
    got="$(sed -n 's/^arg=//p' "${log}" | tr '\n' ' ')"
    if grep -q -- '^arg=--settings$' "${log}" || grep -q -- '^arg=--mcp-config=' "${log}" || ! grep -q '^launched=unset$' "${log}"; then
        fail "${label}: something was added (${got})"
    else
        pass "${label}: real binary, nothing added (${got% })"
    fi
}
for cmd in "--version" "-v" "--help" "mcp list" "config list" "doctor" "update" "install stable" "plugin list" "--bg fix it"; do
    # shellcheck disable=SC2086
    nothing_added "claude ${cmd}" "${pane_env[@]}" claude ${cmd}
done
nothing_added "outside a pane (no block id)" "${base_env[@]}" PATH="${pane_path}" MOLTENTERM_AGENTBINDIR="${agents}" WAVETERM_JWT=not-a-token claude -p x
nothing_added "outside a pane (no token)" "${base_env[@]}" PATH="${pane_path}" MOLTENTERM_AGENTBINDIR="${agents}" WAVETERM_BLOCKID=block-test claude -p x
nothing_added "MOLTENTERM_AGENT_INTEGRATION=0" "${pane_env[@]}" MOLTENTERM_AGENT_INTEGRATION=0 claude -p x
nothing_added "an agent's own subprocess" "${pane_env[@]}" CLAUDECODE=1 claude -p x
: >"${log}"
"${pane_env[@]}" MOLTENTERM_AGENT_LAUNCHED=claude claude -p x || true
grep -q -- '^arg=--settings$' "${log}" && fail "nested run got settings" || pass "nested run (MOLTENTERM_AGENT_LAUNCHED): nothing added"

code=0
msg="$("${pane_env[@]}" PATH="${agents}:${bin}:/usr/bin:/bin" claude -p x 2>&1)" || code=$?
if [ "${code}" = 127 ] && printf '%s' "${msg}" | grep -q "no Claude Code found on PATH"; then
    pass "no real claude: one line and exit 127"
else
    fail "missing claude: code ${code}, ${msg}"
fi

# Codex (FR-SHELL-038): -c overrides first, the user's arguments unchanged, the user's notify wrapped.
codex_env=("${pane_env[@]}" FAKE_CODEX_LOG="${codexlog}" FAKE_NOTIFY_LOG="${notifylog}")
codex_args() { sed -n 's/^arg=//p' "${codexlog}"; }
: >"${codexlog}"
code=0
"${codex_env[@]}" FAKE_EXIT=4 codex --model o3 "fix the 'tests'" || code=$?
cargs="$(codex_args)"
want_head="$(printf -- '-c\nmcp_servers.molten-browser.command="%s"\n-c\nmcp_servers.molten-browser.args=["mcp","browser"]\n-c' "${bin}/molten")"
if [ "$(printf '%s\n' "${cargs}" | sed -n '1,5p')" = "${want_head}" ] && [ "$(printf '%s\n' "${cargs}" | sed -n '7,$p')" = "$(printf -- "--model\no3\nfix the 'tests'")" ]; then
    pass "codex: the browser and notify overrides first, the user's arguments unchanged"
else
    fail "codex arguments: ${cargs}"
fi
[ "${code}" = 4 ] && pass "codex: exit code passed through" || fail "codex exit code ${code}, want 4"
grep -q '^launched=codex$' "${codexlog}" && pass "codex: the agent's processes are marked as nested" || fail "codex MOLTENTERM_AGENT_LAUNCHED: $(cat "${codexlog}")"
notify_value="$(printf '%s\n' "${cargs}" | sed -n '6s/^notify=//p')"
payload='{"type":"agent-turn-complete","thread-id":"0199a8b2-4c1d-7e3f-9a0b-1c2d3e4f5a6b","turn-id":"t1","cwd":"/x","input-messages":["fix \"it\" now"],"last-assistant-message":"done\nok"}'
# The generated value is TOML made of basic strings, which JSON reads the same way; run it as Codex does: the argv,
# then the payload as the last argument, without a shell.
: >"${notifylog}"
if "${codex_env[@]}" python3 - "${notify_value}" "${payload}" "${bin}/molten" "${work}/user-notify.sh" <<'EOF'; then
import json, os, subprocess, sys
argv = json.loads(sys.argv[1])
want = [sys.argv[3], "agent", "notify", "--agent", "codex", "--", sys.argv[4], "--from", "codex"]
assert argv == want, argv
env = dict(os.environ)
r = subprocess.run(argv + [sys.argv[2]], env=env, timeout=10)
sys.exit(r.returncode)
EOF
    pass "codex: notify runs molten agent notify around the user's notify"
else
    fail "codex notify value: ${notify_value}"
fi
got_notify="$(python3 -c 'import sys; print(repr(open(sys.argv[1], "rb").read().split(b"\0")[:-1]))' "${notifylog}")"
want_notify="$(python3 -c 'import sys; print(repr([b"--from", b"codex", sys.argv[1].encode()]))' "${payload}")"
[ "${got_notify}" = "${want_notify}" ] && pass "codex: the user's notify got the same payload, once" || fail "user notify got ${got_notify}"

: >"${codexlog}"
"${codex_env[@]}" codex -c 'notify=["/x/other.sh"]' exec hi || true
cargs="$(codex_args | tr '\n' ' ')"
if [ "${cargs}" = "-c mcp_servers.molten-browser.command=\"${bin}/molten\" -c mcp_servers.molten-browser.args=[\"mcp\",\"browser\"] -c notify=[\"/x/other.sh\"] exec hi " ]; then
    pass "codex: the user's own -c notify is left alone, the browser still added"
else
    fail "codex with -c notify: ${cargs}"
fi

codex_nothing_added() {
    local label="$1"
    shift
    : >"${codexlog}"
    "$@" || true
    if grep -q -- '^arg=-c$' "${codexlog}" || ! grep -q "^launched=${LAUNCHED_WANT:-unset}$" "${codexlog}"; then
        fail "${label}: something was added ($(codex_args | tr '\n' ' '))"
    else
        pass "${label}: real binary, nothing added ($(codex_args | tr '\n' ' ' | sed 's/ $//'))"
    fi
}
for cmd in "--version" "--help" "login" "logout" "mcp list" "features list" "completion zsh" "app-server" "mcp-server"; do
    # shellcheck disable=SC2086
    codex_nothing_added "codex ${cmd}" "${codex_env[@]}" codex ${cmd}
done
codex_nothing_added "codex outside a pane" "${base_env[@]}" PATH="${pane_path}" MOLTENTERM_AGENTBINDIR="${agents}" FAKE_CODEX_LOG="${codexlog}" codex hi
codex_nothing_added "codex with MOLTENTERM_AGENT_INTEGRATION=0" "${codex_env[@]}" MOLTENTERM_AGENT_INTEGRATION=0 codex hi
LAUNCHED_WANT=codex codex_nothing_added "codex in a running agent" "${codex_env[@]}" MOLTENTERM_AGENT_LAUNCHED=codex codex hi

after="$(hash_user_files)"
[ "${before}" = "${after}" ] && pass "no user file changed (settings, .claude.json, .mcp.json, ~/.codex/config.toml, rc files)" || fail "user files changed"

# NFR-SHELL-020: the launcher's p95 overhead against the fake run by its full path.
p95="$(cd "${project}" && "${pane_env[@]}" python3 - "${home}/.local/bin/claude" <<'EOF'
import os, subprocess, sys, time
def p95(cmd, n=60):
    times = []
    for _ in range(n):
        t = time.perf_counter()
        subprocess.run(cmd, check=False)
        times.append((time.perf_counter() - t) * 1000)
    times.sort()
    return times[int(len(times) * 0.95) - 1], times[len(times) // 2]
os.environ["FAKE_LOG"] = os.devnull
real = p95([sys.argv[1], "-p", "x"])
launched = p95(["claude", "-p", "x"])
aside = p95(["claude", "--version"])
print("%.1f %.1f %.1f %.1f %.1f %.1f" % (launched[0] - real[0], launched[1] - real[1], aside[0] - real[0], real[0], launched[0], aside[0]))
EOF
)"
read -r over_p95 over_median aside_p95 real_p95 launch_p95 aside_abs <<<"${p95}"
echo "timing (ms): real p95 ${real_p95}; launcher p95 ${launch_p95} (+${over_p95}, median +${over_median}); step-aside p95 ${aside_abs} (+${aside_p95})"
python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) <= 50 else 1)" "${over_p95}" && pass "launcher overhead within 50 ms at p95" || fail "launcher overhead ${over_p95} ms at p95"

if [ "${failures}" -gt 0 ]; then
    echo "${failures} check(s) failed" >&2
    exit 1
fi
echo "all agent launcher checks passed"
