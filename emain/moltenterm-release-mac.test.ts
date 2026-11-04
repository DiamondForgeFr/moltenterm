// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the in-app update of a release does with the zip of a macOS app (#1860): unpacking only a MoltenTerm.app, and
// judging the app before anything is replaced. The system's tools run for real on fake apps made here (signed ad hoc);
// the identity cases (a Developer ID app, the running app's designated requirement, the system's assessment) answer from
// a stand-in for codesign and spctl, since no test can sign with the real certificate.

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { CodesignRunner } from "./moltenterm-gold-signature";
import {
    checkReleaseBundle,
    IntegrityRequirement,
    ownSigning,
    ReleaseAppName,
    ToolRunner,
    unpackReleaseZip,
    zipEntriesAreSafe,
} from "./moltenterm-release-mac";

const OnMac = process.platform === "darwin" && fs.existsSync("/usr/bin/codesign") && fs.existsSync("/usr/bin/ditto");
const Version = "1.0.0-9";
const Identifier = "fr.diamondforge.moltenterm";

const temps: string[] = [];
afterEach(() => {
    for (const dir of temps.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-release-mac-"));
    temps.push(dir);
    return dir;
}

function bundle(app: string, o: { id?: string; version?: string; sign?: boolean } = {}) {
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "MacOS", "MoltenTerm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(
        path.join(app, "Contents", "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${o.id ?? Identifier}</string>
<key>CFBundleExecutable</key><string>MoltenTerm</string>
<key>CFBundleShortVersionString</key><string>${o.version ?? Version}</string>
<key>CFBundleVersion</key><string>${o.version ?? Version}</string>
</dict></plist>`
    );
    if (o.sign !== false) {
        execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { stdio: "ignore" });
    }
}

function zipOf(dir: string, app: string): string {
    const zip = path.join(dir, "release.zip");
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
    return zip;
}

describe("zipEntriesAreSafe", () => {
    it("accepts only entries inside MoltenTerm.app", () => {
        expect(zipEntriesAreSafe(["MoltenTerm.app/", "MoltenTerm.app/Contents/Info.plist"])).toBe(true);
        expect(zipEntriesAreSafe([])).toBe(false);
        expect(zipEntriesAreSafe(["MoltenTerm.app/", "Other.app/Contents"])).toBe(false);
        expect(zipEntriesAreSafe(["MoltenTerm.app/../../etc/passwd"])).toBe(false);
        expect(zipEntriesAreSafe(["/MoltenTerm.app/x"])).toBe(false);
        expect(zipEntriesAreSafe(["MoltenTerm.app.evil/x"])).toBe(false);
        expect(zipEntriesAreSafe(["__MACOSX/._MoltenTerm.app"])).toBe(false);
    });
});

describe.runIf(OnMac)("unpacking the zip of a release", () => {
    it("unpacks a zip that holds MoltenTerm.app only", async () => {
        const dir = tempDir();
        const app = path.join(dir, "src", ReleaseAppName);
        bundle(app);
        const result = await unpackReleaseZip(zipOf(dir, app), path.join(dir, "out"));
        expect(result).toEqual({ app: path.join(dir, "out", ReleaseAppName) });
        expect(fs.existsSync(path.join(dir, "out", ReleaseAppName, "Contents", "Info.plist"))).toBe(true);
    });

    it("refuses a zip of another app, a file that is not a zip, and a zip with something beside the app", async () => {
        const dir = tempDir();
        const other = path.join(dir, "src", "Other.app");
        bundle(other);
        expect(await unpackReleaseZip(zipOf(dir, other), path.join(dir, "out1"))).toMatchObject({
            error: { kind: "unpack" },
        });
        const junk = path.join(dir, "junk.zip");
        fs.writeFileSync(junk, "not a zip");
        expect(await unpackReleaseZip(junk, path.join(dir, "out2"))).toMatchObject({ error: { kind: "unpack" } });
        const both = path.join(dir, "both");
        fs.mkdirSync(both);
        bundle(path.join(both, ReleaseAppName));
        fs.writeFileSync(path.join(both, "extra.txt"), "extra");
        const zip = path.join(dir, "both.zip");
        execFileSync("/usr/bin/ditto", ["-c", "-k", both, zip]);
        expect(await unpackReleaseZip(zip, path.join(dir, "out3"))).toMatchObject({ error: { kind: "unpack" } });
    });
});

describe.runIf(OnMac)("judging an unpacked app, signed ad hoc, while the running app is ad hoc too", () => {
    const own = { identity: false };

    it("accepts a sealed MoltenTerm of the offered version, with the integrity check for the swap", async () => {
        const app = path.join(tempDir(), ReleaseAppName);
        bundle(app);
        expect(await checkReleaseBundle(app, Version, own)).toEqual({
            ok: true,
            requirement: IntegrityRequirement,
            assess: false,
        });
    });

    it("refuses another app, another version, an unsigned app and one changed after it was signed", async () => {
        const dir = tempDir();
        const wrongId = path.join(dir, "a", ReleaseAppName);
        bundle(wrongId, { id: "fr.example.other" });
        expect(await checkReleaseBundle(wrongId, Version, own)).toMatchObject({ ok: false, error: { kind: "notapp" } });
        const wrongVersion = path.join(dir, "b", ReleaseAppName);
        bundle(wrongVersion, { version: "1.0.0-3" });
        expect(await checkReleaseBundle(wrongVersion, Version, own)).toMatchObject({
            ok: false,
            error: { kind: "notapp" },
        });
        const unsigned = path.join(dir, "c", ReleaseAppName);
        bundle(unsigned, { sign: false });
        expect(await checkReleaseBundle(unsigned, Version, own)).toMatchObject({
            ok: false,
            error: { kind: "codesign" },
        });
        const changed = path.join(dir, "d", ReleaseAppName);
        bundle(changed);
        fs.appendFileSync(path.join(changed, "Contents", "MacOS", "MoltenTerm"), "# changed\n");
        const verdict = await checkReleaseBundle(changed, Version, own);
        expect(verdict).toMatchObject({ ok: false, error: { kind: "codesign" } });
    });

    it("refuses an ad hoc app in place of one signed by an identity, which no ad hoc app can satisfy", async () => {
        const app = path.join(tempDir(), ReleaseAppName);
        bundle(app);
        const verdict = await checkReleaseBundle(app, Version, {
            identity: true,
            requirement: `identifier "${Identifier}" and anchor apple generic and certificate leaf[subject.OU] = "TEAMID"`,
        });
        expect(verdict).toMatchObject({ ok: false, error: { kind: "codesign" } });
    });

    it("reads how the running app is signed: ad hoc here, an identity from its requirement", async () => {
        const app = path.join(tempDir(), ReleaseAppName);
        bundle(app);
        expect(await ownSigning(app)).toEqual({ identity: false });
        const identity: CodesignRunner = async () => ({
            code: 0,
            stdout: "",
            stderr: `designated => identifier "${Identifier}" and anchor apple generic and certificate leaf[subject.OU] = "TEAMID"`,
        });
        expect(await ownSigning(app, identity)).toEqual({
            identity: true,
            requirement: `identifier "${Identifier}" and anchor apple generic and certificate leaf[subject.OU] = "TEAMID"`,
        });
        const unreadable: CodesignRunner = async () => ({ code: 1, stdout: "", stderr: "not signed" });
        await expect(ownSigning(app, unreadable)).rejects.toThrow(/cannot be read/);
    });
});

describe.runIf(OnMac)("judging an app signed by a Developer ID, answered by stand-ins for the system's tools", () => {
    const requirement = `identifier "${Identifier}" and anchor apple generic and certificate leaf[subject.OU] = "TEAMID"`;
    const own = { identity: true, requirement };

    // codesign: the app is signed, satisfies the requirement and names an Apple anchor; spctl: as asked.
    const signer =
        (o: { satisfies: boolean }): CodesignRunner =>
        async (args) => {
            if (args[0] === "-d" && args.includes("-r-")) {
                return { code: 0, stdout: "", stderr: `designated => ${requirement}` };
            }
            if (args.includes("-R")) {
                return { code: o.satisfies ? 0 : 3, stdout: "", stderr: "" };
            }
            return { code: 0, stdout: "Authority=Developer ID Application: DIAMONDFORGE (TEAMID)", stderr: "" };
        };
    const tools = (assess: number): ToolRunner => {
        return async (file, args) => {
            if (file.endsWith("spctl")) {
                return { code: assess, stdout: "", stderr: "" };
            }
            const real = await import("./moltenterm-release-mac");
            return real.runTool(file, args);
        };
    };

    it("asks the system to accept it, and hands the swap the running app's requirement", async () => {
        const app = path.join(tempDir(), ReleaseAppName);
        bundle(app);
        expect(await checkReleaseBundle(app, Version, own, tools(0), signer({ satisfies: true }))).toEqual({
            ok: true,
            requirement,
            assess: true,
        });
    });

    it("refuses an app the system does not accept, and one that does not satisfy the requirement", async () => {
        const app = path.join(tempDir(), ReleaseAppName);
        bundle(app);
        expect(await checkReleaseBundle(app, Version, own, tools(3), signer({ satisfies: true }))).toMatchObject({
            ok: false,
            error: { kind: "codesign", detail: expect.stringMatching(/system does not accept/) },
        });
        expect(await checkReleaseBundle(app, Version, own, tools(0), signer({ satisfies: false }))).toMatchObject({
            ok: false,
            error: { kind: "codesign" },
        });
    });
});
