// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LogRotateBytes } from "./moltenterm-log-files";

// Electron main's own log, as the app wires it: emain-log.ts over a temporary data folder.
let dataDir: string;
let mod: typeof import("./emain-log");

beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mt2335-wire-"));
    vi.doMock("./emain-platform", () => ({ getWaveDataDir: () => dataDir, isDev: false }));
    // The first load of winston is slow on a loaded machine: it is paid here, where a deadline is generous.
    mod = await import("./emain-log");
}, 60_000);

afterAll(async () => {
    await mod.logFiles?.close();
    vi.doUnmock("./emain-platform");
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const current = () => path.join(dataDir, "waveapp.log");

describe("the app's log over the rotating file (#2335)", () => {
    it("writes each line, stamped, to waveapp.log", async () => {
        mod.log("first line", { n: 1 });
        mod.log("second line");
        await mod.logFiles.flush();
        const lines = fs.readFileSync(current(), "utf8").trimEnd().split("\n");
        expect(lines.length).toBe(2);
        expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} first line \{ n: 1 \}$/);
        expect(lines[1]).toMatch(/ second line$/);
    });

    it("rotates past the cap while the app runs and goes on writing at the same path", async () => {
        const big = "x".repeat(LogRotateBytes);
        mod.log(big);
        await mod.logFiles.flush();
        const rotated = fs.readdirSync(path.join(dataDir, "logs"));
        expect(rotated).toEqual(["waveapp.1.log"]);
        const moved = fs.readFileSync(path.join(dataDir, "logs", "waveapp.1.log"), "utf8");
        expect(moved).toContain("first line");
        expect(moved).toContain(big);
        expect(fs.statSync(current()).size).toBe(0);
        mod.log("after the rotation");
        mod.log("and again");
        await mod.logFiles.flush();
        const now = fs.readFileSync(current(), "utf8");
        expect(now).toMatch(/ after the rotation\n.* and again\n$/);
        expect(now).not.toContain("first line");
    });
});
