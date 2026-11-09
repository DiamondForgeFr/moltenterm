// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const Script = path.join(Root, "scripts", "moltenterm-npm-ci.sh");
const FakeNpm = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_NPM_DIR/calls"
calls=$(($(wc -l < "$FAKE_NPM_DIR/calls")))
if [ "$calls" -le "$FAKE_NPM_FAILURES" ]; then exit 7; fi
exit 0
`;

const dirs = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function run(failures, args) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-npm-ci-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "npm"), FakeNpm, { mode: 0o755 });
    const result = spawnSync("bash", [Script, ...args], {
        encoding: "utf8",
        env: {
            ...process.env,
            PATH: `${dir}${path.delimiter}${process.env.PATH}`,
            FAKE_NPM_DIR: dir,
            FAKE_NPM_FAILURES: String(failures),
            MOLTENTERM_NPM_CI_PAUSE: "0",
        },
    });
    const callsFile = path.join(dir, "calls");
    const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n") : [];
    return { status: result.status, stderr: result.stderr, calls };
}

// Each case starts bash and up to three fake npm processes: a loaded machine needs more than the 5 s default.
describe("moltenterm-npm-ci.sh", { timeout: 60_000 }, () => {
    it("installs once when npm ci succeeds", () => {
        const { status, calls } = run(0, ["--no-audit", "--no-fund"]);
        expect(status).toBe(0);
        expect(calls).toEqual(["ci --no-audit --no-fund"]);
    });

    it("retries a failed install with the same flags", () => {
        const { status, calls, stderr } = run(2, ["--ignore-scripts", "--no-audit", "--no-fund"]);
        expect(status).toBe(0);
        expect(calls).toEqual(Array(3).fill("ci --ignore-scripts --no-audit --no-fund"));
        expect(stderr).toContain("attempt 2 of 3");
    });

    it("fails with npm's exit code after the third failure", () => {
        const { status, calls, stderr } = run(99, ["--no-audit", "--no-fund"]);
        expect(status).toBe(7);
        expect(calls).toHaveLength(3);
        expect(stderr).toContain("giving up");
    });
});

describe("CI and release installs", () => {
    for (const file of ["ci.yml", "release.yml"]) {
        it(`${file} installs through the retrying helper`, () => {
            const workflow = parse(fs.readFileSync(path.join(Root, ".github", "workflows", file), "utf8"));
            const runs = Object.values(workflow.jobs).flatMap((job) => (job.steps ?? []).map((step) => step.run ?? ""));
            expect(runs.filter((run) => /(^|[\s;&|])npm ci\b/m.test(run))).toEqual([]);
            expect(runs.some((run) => run.startsWith("scripts/moltenterm-npm-ci.sh "))).toBe(true);
        });
    }
});
