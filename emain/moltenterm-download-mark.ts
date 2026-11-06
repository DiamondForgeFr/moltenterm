// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The system's "downloaded from the internet" mark on a saved file (FR-MC-019 AC12, #1992): it is what makes the
// system itself wary when the file is opened. The engine may already have written it; this checks and writes it only
// when it is missing. #1982 (phishing and malware protection) builds the reputation of sites and the warning at
// download time on top of it, and is not implemented here.

import { execFile } from "child_process";
import * as fs from "fs";

export type MarkOutcome = "set" | "present" | "skipped" | "failed";

export type MarkRun = (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;

export type MarkDeps = {
    platform: string;
    run: MarkRun;
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, data: string) => Promise<void>;
};

export function runCommand(file: string, args: string[]): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve) => {
        execFile(file, args, { timeout: 10000 }, (error, stdout) => {
            const code = error == null ? 0 : typeof (error as any).code === "number" ? (error as any).code : 1;
            resolve({ code, stdout: String(stdout ?? "") });
        });
    });
}

export const realMarkDeps: MarkDeps = {
    platform: process.platform,
    run: runCommand,
    readFile: (p) => fs.promises.readFile(p, "utf8"),
    writeFile: (p, data) => fs.promises.writeFile(p, data),
};

// "0083;<hex seconds>;<app>;<uuid>": the flags, when, by which application, and an identifier.
export function quarantineValue(nowMs: number, uuid: string): string {
    return `0083;${Math.floor(nowMs / 1000).toString(16)};MoltenTerm;${uuid}`;
}

// The Zone.Identifier stream's content: zone 3 is the Internet.
export function zoneIdentifier(url: string, pageUrl: string): string {
    const lines = ["[ZoneTransfer]", "ZoneId=3"];
    if (pageUrl) {
        lines.push(`ReferrerUrl=${pageUrl}`);
    }
    if (url) {
        lines.push(`HostUrl=${url}`);
    }
    return lines.join("\r\n") + "\r\n";
}

const MacAttribute = "com.apple.quarantine";
const LinuxAttribute = "user.xdg.origin.url";

export async function markDownloadedFile(
    deps: MarkDeps,
    file: string,
    url: string,
    pageUrl: string,
    nowMs: number,
    uuid: string
): Promise<MarkOutcome> {
    try {
        if (deps.platform === "darwin") {
            if ((await deps.run("xattr", ["-p", MacAttribute, file])).code === 0) {
                return "present";
            }
            const wrote = await deps.run("xattr", ["-w", MacAttribute, quarantineValue(nowMs, uuid), file]);
            return wrote.code === 0 ? "set" : "failed";
        }
        if (deps.platform === "win32") {
            const stream = `${file}:Zone.Identifier`;
            const existing = await deps.readFile(stream).catch(() => "");
            if (existing.includes("ZoneId=")) {
                return "present";
            }
            await deps.writeFile(stream, zoneIdentifier(url, pageUrl));
            return "set";
        }
        // Linux has no quarantine: the freedesktop attribute that records where a file came from, when the tool exists.
        if (!url) {
            return "skipped";
        }
        const wrote = await deps.run("setfattr", ["-n", LinuxAttribute, "-v", url, file]);
        return wrote.code === 0 ? "set" : "skipped";
    } catch (e) {
        console.log("downloads: marking the file failed", e instanceof Error ? e.message : String(e));
        return "failed";
    }
}
