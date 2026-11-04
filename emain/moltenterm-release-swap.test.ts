// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The swaps of the in-app update of a release (#1860), run for real against fake apps: the macOS bundle through the
// gold swap script (integrity-only requirement, quarantine left alone, system assessment), and the Linux AppImage
// through its own script (checksum re-checked right before the move, rollback of a build that does not stay open).
//
// The script judges a reopened build after a grace period, a clock. As in moltenterm-update-swap.test.ts the test
// replaces the clock: the `sleep` the script finds first on its PATH returns once the fake build is in the state the
// scenario describes, however long that takes, so a loaded machine cannot flip a verdict.

import { execFileSync, spawn } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: true }, ipcMain: { handle: () => {} } }));
vi.mock("./emain-activity", () => ({ setUserConfirmedQuit: () => {} }));
vi.mock("./emain-platform", () => ({ getWaveDataDir: () => "/nonexistent" }));
vi.mock("./moltenterm-release-feed", () => ({ initMoltentermReleaseFeed: () => {} }));

import { AppImageSwapScript, isAppImageHeader, releaseAppImageSwap } from "./moltenterm-appimage-swap";
import { releaseMacSwap, SwapScript } from "./moltenterm-update";

const OnMac = process.platform === "darwin" && fs.existsSync("/usr/bin/codesign");
const WaitMs = 60_000;
const Version = "1.0.0-9";

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

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-release-swap-"));
    temps.push(dir);
    return dir;
}

// A pid that is certainly gone: the app that had to quit.
function gonePid(): string {
    return execFileSync("/bin/sh", ["-c", "/usr/bin/true & echo $!; wait"], { encoding: "utf8" }).trim();
}

