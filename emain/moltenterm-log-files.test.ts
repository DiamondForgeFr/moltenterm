// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    CurrentLogName,
    DefaultLogLimits,
    listRotatedLogs,
    LogFileHooks,
    LogLimits,
    LogsDirName,
    pruneLogs,
    readLogsInfo,
    rotatedLogNumber,
    RotatingLogFile,
} from "./moltenterm-log-files";

let dataDir: string;
const opened: RotatingLogFile[] = [];

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mt2335-logs-"));
});

afterEach(async () => {
    // The writer still holds the file: wait for it before the folder goes.
    await Promise.all(opened.splice(0).map((f) => f.close()));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

function open(limits: LogLimits, hooks: LogFileHooks = {}): RotatingLogFile {
    const file = new RotatingLogFile(dataDir, limits, hooks);
    opened.push(file);
    return file;
}

const Tiny: LogLimits = { rotateAt: 1000, keep: 1000, totalCap: 1_000_000_000 };

// A 100 byte line that says which one it is.
function line(n: number): string {
    return `${String(n).padStart(5, "0")} ${"x".repeat(93)}\n`;
}

function readLines(file: string): string[] {
    return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "");
}

// Every line of every file, the oldest rotated file first and the current file last.
async function allLines(): Promise<string[]> {
    const rotated = await listRotatedLogs(dataDir);
    const names = [...rotated.map((f) => path.join(dataDir, LogsDirName, f.name)), path.join(dataDir, CurrentLogName)];
    return names.flatMap((n) => (fs.existsSync(n) ? readLines(n) : []));
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("rotation while the app runs (#2335)", () => {
    it("moves the file past the cap and keeps logging in a new one at the same path", async () => {
        const files = open(Tiny);
        for (let i = 0; i < 11; i++) {
            files.write(line(i));
        }
        await files.flush();
        const rotated = await listRotatedLogs(dataDir);
        expect(rotated.map((f) => f.name)).toEqual(["waveapp.1.log"]);
        expect(fs.statSync(path.join(dataDir, CurrentLogName)).size).toBe(0);
        files.write(line(11));
        await files.flush();
        expect(readLines(path.join(dataDir, CurrentLogName))).toEqual([line(11).trim()]);
    });

    it("loses no line and keeps their order when lines arrive while the file is being moved", async () => {
        const files = open(Tiny);
        for (let i = 0; i < 11; i++) {
            files.write(line(i));
        }
        // The rotation was asked; its first step has run. These lines come in during the move.
        await Promise.resolve();
        for (let i = 11; i < 20; i++) {
            files.write(line(i));
        }
        await files.flush();
        expect(await allLines()).toEqual(Array.from({ length: 20 }, (_, i) => line(i).trim()));
        expect((await listRotatedLogs(dataDir)).length).toBeGreaterThan(0);
    });

    it("splits what arrives while the file is moved into files of about the cap", async () => {
        const files = open(Tiny);
        for (let i = 0; i < 11; i++) {
            files.write(line(i));
        }
        await Promise.resolve();
        for (let i = 11; i < 60; i++) {
            files.write(line(i));
        }
        await files.flush();
        const rotated = await listRotatedLogs(dataDir);
        expect(rotated.length).toBeGreaterThanOrEqual(5);
        for (const file of rotated) {
            expect(file.size).toBeLessThanOrEqual(Tiny.rotateAt + line(0).length);
        }
        expect(await allLines()).toEqual(Array.from({ length: 60 }, (_, i) => line(i).trim()));
    });

    it("loses no line across many rotations whatever the timing", async () => {
        const files = open(Tiny);
        const total = 400;
        for (let i = 0; i < total; i++) {
            files.write(line(i));
            // Rotations start and finish at different points of the stream of lines.
            if (i % 7 === 3) {
                await nextTurn();
            } else if (i % 5 === 0) {
                await Promise.resolve();
            }
        }
        await files.flush();
        expect(await allLines()).toEqual(Array.from({ length: total }, (_, i) => line(i).trim()));
        expect((await listRotatedLogs(dataDir)).length).toBeGreaterThan(3);
        // Settled, the current file is under the cap.
        expect(fs.statSync(path.join(dataDir, CurrentLogName)).size).toBeLessThan(Tiny.rotateAt);
    });

    it("numbers the rotated files one after the highest", async () => {
        fs.mkdirSync(path.join(dataDir, LogsDirName), { recursive: true });
        fs.writeFileSync(path.join(dataDir, LogsDirName, "waveapp.7.log"), "old\n");
        const files = open(Tiny);
        for (let i = 0; i < 11; i++) {
            files.write(line(i));
        }
        await files.flush();
        expect((await listRotatedLogs(dataDir)).map((f) => f.name)).toEqual(["waveapp.7.log", "waveapp.8.log"]);
    });

    it("keeps appending when the file cannot be moved, and tries again one cap further", async () => {
        const errors: string[] = [];
        const files = open(Tiny, { onError: (message: string) => errors.push(message) });
        // A file where the folder of the rotated logs should be: the move fails.
        fs.rmSync(path.join(dataDir, LogsDirName), { recursive: true, force: true });
        fs.writeFileSync(path.join(dataDir, LogsDirName), "not a folder");
        for (let i = 0; i < 11; i++) {
            files.write(line(i));
        }
        await files.flush();
        expect(errors).toEqual(["log rotation failed"]);
        for (let i = 11; i < 15; i++) {
            files.write(line(i));
        }
        await files.flush();
        expect(errors).toEqual(["log rotation failed"]);
        expect(readLines(path.join(dataDir, CurrentLogName))).toEqual(
            Array.from({ length: 15 }, (_, i) => line(i).trim())
        );
        for (let i = 15; i < 22; i++) {
            files.write(line(i));
        }
        await files.flush();
        expect(errors).toEqual(["log rotation failed", "log rotation failed"]);
        expect(readLines(path.join(dataDir, CurrentLogName)).length).toBe(22);
    });

    it("counts the bytes of a file that is already there", async () => {
        fs.writeFileSync(path.join(dataDir, CurrentLogName), line(0).repeat(9));
        const files = open(Tiny);
        files.write(line(9));
        await files.flush();
        expect((await listRotatedLogs(dataDir)).length).toBe(1);
        expect(fs.statSync(path.join(dataDir, CurrentLogName)).size).toBe(0);
    });
});

describe("the logs stay bounded (#2335)", () => {
    it("keeps the newest rotated files only", async () => {
        const files = open({ rotateAt: 1000, keep: 2, totalCap: 1_000_000_000 });
        for (let i = 0; i < 60; i++) {
            files.write(line(i));
            if (i % 10 === 9) {
                await files.flush();
            }
        }
        await files.flush();
        const names = (await listRotatedLogs(dataDir)).map((f) => f.name);
        expect(names.length).toBe(2);
        const nums = names.map(rotatedLogNumber);
        expect(nums[1]).toBe(nums[0] + 1);
        expect(nums[1]).toBeGreaterThan(2);
    });

    it("never leaves the folder, current file included, above its total cap", async () => {
        const limits: LogLimits = { rotateAt: 1000, keep: 1000, totalCap: 3500 };
        const files = open(limits);
        for (let i = 0; i < 200; i++) {
            files.write(line(i));
            if (i % 11 === 0) {
                await nextTurn();
            }
        }
        await files.flush();
        const info = await readLogsInfo(dataDir);
        expect(info.total).toBeLessThanOrEqual(limits.totalCap);
        expect(info.current).toBeLessThan(limits.rotateAt);
        // The newest lines are the ones left: the oldest files went first.
        const lines = await allLines();
        expect(lines[lines.length - 1]).toBe(line(199).trim());
        const first = parseInt(lines[0].slice(0, 5), 10);
        expect(lines.map((l) => parseInt(l.slice(0, 5), 10))).toEqual(
            Array.from({ length: lines.length }, (_, i) => first + i)
        );
    });

    it("removes a rotated file bigger than the cap, such as the one a launch moves aside", async () => {
        const logs = path.join(dataDir, LogsDirName);
        fs.mkdirSync(logs, { recursive: true });
        fs.writeFileSync(path.join(logs, "waveapp.1.log"), "a".repeat(500));
        fs.writeFileSync(path.join(logs, "waveapp.2.log"), "b".repeat(10_000));
        fs.writeFileSync(path.join(dataDir, CurrentLogName), "c".repeat(10));
        const files = open({ rotateAt: 1000, keep: 100, totalCap: 2000 });
        const info = await files.maintain();
        expect(await listRotatedLogs(dataDir)).toEqual([]);
        expect(info.total).toBe(10);
        expect(fs.readFileSync(path.join(dataDir, CurrentLogName), "utf8")).toBe("c".repeat(10));
    });

    it("tells what the logs weigh after a launch", async () => {
        fs.mkdirSync(path.join(dataDir, LogsDirName), { recursive: true });
        fs.writeFileSync(path.join(dataDir, LogsDirName, "waveapp.1.log"), "a".repeat(300));
        fs.writeFileSync(path.join(dataDir, CurrentLogName), "c".repeat(20));
        const told: number[] = [];
        const files = open(DefaultLogLimits, { onMaintained: (info) => told.push(info.total) });
        await files.maintain();
        expect(told).toEqual([320]);
        expect(await readLogsInfo(dataDir)).toEqual({ total: 320, current: 20, rotated: 300, files: 2 });
    });

    it("prunes by the number kept and then by the cap, oldest first, and never the current file", async () => {
        const logs = path.join(dataDir, LogsDirName);
        fs.mkdirSync(logs, { recursive: true });
        for (const n of [1, 2, 3, 4]) {
            fs.writeFileSync(path.join(logs, `waveapp.${n}.log`), "z".repeat(100));
        }
        fs.writeFileSync(path.join(logs, "notes.txt"), "not a log of the app");
        const removed = await pruneLogs(dataDir, { rotateAt: 100, keep: 3, totalCap: 250 }, 100);
        expect(removed).toEqual(["waveapp.1.log", "waveapp.2.log", "waveapp.3.log"]);
        expect(fs.existsSync(path.join(logs, "notes.txt"))).toBe(true);
        expect((await listRotatedLogs(dataDir)).map((f) => f.name)).toEqual(["waveapp.4.log"]);
    });
});

describe("Clear logs (#2335)", () => {
    it("removes the rotated files and empties the current one in place while the app keeps logging", async () => {
        const files = open(Tiny);
        for (let i = 0; i < 45; i++) {
            files.write(line(i));
            if (i % 9 === 8) {
                await files.flush();
            }
        }
        await files.flush();
        const current = path.join(dataDir, CurrentLogName);
        expect((await listRotatedLogs(dataDir)).length).toBeGreaterThan(1);
        const before = fs.statSync(current);
        const sizeBefore = (await readLogsInfo(dataDir)).total;
        const result = await files.clear();
        expect(result.ok).toBe(true);
        expect(result.removed).toBeGreaterThan(1);
        expect(result.freed).toBe(sizeBefore);
        expect(await listRotatedLogs(dataDir)).toEqual([]);
        // The same file, emptied: nothing was deleted under the writer.
        expect(fs.statSync(current).ino).toBe(before.ino);
        expect(fs.statSync(current).size).toBe(0);
        // The emptied file still counts: "1 file, the current one included".
        expect((await readLogsInfo(dataDir)).files).toBe(1);
        files.write(line(100));
        files.write(line(101));
        await files.flush();
        expect(readLines(current)).toEqual([line(100).trim(), line(101).trim()]);
        expect((await readLogsInfo(dataDir)).total).toBe(200);
    });

    it("counts again from zero: the cap is reached after the lines written since", async () => {
        const files = open(Tiny);
        for (let i = 0; i < 9; i++) {
            files.write(line(i));
        }
        await files.flush();
        await files.clear();
        for (let i = 0; i < 9; i++) {
            files.write(line(i));
        }
        await files.flush();
        expect(await listRotatedLogs(dataDir)).toEqual([]);
        files.write(line(9));
        files.write(line(10));
        await files.flush();
        expect((await listRotatedLogs(dataDir)).length).toBe(1);
    });

    it("clears while lines keep arriving, and every line that follows lands in the file", async () => {
        const files = open(Tiny);
        for (let i = 0; i < 30; i++) {
            files.write(line(i));
        }
        const clearing = files.clear();
        for (let i = 30; i < 40; i++) {
            files.write(line(i));
        }
        expect((await clearing).ok).toBe(true);
        await files.flush();
        files.write(line(99));
        await files.flush();
        const lines = await allLines();
        expect(lines[lines.length - 1]).toBe(line(99).trim());
        expect(fs.existsSync(path.join(dataDir, CurrentLogName))).toBe(true);
    });

    it("reports a clear that finds nothing as a success", async () => {
        const files = open(Tiny);
        await files.flush();
        fs.rmSync(path.join(dataDir, CurrentLogName), { force: true });
        const result = await files.clear();
        expect(result).toEqual({ ok: true, removed: 0, freed: 0, failed: 0 });
    });
});

describe("the writer once closed", () => {
    it("takes no more lines", async () => {
        const files = open(Tiny);
        files.write(line(0));
        await files.close();
        files.write(line(1));
        expect(readLines(path.join(dataDir, CurrentLogName))).toEqual([line(0).trim()]);
    });
});
