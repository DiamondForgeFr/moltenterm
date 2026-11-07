// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The CI install of Task (#1956, .github/actions/setup-task): a download that fails a few times, by an HTTP 500 or a cut
// connection, still installs Task; a cached copy installs it without any download; and an archive that misses its pinned
// SHA-256, cached or downloaded, never runs. Every download goes to a local server, never to the network.
//
// Usage: node --test scripts/moltenterm-setup-task.node-test.mjs

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const actionDir = path.join(root, ".github", "actions", "setup-task");
const workflowsDir = path.join(root, ".github", "workflows");
const Version = "v9.9.9";
const Archive = "task_linux_amd64.tar.gz";

function tempDir(t, name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `setup-task-${name}-`));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// A Task archive whose `task` prints the version; `extra` runs first, so an archive that should never run can say it did.
function makeArchive(t, name, extra = "") {
    const dir = tempDir(t, name);
    const task = path.join(dir, "task");
    fs.writeFileSync(task, `#!/bin/sh\n${extra}\necho "Task version: ${Version} (${name})"\n`, { mode: 0o755 });
    const archive = path.join(dir, "archive.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", dir, "task"]);
    return fs.readFileSync(archive);
}

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// The installer as the action runs it, with pins of its own: the archive above stands for the pinned release.
function makeInstaller(t, pinned) {
    const dir = tempDir(t, "action");
    fs.copyFileSync(path.join(actionDir, "install.sh"), path.join(dir, "install.sh"));
    fs.writeFileSync(path.join(dir, "pins.txt"), `# test pins\nversion ${Version}\n${sha256(pinned)}  ${Archive}\n`);
    return dir;
}

// Answers each request with the next of `responses` (the last one repeats): a status code, "cut" (a connection closed
// halfway through the archive) or the archive's bytes.
async function serve(t, archive, responses) {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push(req.url);
        const next = responses.length > 1 ? responses.shift() : responses[0];
        if (typeof next === "number") {
            res.writeHead(next);
            res.end();
            return;
        }
        res.writeHead(200, { "content-type": "application/gzip", "content-length": archive.length });
        if (next === "cut") {
            res.write(archive.subarray(0, archive.length >> 1));
            res.destroy();
            return;
        }
        res.end(archive);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return { base: `http://127.0.0.1:${server.address().port}`, requests };
}

function run(installer, args, env) {
    return new Promise((resolve) => {
        execFile(
            "bash",
            [path.join(installer, "install.sh"), ...args],
            { env: { ...process.env, RUNNER_OS: "Linux", RUNNER_ARCH: "X64", TASK_RETRY_DELAYS: "0 0 0", ...env } },
            (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr })
        );
    });
}

// A cache folder, a bin folder and a $GITHUB_PATH of the test's own: the job that runs the test keeps its PATH.
function job(t) {
    const dir = tempDir(t, "job");
    const githubPath = path.join(dir, "github-path");
    fs.writeFileSync(githubPath, "");
    return { cache: path.join(dir, "cache"), bin: path.join(dir, "bin"), githubPath };
}

async function install(t, { pinned, served, responses, cached, marker }) {
    const installer = makeInstaller(t, pinned);
    const server = await serve(t, served ?? pinned, responses);
    const folders = job(t);
    if (cached) {
        fs.mkdirSync(folders.cache, { recursive: true });
        fs.writeFileSync(path.join(folders.cache, Archive), cached);
    }
    const result = await run(installer, ["install", folders.cache, folders.bin], {
        TASK_DOWNLOAD_BASE: server.base,
        GITHUB_PATH: folders.githubPath,
        TASK_TEST_MARKER: marker ?? path.join(folders.cache, "never"),
    });
    return { ...result, ...folders, requests: server.requests };
}

function assertInstalled(result, pinned) {
    assert.equal(result.code, 0, result.stderr);
    assert.match(execFileSync(path.join(result.bin, "task"), ["--version"], { encoding: "utf8" }), /v9\.9\.9/);
    assert.deepEqual(fs.readFileSync(path.join(result.cache, Archive)), pinned);
    assert.deepEqual(fs.readdirSync(result.cache), [Archive]);
    assert.equal(fs.readFileSync(result.githubPath, "utf8"), `${result.bin}\n`);
}

test("a download that fails a few times, by an HTTP 500 or a cut connection, still installs Task", async (t) => {
    const pinned = makeArchive(t, "pinned");
    const result = await install(t, { pinned, responses: [500, "cut", 503, "ok"] });
    assertInstalled(result, pinned);
    assert.deepEqual(result.requests, Array(4).fill(`/${Version}/${Archive}`));
    assert.equal(result.stdout.match(/::warning::Task: download attempt \d+ of .* failed/g)?.length, 3);
});

test("the job fails once the last attempt fails, with nothing installed or cached", async (t) => {
    const pinned = makeArchive(t, "pinned");
    const result = await install(t, { pinned, responses: [500] });
    assert.notEqual(result.code, 0);
    assert.equal(result.requests.length, 4);
    assert.match(result.stderr, /::error::Task: the download of .* failed 4 times/);
    assert.ok(!fs.existsSync(path.join(result.bin, "task")));
    assert.deepEqual(fs.readdirSync(result.cache), []);
    assert.equal(fs.readFileSync(result.githubPath, "utf8"), "");
});

