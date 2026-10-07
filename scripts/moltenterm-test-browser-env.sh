#!/usr/bin/env bash
# Copyright 2026, DiamondForge
# SPDX-License-Identifier: Apache-2.0

# Shell-level test of molten-open, the BROWSER of local MoltenTerm terminals (FR-BRW-007): it runs the handler the way
# programs do ("$BROWSER <url> [more args]") from bash, zsh and fish when they are installed, and from Python's
# webbrowser, outside MoltenTerm. MoltenTerm is then unreachable, so every target must reach the OS opener (stubbed
# here: open on macOS, xdg-open elsewhere) unchanged, with BROWSER removed from the opener's environment so xdg-open
# cannot hand it back, within a second and with exit code 0. The browser panel path needs the app (see the ticket's
# test report).
#
# Usage: scripts/moltenterm-test-browser-env.sh [path/to/wsh]   (default: the wsh of this platform in dist/bin, built by
# `task build:backend`)

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

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
mkdir -p "${work}/bin" "${work}/stub" "${work}/cwd"
cp "${wsh}" "${work}/bin/wsh"
ln -s wsh "${work}/bin/molten-open"
log="${work}/opened.log"
: >"${log}"
for opener in open xdg-open; do
    cat >"${work}/stub/${opener}" <<EOF
#!/bin/sh
printf '%s|%s\n' "\$1" "\${BROWSER-unset}" >>"${log}"
EOF
    chmod +x "${work}/stub/${opener}"
done
touch "${work}/cwd/README.md"

export PATH="${work}/stub:${PATH}"
export BROWSER="${work}/bin/molten-open"
unset WAVETERM_JWT WAVETERM_TABID WAVETERM_SWAPTOKEN WAVETERM_BLOCKID || true
cd "${work}/cwd"

failures=0
fail() {
    echo "FAIL: $*" >&2
    failures=$((failures + 1))
}

now_ms() {
    if command -v python3 >/dev/null 2>&1; then
        python3 -c 'import time; print(int(time.time() * 1000))'
    else
        echo $(($(date +%s) * 1000))
    fi
}

# expect <label> <wanted opener argument> <command...>
expect() {
    local label="$1" want="$2"
    shift 2
    : >"${log}"
    local start end status=0
    start="$(now_ms)"
    "$@" >/dev/null 2>"${work}/stderr" || status=$?
    end="$(now_ms)"
    if [ "${status}" -ne 0 ]; then
        fail "${label}: exit code ${status} ($(cat "${work}/stderr"))"
        return
    fi
    if [ $((end - start)) -gt 1000 ]; then
        fail "${label}: took $((end - start)) ms"
    fi
    local got
    got="$(cat "${log}")"
    if [ "${got}" != "${want}|unset" ]; then
        fail "${label}: the OS opener got '${got}', want '${want}|unset'"
        return
    fi
    echo "ok: ${label}"
}

expect "bash, url with extra args" "https://example.com/a?b=c&d=e" bash -c '"$BROWSER" "https://example.com/a?b=c&d=e" --extra more'
expect "bash, option before the url" "https://example.com/b" bash -c '"$BROWSER" --new-window https://example.com/b'
expect "bash, bare host" "https://example.com/c" bash -c '"$BROWSER" example.com/c'
expect "bash, localhost" "http://localhost:3000" bash -c '"$BROWSER" localhost:3000'
expect "bash, mailto" "mailto:a@b.c" bash -c '"$BROWSER" mailto:a@b.c'
expect "bash, relative file" "./README.md" bash -c '"$BROWSER" ./README.md'
expect "bash, existing file" "README.md" bash -c '"$BROWSER" README.md'
expect "bash, file url" "file:///etc/hosts" bash -c '"$BROWSER" file:///etc/hosts'
expect "bash, shell characters stay data" 'https://example.com/$(touch pwned);x' bash -c '"$BROWSER" "https://example.com/\$(touch pwned);x"'
if [ -e pwned ]; then
    fail "a URL ran through a shell"
fi
if command -v zsh >/dev/null 2>&1; then
    expect "zsh" "https://example.com/zsh" zsh -f -c '$BROWSER https://example.com/zsh extra'
else
    echo "skip: zsh not installed"
fi
if command -v fish >/dev/null 2>&1; then
    expect "fish" "https://example.com/fish" fish --no-config -c '$BROWSER https://example.com/fish extra'
else
    echo "skip: fish not installed"
fi
if command -v python3 >/dev/null 2>&1; then
    expect "python webbrowser" "https://example.com/py" python3 -c 'import webbrowser, sys; sys.exit(0 if webbrowser.open("https://example.com/py") else 1)'
else
    echo "skip: python3 not installed"
fi

: >"${log}"
status=0
"${BROWSER}" >/dev/null 2>&1 || status=$?
if [ "${status}" -eq 0 ] || [ -s "${log}" ]; then
    fail "no argument: want a non-zero exit code and nothing opened"
else
    echo "ok: no argument"
fi

if [ "${failures}" -ne 0 ]; then
    echo "${failures} failure(s)" >&2
    exit 1
fi
echo "all molten-open checks passed"
