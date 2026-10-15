// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: true }, ipcMain: { handle: () => {} } }));
vi.mock("./emain-activity", () => ({ setUserConfirmedQuit: () => {} }));
vi.mock("./emain-platform", () => ({ getWaveDataDir: () => "/nonexistent" }));
vi.mock("./moltenterm-release-feed", () => ({ initMoltentermReleaseFeed: () => {} }));

import {
    checkGoldSignature,
    CodesignRunner,
    isAdhocSignature,
    isIdentityRequirement,
    ownGoldRequirement,
    parseDesignatedRequirement,
} from "./moltenterm-gold-signature";
import { goldDir, SwapScript } from "./moltenterm-update";

const GoldRequirement =
    'identifier "fr.diamondforge.moltenterm.gold" and certificate leaf = H"7d23fc16c16b613f92ed0d096c680ff4ac22daff"';
const OnMac = process.platform === "darwin" && fs.existsSync("/usr/bin/codesign");

const temps: string[] = [];
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-gold-sig-"));
    temps.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of temps.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// A minimal app bundle signed ad hoc, as a gold built without the local identity is.
function adhocBundle(dir: string): string {
    const app = path.join(dir, "Moltenterm.app");
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.copyFileSync("/usr/bin/true", path.join(app, "Contents", "MacOS", "MoltenTerm"));
    fs.writeFileSync(
        path.join(app, "Contents", "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>fr.diamondforge.moltenterm.gold</string>
<key>CFBundleExecutable</key><string>MoltenTerm</string>
<key>CFBundleVersion</key><string>2000000000</string>
</dict></plist>`
    );
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { stdio: "ignore" });
    return app;
}

function fakeRunner(answers: Record<string, { code?: number; stdout?: string; stderr?: string }>): CodesignRunner {
    return async (args) => {
        const key = args[0];
        const a = answers[key] ?? {};
        return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
    };
}

describe("gold signature (#663)", () => {
    it("reads the designated requirement and tells an identity from ad hoc", () => {
        expect(parseDesignatedRequirement(`Executable=/x\ndesignated => ${GoldRequirement}\n`)).toBe(GoldRequirement);
        expect(parseDesignatedRequirement("nothing here")).toBeNull();
        expect(isIdentityRequirement(GoldRequirement)).toBe(true);
        expect(isIdentityRequirement('anchor apple generic and identifier "x"')).toBe(true);
        expect(isIdentityRequirement('cdhash H"0123456789abcdef0123456789abcdef01234567"')).toBe(false);
        expect(isIdentityRequirement("")).toBe(false);
        expect(isAdhocSignature("Identifier=x\nSignature=adhoc\n")).toBe(true);
        expect(isAdhocSignature("CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+1")).toBe(true);
        expect(isAdhocSignature("Authority=MoltenTerm Local\nTeamIdentifier=not set")).toBe(false);
    });

    it("takes a bundle that meets the running gold's requirement, and refuses others", async () => {
        const good = fakeRunner({ "-dv": { stderr: "Authority=MoltenTerm Local" }, "--verify": { code: 0 } });
        expect(await checkGoldSignature("/x.app", GoldRequirement, good)).toBeNull();
        const other = fakeRunner({ "-dv": { stderr: "Authority=Someone Else" }, "--verify": { code: 3 } });
        expect(await checkGoldSignature("/x.app", GoldRequirement, other)).toMatch(/not signed by the identity/);
        const adhoc = fakeRunner({ "-dv": { stderr: "Signature=adhoc" }, "--verify": { code: 0 } });
        expect(await checkGoldSignature("/x.app", GoldRequirement, adhoc)).toMatch(/ad hoc/);
        const unsigned = fakeRunner({ "-dv": { code: 1, stderr: "code object is not signed at all" } });
        expect(await checkGoldSignature("/x.app", GoldRequirement, unsigned)).toMatch(/not signed/);
    });

    it("passes the running gold's own requirement to codesign", async () => {
        const calls: string[][] = [];
        const run: CodesignRunner = async (args) => {
            calls.push(args);
            return { code: 0, stdout: args[0] === "-d" ? `designated => ${GoldRequirement}\n` : "", stderr: "" };
        };
        const req = await ownGoldRequirement("/Applications/MoltenTerm Gold.app", run);
        expect(req).toBe(GoldRequirement);
        await checkGoldSignature("/candidate.app", req, run);
        expect(calls.at(-1)).toEqual(["--verify", "--deep", "--strict", "-R", "=" + GoldRequirement, "/candidate.app"]);
    });

    it("refuses every update while the running gold is signed ad hoc", async () => {
        const run = fakeRunner({
            "-d": { stdout: 'designated => cdhash H"0123456789abcdef0123456789abcdef01234567"' },
        });
        await expect(ownGoldRequirement("/Applications/MoltenTerm Gold.app", run)).rejects.toThrow(/signed ad hoc/);
    });

    it("ignores MOLTENTERM_GOLD_DIR in an installed gold", () => {
        const env = { MOLTENTERM_GOLD_DIR: "/tmp/evil" };
        expect(goldDir(true, env, "/Users/a")).toBe(
            "/Users/a/Library/Application Support/Moltenterm Local Builds/gold.noindex"
        );
        expect(goldDir(false, env, "/Users/a")).toBe("/tmp/evil");
    });

    it.runIf(OnMac)("refuses a real ad hoc bundle and a bundle signed by another identity", async () => {
        const app = adhocBundle(tempDir());
        expect(await checkGoldSignature(app, GoldRequirement)).toMatch(/ad hoc/);
        await expect(ownGoldRequirement(app)).rejects.toThrow(/signed ad hoc/);
        // Signed by Apple, not by the gold's identity.
        expect(await checkGoldSignature("/usr/bin/true", GoldRequirement)).toMatch(/not signed by the identity/);
    });

    it.runIf(OnMac)("the swap script leaves the installed app alone when the staged copy does not verify", () => {
        const dir = tempDir();
        const installed = path.join(dir, "MoltenTerm Gold.app");
        fs.mkdirSync(installed);
        fs.writeFileSync(path.join(installed, "marker"), "old");
        const staged = adhocBundle(path.join(dir));
        const status = path.join(dir, "swap.status");
        const script = path.join(dir, "swap.sh");
        fs.writeFileSync(script, SwapScript, { mode: 0o755 });
        // A pid that has already exited: the script does not wait.
        const gone = spawnSync("/usr/bin/true").pid;
        const result = spawnSync(
            "/bin/sh",
            [script, String(gone), staged, installed, installed, "0", "2000000000", status, GoldRequirement],
            { encoding: "utf8", timeout: 60000 }
        );
        expect(result.status).toBe(1);
        expect(fs.readFileSync(status, "utf8")).toMatch(/signature did not verify/);
        expect(fs.readFileSync(path.join(installed, "marker"), "utf8")).toBe("old");
        expect(fs.existsSync(staged)).toBe(false);
    });
});
