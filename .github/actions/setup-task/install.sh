#!/usr/bin/env bash
# Copyright 2026, DiamondForge
# SPDX-License-Identifier: AGPL-3.0-only

# Installs Task for a CI job (#1956). The release and the SHA-256 of each archive are pinned in pins.txt, next to this
# script, and an archive that does not match its pin never runs. The archive is taken from the cache folder when the copy
# there matches, and downloaded otherwise, with attempts spread over about six minutes: arduino/setup-task gave up after
# three attempts in 33 s on an HTTP 500 from GitHub's release downloads, which failed the job before any test ran.
#
# Usage: install.sh plan                     archive=, sha256= and version= lines, for $GITHUB_OUTPUT
#        install.sh install <cache> <bin>    the archive kept in <cache>, the task binary in <bin>, <bin> on $GITHUB_PATH
#
# For the tests (scripts/moltenterm-setup-task.node-test.mjs): TASK_DOWNLOAD_BASE replaces the release download URL and
# TASK_RETRY_DELAYS the waits between attempts, in seconds. The pins are never read from the environment.

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
pins="${here}/pins.txt"

fail() {
    echo "::error::Task: $*" >&2
    exit 1
}

archive_name() {
    local os arch
    os=${RUNNER_OS:-$(uname -s)}
    arch=${RUNNER_ARCH:-$(uname -m)}
    case "$os" in
        Linux) os=linux ;;
        macOS | Darwin) os=darwin ;;
        *) fail "no pinned archive for the system ${os}" ;;
    esac
    case "$arch" in
        X64 | x86_64 | amd64) arch=amd64 ;;
        ARM64 | arm64 | aarch64) arch=arm64 ;;
        *) fail "no pinned archive for the architecture ${arch}" ;;
    esac
    echo "task_${os}_${arch}.tar.gz"
}

pinned_version() {
    local version
    version=$(awk '$1 == "version" { print $2 }' "$pins")
    [ -n "$version" ] || fail "${pins} names no version"
    echo "$version"
}

pinned_sha256() {
    local sha
    sha=$(awk -v archive="$1" '$2 == archive { print $1 }' "$pins")
    [ -n "$sha" ] || fail "${pins} pins no SHA-256 for $1"
    echo "$sha"
}

sha256_of() {
    if command -v sha256sum > /dev/null 2>&1; then
        sha256sum "$1" | awk '{ print $1 }'
    else
        shasum -a 256 "$1" | awk '{ print $1 }'
    fi
}

# Retries every failure, an HTTP 5xx or a cut connection alike; a stalled transfer counts as one after 30 s.
download() {
    local url=$1 dest=$2 delays wait attempt=0
    delays=${TASK_RETRY_DELAYS-"5 10 20 30 45 60 90 120"}
    for wait in $delays last; do
        attempt=$((attempt + 1))
        if curl --fail --silent --show-error --location --proto-redir =https --connect-timeout 30 \
            --speed-limit 4096 --speed-time 30 --max-time 600 --output "$dest" "$url"; then
            return 0
        fi
        rm -f "$dest"
        if [ "$wait" = last ]; then
            break
        fi
        echo "::warning::Task: download attempt ${attempt} of ${url} failed; trying again in ${wait} s"
        sleep "$wait"
    done
    fail "the download of ${url} failed ${attempt} times"
}

plan() {
    local archive sha version
    archive=$(archive_name)
    sha=$(pinned_sha256 "$archive")
    version=$(pinned_version)
    echo "archive=${archive}"
    echo "sha256=${sha}"
    echo "version=${version}"
}

install() {
    local cache=$1 bin=$2 archive sha version file url got
    archive=$(archive_name)
    sha=$(pinned_sha256 "$archive")
    version=$(pinned_version)
    file="${cache}/${archive}"
    mkdir -p "$cache" "$bin"

    if [ -f "$file" ]; then
        got=$(sha256_of "$file")
        if [ "$got" = "$sha" ]; then
            echo "Task ${version}: ${archive} from the cache"
        else
            echo "::warning::Task: the cached ${archive} has SHA-256 ${got}, not the pinned ${sha}; downloading it again"
            rm -f "$file"
        fi
    fi

    if [ ! -f "$file" ]; then
        url="${TASK_DOWNLOAD_BASE:-https://github.com/go-task/task/releases/download}/${version}/${archive}"
        download "$url" "${file}.part"
        got=$(sha256_of "${file}.part")
        if [ "$got" != "$sha" ]; then
            rm -f "${file}.part"
            fail "${archive} from ${url} has SHA-256 ${got}, not the pinned ${sha}"
        fi
        mv "${file}.part" "$file"
        echo "Task ${version}: ${archive} downloaded"
    fi

    tar -xzf "$file" -C "$bin" task
    local printed
    printed=$("${bin}/task" --version)
    case "$printed" in
        *"${version#v}"*) ;;
        *) fail "${bin}/task prints \"${printed}\", not version ${version}" ;;
    esac
    echo "$printed"
    if [ -n "${GITHUB_PATH:-}" ]; then
        echo "$bin" >> "$GITHUB_PATH"
    fi
}

case "${1:-}" in
    plan) plan ;;
    install)
        [ $# -eq 3 ] || fail "usage: install.sh install <cache folder> <bin folder>"
        install "$2" "$3"
        ;;
    *) fail "usage: install.sh plan | install <cache folder> <bin folder>" ;;
esac
