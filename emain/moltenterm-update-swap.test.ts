// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The gold swap script run for real against fake app bundles (#1193): a liveness check that cannot run never rolls
// back a build that started, and a build that really quits is still rolled back.

import { execFileSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: true }, ipcMain: { handle: () => {} } }));
vi.mock("./emain-activity", () => ({ setUserConfirmedQuit: () => {} }));
vi.mock("./emain-platform", () => ({ getWaveDataDir: () => "/nonexistent" }));
vi.mock("./moltenterm-release-feed", () => ({ initMoltentermReleaseFeed: () => {} }));

import { SwapScript } from "./moltenterm-update";

const OnMac = process.platform === "darwin" && fs.existsSync("/usr/bin/codesign");
// Met by an ad hoc signature: the test checks the swap's liveness logic, not the signature (moltenterm-gold-signature).
const Requirement = 'identifier "fr.diamondforge.moltenterm.gold"';
const Build = "2000000000";
const WaitMs = 60_000;

// The fake app: records its pid for cleanup, writes the swap's start marker when asked, then stays open or quits.
const FakeApp = `#!/bin/sh
echo $$ >> "$FAKE_PIDS"
[ -n "$FAKE_WRITE_MARKER" ] && echo $$ > "$FAKE_MARKER"
[ -n "$FAKE_QUIT" ] && exit 0
while :; do sleep 1; done
`;

const OldApp = `#!/bin/sh
echo reopened > "$FAKE_OLD_REOPENED"
`;

const temps: string[] = [];
afterEach(() => {
    for (const dir of temps.splice(0)) {
        killFakeApps(dir);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function killFakeApps(dir: string) {
    let pids: string[] = [];
    try {
        pids = fs.readFileSync(path.join(dir, "pids"), "utf8").split("\n").filter(Boolean);
    } catch {
        return;
    }
    for (const pid of pids) {
        try {
            process.kill(Number(pid), "SIGKILL");
        } catch {
            // already gone
        }
    }
}

function bundle(app: string, exe: string, sign: boolean) {
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "MacOS", "MoltenTerm"), exe, { mode: 0o755 });
    fs.writeFileSync(
        path.join(app, "Contents", "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>fr.diamondforge.moltenterm.gold</string>
<key>CFBundleExecutable</key><string>MoltenTerm</string>
<key>CFBundleVersion</key><string>${Build}</string>
</dict></plist>`
    );
    if (sign) {
        execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { stdio: "ignore" });
    }
}

type Scenario = { brokenListing: boolean; writeMarker: boolean; quit: boolean };

async function runSwap(s: Scenario) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-gold-swap-"));
    temps.push(dir);
    const installed = path.join(dir, "MoltenTerm Gold.app");
    bundle(installed, OldApp, false);
    fs.writeFileSync(path.join(installed, "old"), "old");
    const staged = path.join(dir, "staged", "Moltenterm.app");
    bundle(staged, FakeApp, true);
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    if (s.brokenListing) {
        // What a machine without sysmond answers (#1193).
        fs.writeFileSync(path.join(bin, "pgrep"), "#!/bin/sh\necho 'pgrep: Cannot get process list' >&2\nexit 3\n", {
            mode: 0o755,
        });
        fs.writeFileSync(path.join(bin, "ps"), "#!/bin/sh\necho 'ps: sysmond service not found' >&2\nexit 1\n", {
            mode: 0o755,
        });
    }
    const status = path.join(dir, "swap.status");
    const marker = path.join(dir, "swap.started");
    const script = path.join(dir, "swap.sh");
    fs.writeFileSync(script, SwapScript, { mode: 0o755 });
    const gone = execFileSync("/bin/sh", ["-c", "/usr/bin/true & echo $!; wait"], { encoding: "utf8" }).trim();
    const child = spawn(
        "/bin/sh",
        [script, gone, staged, installed, installed, "1", Build, status, Requirement, marker],
        {
            env: {
                PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
                MOLTENTERM_SWAP_DIRECT: "1",
                MOLTENTERM_SWAP_GRACE: "2",
                FAKE_PIDS: path.join(dir, "pids"),
                FAKE_MARKER: marker,
                FAKE_WRITE_MARKER: s.writeMarker ? "1" : "",
                FAKE_QUIT: s.quit ? "1" : "",
                FAKE_OLD_REOPENED: path.join(dir, "old-reopened"),
            },
            stdio: ["ignore", "pipe", "pipe"],
        }
    );
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    const code = await new Promise<number>((resolve) => child.on("exit", (c) => resolve(c)));
    await waitFor(() => fs.existsSync(status));
    return {
        code,
        log,
        status: fs.readFileSync(status, "utf8").trim(),
        dir,
        installed,
        newKept: () => !fs.existsSync(path.join(installed, "old")) && fs.existsSync(installed),
        oldRestored: () => fs.readFileSync(path.join(installed, "old"), "utf8") === "old",
    };
}

async function waitFor(cond: () => boolean) {
    const deadline = Date.now() + WaitMs;
    while (!cond()) {
        if (Date.now() > deadline) {
            throw new Error("timed out");
        }
        await new Promise((r) => setTimeout(r, 50));
    }
}

describe.runIf(OnMac)("gold swap liveness (#1193)", () => {
    it(
        "keeps a started build when no process check can run, and says so",
        async () => {
            const r = await runSwap({ brokenListing: true, writeMarker: false, quit: false });
            expect(r.code).toBe(0);
            expect(r.status).toBe(`installed ${Build} unchecked`);
            expect(r.newKept()).toBe(true);
            expect(r.log).toMatch(/could not be checked/);
        },
        WaitMs * 2
    );

    it(
        "keeps a build whose start marker names a running process, without listing processes",
        async () => {
            const r = await runSwap({ brokenListing: true, writeMarker: true, quit: false });
            expect(r.status).toMatch(new RegExp(`^installed ${Build}( unchecked)?$`));
            expect(r.newKept()).toBe(true);
        },
        WaitMs * 2
    );

    it(
        "rolls back a build that quits within the grace and reopens the previous one",
        async () => {
            const r = await runSwap({ brokenListing: false, writeMarker: true, quit: true });
            expect(r.status).toBe(`rolledback ${Build}`);
            expect(r.oldRestored()).toBe(true);
            await waitFor(() => fs.existsSync(path.join(r.dir, "old-reopened")));
        },
        WaitMs * 2
    );

    it(
        "rolls back a build that quits before writing its marker, when processes can be listed",
        async () => {
            const r = await runSwap({ brokenListing: false, writeMarker: false, quit: true });
            expect(r.status).toBe(`rolledback ${Build}`);
            expect(r.oldRestored()).toBe(true);
        },
        WaitMs * 2
    );
});
