// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const electron = require("electron") as string;
const exec = promisify(execFile);

it("extracts terminal clipboard text without executing HTML or fetching resources in Electron", async () => {
    const fixture = "scripts/clipboard-security-browser-check.cjs";
    const command = process.platform === "linux" ? "xvfb-run" : electron;
    const args = process.platform === "linux" ? ["-a", electron, "--no-sandbox", fixture] : [fixture];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const storage = await mkdtemp(path.join(os.tmpdir(), "moltenterm-clipboard-test-"));
    try {
        const { stdout } = await exec(command, args, { env: { ...env, MOLTENTERM_CLIPBOARD_DATA_DIR: storage }, timeout: 90000 });
        expect(stdout).toContain('"result":"PASS"');
        expect(stdout).toContain('"positiveControl":"PASS"');
        expect(stdout).toContain('"resourceRequests":0');
    } finally {
        await rm(storage, { recursive: true, force: true });
    }
}, 100000);
