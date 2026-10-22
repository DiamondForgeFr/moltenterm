// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url));

test("validation ignores nested worktrees but validates a checkout inside worktree storage", (t) => {
    const temporary = mkdtempSync(path.join(tmpdir(), "mt820-discovery-"));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    // An ancestor with this name must not suppress the checkout's own files.
    const checkout = path.join(temporary, ".claude/worktrees/current");
    mkdirSync(checkout, { recursive: true });
    symlinkSync(path.join(repo, "node_modules"), path.join(checkout, "node_modules"), "dir");
    for (const name of ["vitest.config.ts", "eslint.config.js"]) {
        copyFileSync(path.join(repo, name), path.join(checkout, name));
    }
    const write = (name, content) => {
        const target = path.join(checkout, name);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
    };
    write("package.json", '{"type":"module"}\n');
    // Exercise the production discovery configuration without loading the app's build plugins.
    write("electron.vite.config.ts", "export default { renderer: {} };\n");
    const passing = 'import { test, expect } from "vitest"; test("included", () => expect(true).toBe(true));\n';
    const failing = 'import { test, expect } from "vitest"; test("included", () => expect(true).toBe(false));\n';
    write("scripts/included.test.js", passing);
    write(".claude/worktrees/broken/scripts/broken.test.js", failing);
    write(".claude/worktrees/broken/scripts/broken.js", "debugger;\n");
    const run = (tool, args) => {
        const result = spawnSync(process.execPath, [path.join(repo, "node_modules", tool), ...args], {
            cwd: checkout,
            encoding: "utf8",
            timeout: 120_000,
            env: { ...process.env, NO_COLOR: "1" },
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null, result.stderr);
        return { status: result.status, output: result.stdout + result.stderr };
    };
    const vitest = () => run("vitest/vitest.mjs", ["run", "--reporter=dot"]);
    const eslint = () => run("eslint/bin/eslint.js", [".", "--quiet"]);
    const tests = vitest();
    assert.equal(tests.status, 0, tests.output);
    assert.match(tests.output, /1 passed/);
    const cleanLint = eslint();
    assert.equal(cleanLint.status, 0, cleanLint.output);

    // Neither the harness directory nor ordinary sources are blanket-excluded.
    write(".claude/discovery.test.js", failing);
    const detected = vitest();
    assert.notEqual(detected.status, 0, detected.output);
    assert.match(detected.output, /discovery\.test\.js/);
    write("scripts/included.js", "debugger;\n");
    const lint = eslint();
    assert.notEqual(lint.status, 0, lint.output);
    assert.match(lint.output, /no-debugger/);
    assert.doesNotMatch(lint.output, /broken\.js/);
});
