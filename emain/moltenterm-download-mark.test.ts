// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { MarkDeps, markDownloadedFile, quarantineValue, zoneIdentifier } from "./moltenterm-download-mark";

function deps(platform: string, over: Partial<MarkDeps> = {}) {
    const runs: { file: string; args: string[] }[] = [];
    const writes: { path: string; data: string }[] = [];
    const made: MarkDeps = {
        platform,
        run: async (file, args) => {
            runs.push({ file, args });
            return { code: 0, stdout: "" };
        },
        readFile: async () => {
            throw new Error("no such stream");
        },
        writeFile: async (path, data) => {
            writes.push({ path, data });
        },
        ...over,
    };
    return { made, runs, writes };
}

describe("the system's downloaded-from-the-internet mark (FR-MC-019 AC12)", () => {
    it("is written in the quarantine format the system reads", () => {
        expect(quarantineValue(1_700_000_000_000, "U-1")).toBe("0083;6553f100;MoltenTerm;U-1");
    });

    it("leaves the mark the engine already wrote", async () => {
        const { made, runs } = deps("darwin");
        expect(await markDownloadedFile(made, "/dl/a.pdf", "https://x/a.pdf", "", 1000, "U")).toBe("present");
        expect(runs.map((r) => r.args[0])).toEqual(["-p"]);
    });

    it("writes the mark itself when the engine did not", async () => {
        const calls: string[][] = [];
        const { made } = deps("darwin", {
            run: async (_file, args) => {
                calls.push(args);
                return { code: args[0] === "-p" ? 1 : 0, stdout: "" };
            },
        });
        expect(await markDownloadedFile(made, "/dl/a.pdf", "https://x/a.pdf", "", 1_700_000_000_000, "U")).toBe("set");
        expect(calls[1]).toEqual(["-w", "com.apple.quarantine", "0083;6553f100;MoltenTerm;U", "/dl/a.pdf"]);
    });

    it("writes the Internet zone to the file's stream where the system has one", async () => {
        const { made, writes } = deps("win32");
        expect(await markDownloadedFile(made, "C:\\dl\\a.pdf", "https://x/a.pdf", "https://x/page", 1, "U")).toBe(
            "set"
        );
        expect(writes).toEqual([
            { path: "C:\\dl\\a.pdf:Zone.Identifier", data: zoneIdentifier("https://x/a.pdf", "https://x/page") },
        ]);
        expect(writes[0].data).toContain("ZoneId=3");
    });

    it("leaves an Internet zone that is there", async () => {
        const { made, writes } = deps("win32", { readFile: async () => "[ZoneTransfer]\r\nZoneId=3\r\n" });
        expect(await markDownloadedFile(made, "C:\\dl\\a.pdf", "u", "", 1, "U")).toBe("present");
        expect(writes).toEqual([]);
    });

    it("records where a file came from on a system without a quarantine, when the tool is there", async () => {
        const { made, runs } = deps("linux");
        expect(await markDownloadedFile(made, "/dl/a.pdf", "https://x/a.pdf", "", 1, "U")).toBe("set");
        expect(runs[0]).toEqual({
            file: "setfattr",
            args: ["-n", "user.xdg.origin.url", "-v", "https://x/a.pdf", "/dl/a.pdf"],
        });
        const missing = deps("linux", { run: async () => ({ code: 127, stdout: "" }) });
        expect(await markDownloadedFile(missing.made, "/dl/a.pdf", "https://x/a.pdf", "", 1, "U")).toBe("skipped");
    });

    it("never fails the download because the mark could not be written", async () => {
        const { made } = deps("darwin", {
            run: async () => {
                throw new Error("boom");
            },
        });
        expect(await markDownloadedFile(made, "/dl/a.pdf", "u", "", 1, "U")).toBe("failed");
    });
});
