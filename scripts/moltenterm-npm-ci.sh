#!/usr/bin/env bash
# Copyright 2026, DiamondForge
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runs `npm ci` with the given flags, up to three times. A download can time out on a runner (sharp's libvips in CI
# run 42467859249, #2122) and fail a release build for nothing. `npm ci` removes node_modules before it installs, so
# each attempt installs the same lockfile from scratch; the third failure fails the step with npm's exit code, so a
# real failure (a lockfile out of step, a missing package) still stops the job, three times slower.
#
# usage: scripts/moltenterm-npm-ci.sh [npm ci flags...]
# MOLTENTERM_NPM_CI_PAUSE: seconds between attempts (default 20; the tests use 0).
set -uo pipefail

attempts=3
pause="${MOLTENTERM_NPM_CI_PAUSE:-20}"
attempt=1
while true; do
    npm ci "$@" && exit 0
    status=$?
    if [ "${attempt}" -ge "${attempts}" ]; then
        echo "npm ci failed ${attempt} times (exit ${status}); giving up" >&2
        exit "${status}"
    fi
    echo "npm ci failed (exit ${status}, attempt ${attempt} of ${attempts}); retrying in ${pause} s" >&2
    sleep "${pause}"
    attempt=$((attempt + 1))
done