test("a cached copy that matches its pin installs Task without any download", async (t) => {
    const pinned = makeArchive(t, "pinned");
    const result = await install(t, { pinned, cached: pinned, responses: [500] });
    assertInstalled(result, pinned);
    assert.deepEqual(result.requests, []);
    assert.match(result.stdout, /from the cache/);
});

test("a cached copy that misses its pin never runs: the pinned archive is downloaded in its place", async (t) => {
    const pinned = makeArchive(t, "pinned");
    const marker = path.join(tempDir(t, "marker"), "ran");
    const tampered = makeArchive(t, "tampered", `touch "$TASK_TEST_MARKER"`);
    const result = await install(t, { pinned, cached: tampered, responses: ["ok"], marker });
    assertInstalled(result, pinned);
    assert.equal(result.requests.length, 1);
    assert.match(result.stdout, /::warning::Task: the cached .* not the pinned/);
    assert.ok(!fs.existsSync(marker));
});

test("a downloaded archive that misses its pin never runs and fails the job", async (t) => {
    const pinned = makeArchive(t, "pinned");
    const marker = path.join(tempDir(t, "marker"), "ran");
    const tampered = makeArchive(t, "tampered", `touch "$TASK_TEST_MARKER"`);
    const result = await install(t, { pinned, served: tampered, responses: ["ok"], marker });
    assert.notEqual(result.code, 0);
    assert.equal(result.requests.length, 1, "a checksum mismatch is not retried");
    assert.match(result.stderr, new RegExp(`::error::Task: ${Archive} from .* has SHA-256 ${sha256(tampered)}, not the pinned`));
    assert.ok(!fs.existsSync(path.join(result.bin, "task")));
    assert.deepEqual(fs.readdirSync(result.cache), []);
    assert.ok(!fs.existsSync(marker));
});

test("plan names the archive of the runner and its pin, and refuses a system without one", async (t) => {
    const pinned = makeArchive(t, "pinned");
    const installer = makeInstaller(t, pinned);
    const linux = await run(installer, ["plan"], {});
    assert.equal(linux.code, 0, linux.stderr);
    assert.equal(linux.stdout, `archive=${Archive}\nsha256=${sha256(pinned)}\nversion=${Version}\n`);

    const arm = await run(installer, ["plan"], { RUNNER_ARCH: "ARM64" });
    assert.notEqual(arm.code, 0, "these test pins have no linux arm64 archive");
    assert.match(arm.stderr, /pins no SHA-256 for task_linux_arm64\.tar\.gz/);
    assert.equal(arm.stdout, "");

    const windows = await run(installer, ["plan"], { RUNNER_OS: "Windows" });
    assert.notEqual(windows.code, 0);
    assert.match(windows.stderr, /no pinned archive for the system Windows/);
});

test("the pins name one exact release and a SHA-256 for every runner the workflows use", () => {
    const pins = fs.readFileSync(path.join(actionDir, "pins.txt"), "utf8");
    assert.match(pins, /^version v\d+\.\d+\.\d+$/m);
    for (const archive of ["linux_amd64", "linux_arm64", "darwin_amd64", "darwin_arm64"]) {
        assert.match(pins, new RegExp(`^[0-9a-f]{64}  task_${archive}\\.tar\\.gz$`, "m"), archive);
    }
    const action = fs.readFileSync(path.join(actionDir, "action.yml"), "utf8");
    for (const [, ref] of action.matchAll(/^\s*uses:\s*(\S+)/gm)) {
        assert.match(ref, /@[0-9a-f]{40}$/, `${ref} is pinned by commit`);
    }
});

test("every workflow job that runs Task installs it through the pinned action, after the checkout", () => {
    const jobsRunningTask = [];
    for (const file of fs.readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name))) {
        const text = fs.readFileSync(path.join(workflowsDir, file), "utf8");
        assert.doesNotMatch(text, /arduino\/setup-task/, file);
        const jobs = text.split(/^jobs:$/m)[1]?.split(/^ {4}(?=[\w-]+:$)/m) ?? [];
        for (const job of jobs) {
            const runsTask = job.search(/^\s+(?:run:\s+)?task [\w:-]+/m);
            if (runsTask < 0) {
                continue;
            }
            const name = `${file}: ${job.slice(0, job.indexOf(":"))}`;
            jobsRunningTask.push(name);
            const setup = job.search(/^\s+- uses: \.\/\.github\/actions\/setup-task$/m);
            const checkout = job.search(/^\s+- uses: actions\/checkout@/m);
            assert.ok(setup >= 0 && setup < runsTask, `${name} installs Task before it runs it`);
            assert.ok(checkout >= 0 && checkout < setup, `${name} checks the action out before it uses it`);
        }
    }
    assert.ok(jobsRunningTask.length >= 5, jobsRunningTask.join(", "));
});