async function runScript(
    script: string,
    args: string[],
    dir: string,
    env: Record<string, string> = {}
): Promise<{ code: number; log: string }> {
    const file = path.join(dir, "swap-script.sh");
    fs.writeFileSync(file, script, { mode: 0o755 });
    const child = spawn("/bin/sh", [file, ...args], {
        env: {
            PATH: `${path.join(dir, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
            MOLTENTERM_SWAP_DIRECT: "1",
            MOLTENTERM_SWAP_GRACE: "1",
            ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    // "close", not "exit": the output the script wrote just before exiting may still be in the pipes at "exit".
    const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c)));
    return { code, log };
}

async function waitFor(what: string, cond: () => boolean) {
    const deadline = Date.now() + WaitMs;
    while (!cond()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((r) => setTimeout(r, 50));
    }
}

function sleepShim(settled: string): string {
    return `#!/bin/sh
n=0
until ${settled}; do
    n=$((n + 1))
    [ "$n" -gt 1200 ] && break
    /bin/sleep 0.05
done
`;
}

// ---- the macOS bundle, through the gold swap script -------------------------------------------------------------------

const MacExe = `#!/bin/sh
echo $$ >> "$FAKE_PIDS"
[ -n "$FAKE_WRITE_MARKER" ] && echo $$ > "$FAKE_MARKER"
while :; do /bin/sleep 1; done
`;

function macBundle(app: string, version: string, sign: boolean) {
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "MacOS", "MoltenTerm"), MacExe, { mode: 0o755 });
    fs.writeFileSync(
        path.join(app, "Contents", "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>fr.diamondforge.moltenterm</string>
<key>CFBundleExecutable</key><string>MoltenTerm</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
</dict></plist>`
    );
    if (sign) {
        execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { stdio: "ignore" });
    }
}

const QuarantineValue = "0081;5f000000;Safari;";

async function macSwap(o: { tamper?: boolean; quarantine: boolean; assess?: boolean; requirement?: string }) {
    const dir = tempDir();
    const installed = path.join(dir, "MoltenTerm.app");
    macBundle(installed, "1.0.0-8", false);
    fs.writeFileSync(path.join(installed, "old"), "old");
    const staged = path.join(dir, "staged", "MoltenTerm.app");
    macBundle(staged, Version, true);
    if (o.tamper) {
        fs.appendFileSync(path.join(staged, "Contents", "MacOS", "MoltenTerm"), "# changed after signing\n");
    }
    execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", QuarantineValue, staged]);
    fs.mkdirSync(path.join(dir, "bin"));
    const swap = releaseMacSwap({
        staged,
        installed,
        version: Version,
        requirement: o.requirement ?? "integrity",
        assess: o.assess === true,
    });
    const status = path.join(dir, "swap.status");
    // The bundle is swapped without a reopen; the argument for the quarantine is the release's 0 unless the test asks.
    const args = swap.args(false, status, path.join(dir, "swap.started"));
    if (o.quarantine) {
        args[8] = "1";
    }
    const { code, log } = await runScript(SwapScript, [gonePid(), ...args], dir);
    const carried = (app: string) => {
        try {
            return execFileSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", app], { encoding: "utf8" }).trim();
        } catch {
            return null;
        }
    };
    return {
        code,
        log,
        status: fs.readFileSync(status, "utf8").trim(),
        installed,
        quarantine: () => carried(installed),
        replaced: () => !fs.existsSync(path.join(installed, "old")),
        untouched: () => fs.existsSync(path.join(installed, "old")),
    };
}

describe.runIf(OnMac)("the macOS swap of a release", () => {
    it("replaces the app with a sealed one while the running app is ad hoc, leaving the quarantine alone", async () => {
        const r = await macSwap({ quarantine: false });
        expect(r.code).toBe(0);
        expect(r.status).toBe(`installed ${Version}`);
        expect(r.replaced()).toBe(true);
        expect(r.quarantine()).toBe(QuarantineValue);
    });

    it("keeps removing the quarantine of a verified gold, whose script argument is the default", async () => {
        const r = await macSwap({ quarantine: true });
        expect(r.status).toBe(`installed ${Version}`);
        expect(r.quarantine()).toBeNull();
    });

    it("refuses a staged app that was changed after it was signed, and leaves the installed one", async () => {
        const r = await macSwap({ tamper: true, quarantine: false });
        expect(r.code).toBe(1);
        expect(r.status).toMatch(/^failed: the new build's signature did not verify/);
        expect(r.untouched()).toBe(true);
    });

    it("refuses a staged app that does not satisfy the requirement it is given", async () => {
        const r = await macSwap({ quarantine: false, requirement: 'identifier "fr.example.other"' });
        expect(r.status).toMatch(/^failed: the new build's signature did not verify/);
        expect(r.untouched()).toBe(true);
    });

    const gatekeeperOn = (() => {
        try {
            return /enabled/.test(execFileSync("/usr/sbin/spctl", ["--status"], { encoding: "utf8" }));
        } catch {
            return false;
        }
    })();
    it.runIf(gatekeeperOn)(
        "refuses an app the system does not accept when the system's assessment is asked",
        async () => {
            const r = await macSwap({ quarantine: false, assess: true });
            expect(r.status).toMatch(/^failed: the new build's signature did not verify/);
            expect(r.untouched()).toBe(true);
        }
    );
});

// ---- the Linux AppImage, through its own script ----------------------------------------------------------------------

const FakeImage = `#!/bin/sh
echo $$ >> "$FAKE_PIDS"
[ -n "$FAKE_WRITE_MARKER" ] && echo $$ > "$FAKE_MARKER"
[ -n "$FAKE_QUIT" ] && exit 0
while :; do /bin/sleep 1; done
`;

const OldImage = `#!/bin/sh
echo reopened > "$FAKE_OLD_REOPENED"
`;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type ImageScenario = {
    reopen: boolean;
    quit?: boolean;
    writeMarker?: boolean;
    tamper?: boolean;
    expected?: string;
};

async function imageSwap(s: ImageScenario) {
    const dir = tempDir();
    const installed = path.join(dir, "MoltenTerm.AppImage");
    fs.writeFileSync(installed, OldImage, { mode: 0o755 });
    const staged = path.join(dir, "staged", "new.AppImage");
    fs.mkdirSync(path.dirname(staged));
    fs.writeFileSync(staged, FakeImage, { mode: 0o644 });
    const expected = s.expected ?? sha(FakeImage);
    if (s.tamper) {
        fs.appendFileSync(staged, "# changed after the checksum\n");
    }
    const pids = path.join(dir, "pids");
    const marker = path.join(dir, "swap.started");
    const status = path.join(dir, "swap.status");
    const oldReopened = path.join(dir, "old-reopened");
    fs.mkdirSync(path.join(dir, "bin"));
    const settled = s.quit
        ? `[ -s "${pids}" ] && ! kill -0 "$(tail -n 1 "${pids}")" 2>/dev/null`
        : s.writeMarker
          ? `[ -s "${marker}" ] && kill -0 "$(cat "${marker}")" 2>/dev/null`
          : `[ -s "${pids}" ]`;
    fs.writeFileSync(path.join(dir, "bin", "sleep"), sleepShim(settled), { mode: 0o755 });
    const swap = releaseAppImageSwap({ staged, installed, version: Version, sha256: expected });
    const args = swap.args(s.reopen, status, marker);
    const { code, log } = await runScript(AppImageSwapScript, [gonePid(), ...args], dir, {
        FAKE_PIDS: pids,
        FAKE_MARKER: marker,
        FAKE_WRITE_MARKER: s.writeMarker ? "1" : "",
        FAKE_QUIT: s.quit ? "1" : "",
        FAKE_OLD_REOPENED: oldReopened,
    });
    if (fs.readFileSync(status, "utf8").startsWith("rolledback")) {
        await waitFor(
            "the previous build to reopen",
            () => fs.existsSync(oldReopened) && fs.statSync(oldReopened).size > 0
        );
    }
    return {
        code,
        log,
        dir,
        installed,
        status: fs.readFileSync(status, "utf8").trim(),
        isNew: () => fs.readFileSync(installed, "utf8").startsWith('#!/bin/sh\necho $$ >> "$FAKE_PIDS"'),
        isOld: () => fs.readFileSync(installed, "utf8") === OldImage,
        mode: () => fs.statSync(installed).mode & 0o777,
        leftovers: () => fs.readdirSync(dir).filter((n) => /previous|did-not-stay-open/.test(n)),
    };
}

describe("the AppImage header", () => {
    it("is the one of the published type 2 AppImages, and nothing else", () => {
        // The first 16 bytes of moltenterm-linux-x86_64-1.0.0-8.AppImage.
        const published = Buffer.from("7f454c46020101004149020000000000", "hex");
        expect(isAppImageHeader(published)).toBe(true);
        expect(isAppImageHeader(Buffer.from("7f454c46020101004149010000000000", "hex"))).toBe(false);
        expect(isAppImageHeader(Buffer.from("7f454c46020101000000000000000000", "hex"))).toBe(false);
        expect(isAppImageHeader(Buffer.from("#!/bin/sh\necho x\n"))).toBe(false);
        expect(isAppImageHeader(Buffer.alloc(4))).toBe(false);
    });
});

describe("the Linux AppImage swap of a release", () => {
    it("puts the new file in the old one's place when the app quits, made executable, and keeps nothing aside", async () => {
        const r = await imageSwap({ reopen: false });
        expect(r.code).toBe(0);
        expect(r.status).toBe(`installed ${Version}`);
        expect(r.isNew()).toBe(true);
        expect(r.mode()).toBe(0o755);
        expect(r.leftovers()).toEqual([]);
    });

    it("refuses a staged file whose checksum is not the signed one, and leaves the installed one", async () => {
        const r = await imageSwap({ reopen: false, tamper: true });
        expect(r.code).toBe(1);
        expect(r.status).toMatch(/^failed: the new build's checksum did not verify/);
        expect(r.isOld()).toBe(true);
    });

    it("refuses when it was given no checksum at all", async () => {
        const r = await imageSwap({ reopen: false, expected: "" });
        expect(r.status).toMatch(/^failed: the new build's checksum did not verify/);
        expect(r.isOld()).toBe(true);
    });

    it(
        "keeps a reopened build that stays open, proven by its start marker",
        async () => {
            const r = await imageSwap({ reopen: true, writeMarker: true });
            expect(r.status).toBe(`installed ${Version}`);
            expect(r.isNew()).toBe(true);
            expect(r.leftovers()).toEqual([]);
        },
        WaitMs * 2
    );

    it(
        "rolls back a build that quits within the grace and reopens the previous one",
        async () => {
            const r = await imageSwap({ reopen: true, writeMarker: true, quit: true });
            expect(r.status).toBe(`rolledback ${Version}`);
            expect(r.isOld()).toBe(true);
            expect(fs.readFileSync(path.join(r.dir, "old-reopened"), "utf8").trim()).toBe("reopened");
            expect(r.leftovers()).toEqual([]);
        },
        WaitMs * 2
    );

    it(
        "rolls back a build that never wrote its start marker",
        async () => {
            const r = await imageSwap({ reopen: true, writeMarker: false });
            expect(r.status).toBe(`rolledback ${Version}`);
            expect(r.isOld()).toBe(true);
        },
        WaitMs * 2
    );
});
