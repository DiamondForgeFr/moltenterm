// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The macOS half of the in-app update of a release (#1860): unpacks the downloaded zip into the update folder and judges
// the app inside it before anything is replaced. The zip itself was already checked against the signed checksums; this
// is the check of what it holds, by the system's own tools (ditto, PlistBuddy, codesign, spctl), which the swap script
// (moltenterm-update.ts, #64) repeats on the staged copy right before it moves it:
//   - it is MoltenTerm (bundle identifier) and the version the release announces;
//   - its code signature is sealed and unmodified (codesign --verify --deep --strict);
//   - when the running app is signed by an identity, the new app satisfies that app's designated requirement, as a gold
//     update does (checkGoldSignature): a Developer ID app is never replaced by an app of another signer, or ad hoc;
//   - when the new app is signed by an Apple-anchored identity (Developer ID), the system must accept it (spctl).
// While the running app is signed ad hoc (a build made before the Developer ID certificate) there is no identity to
// match: the integrity check stands in for the requirement, and the trust comes from the signed checksums.
// The quarantine attribute is never touched: the files the app writes have none, and the system's checks stay on.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import {
    installError,
    ReleaseInstallError,
    ReleaseProductName,
} from "../frontend/moltenterm-shell/update/release-install";
import { appBundleOf } from "../frontend/util/moltenterm-gold";
import {
    checkGoldSignature,
    CodesignRunner,
    isIdentityRequirement,
    parseDesignatedRequirement,
    runCodesign,
} from "./moltenterm-gold-signature";

const execFileAsync = promisify(execFile);

export const ReleaseBundleIdentifier = "fr.diamondforge.moltenterm";
export const ReleaseAppName = `${ReleaseProductName}.app`;
const DittoPath = "/usr/bin/ditto";
const UnzipPath = "/usr/bin/unzip";
const PlistBuddyPath = "/usr/libexec/PlistBuddy";
const SpctlPath = "/usr/sbin/spctl";
// The value the swap script takes for an app with no identity to match.
export const IntegrityRequirement = "integrity";

export type ToolResult = { code: number; stdout: string; stderr: string };
export type ToolRunner = (file: string, args: string[]) => Promise<ToolResult>;

export const runTool: ToolRunner = async (file, args) => {
    try {
        const { stdout, stderr } = await execFileAsync(file, args, { maxBuffer: 64 * 1024 * 1024 });
        return { code: 0, stdout, stderr };
    } catch (e) {
        return { code: typeof e?.code === "number" ? e.code : 1, stdout: e?.stdout ?? "", stderr: e?.stderr ?? "" };
    }
};

export type OwnSigning = { identity: boolean; requirement?: string };

// How the running app is signed: by an identity (its designated requirement names a certificate or an anchor), or ad hoc.
export async function ownSigning(installedApp: string, run: CodesignRunner = runCodesign): Promise<OwnSigning> {
    const shown = await run(["-d", "-r-", installedApp]);
    const req = parseDesignatedRequirement(shown.stdout + "\n" + shown.stderr);
    if (shown.code !== 0 || req == null) {
        throw new Error("this MoltenTerm's own signature cannot be read, so no update can be checked against it");
    }
    return isIdentityRequirement(req) ? { identity: true, requirement: req } : { identity: false };
}

export function installedBundleOf(execPath: string): string {
    return appBundleOf(execPath);
}

// The entries of the zip, which must all be inside MoltenTerm.app: nothing is written outside the folder it unpacks to.
export function zipEntriesAreSafe(entries: string[]): boolean {
    if (entries.length === 0) {
        return false;
    }
    return entries.every((entry) => {
        const parts = entry.split("/");
        return parts[0] === ReleaseAppName && !entry.startsWith("/") && !parts.includes("..");
    });
}

export type UnpackResult = { app: string } | { error: ReleaseInstallError };

export async function unpackReleaseZip(zip: string, dir: string, run: ToolRunner = runTool): Promise<UnpackResult> {
    const listed = await run(UnzipPath, ["-Z1", zip]);
    if (listed.code !== 0) {
        return { error: installError("unpack", "the file is not a zip") };
    }
    const entries = listed.stdout.split("\n").filter((line) => line !== "");
    if (!zipEntriesAreSafe(entries)) {
        return { error: installError("unpack", `the zip does not hold only ${ReleaseAppName}`) };
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.mkdir(dir, { recursive: true });
    const unpacked = await run(DittoPath, ["-x", "-k", zip, dir]);
    if (unpacked.code !== 0) {
        return { error: installError("unpack", "the zip could not be unpacked") };
    }
    const found = await fs.promises.readdir(dir);
    if (found.length !== 1 || found[0] !== ReleaseAppName) {
        return { error: installError("unpack", `the zip does not hold only ${ReleaseAppName}`) };
    }
    return { app: path.join(dir, ReleaseAppName) };
}

async function plistValue(app: string, key: string, run: ToolRunner): Promise<string> {
    const shown = await run(PlistBuddyPath, ["-c", `Print :${key}`, path.join(app, "Contents", "Info.plist")]);
    if (shown.code !== 0) {
        throw new Error(`the app's ${key} cannot be read`);
    }
    return shown.stdout.trim();
}

export type BundleCheck =
    | { ok: true; requirement: string; assess: boolean }
    | { ok: false; error: ReleaseInstallError };

// Judges the unpacked app. requirement and assess are what the swap script is given to repeat the check.
export async function checkReleaseBundle(
    app: string,
    version: string,
    own: OwnSigning,
    runTools: ToolRunner = runTool,
    runSign: CodesignRunner = runCodesign
): Promise<BundleCheck> {
    try {
        if ((await plistValue(app, "CFBundleIdentifier", runTools)) !== ReleaseBundleIdentifier) {
            return { ok: false, error: installError("notapp", "the app is not MoltenTerm") };
        }
        if ((await plistValue(app, "CFBundleShortVersionString", runTools)) !== version) {
            return { ok: false, error: installError("notapp", "the app's version is not the release's") };
        }
    } catch (e) {
        return { ok: false, error: installError("notapp", e?.message ?? String(e)) };
    }
    const details = await runSign(["-dv", "--verbose=2", app]);
    if (details.code !== 0) {
        return { ok: false, error: installError("codesign", "the app is not signed") };
    }
    if (own.identity) {
        const problem = await checkGoldSignature(app, own.requirement, runSign);
        if (problem != null) {
            return { ok: false, error: installError("codesign", problem) };
        }
    } else {
        const sealed = await runSign(["--verify", "--deep", "--strict", app]);
        if (sealed.code !== 0) {
            return {
                ok: false,
                error: installError("codesign", "the app's signature is broken or the app was changed"),
            };
        }
    }
    const shown = await runSign(["-d", "-r-", app]);
    const appleAnchored = /\banchor apple generic\b/.test(shown.stdout + "\n" + shown.stderr);
    if (appleAnchored) {
        const assessed = await runTools(SpctlPath, ["--assess", "--type", "execute", app]);
        if (assessed.code !== 0) {
            return { ok: false, error: installError("codesign", "the system does not accept the app") };
        }
    }
    return { ok: true, requirement: own.identity ? own.requirement : IntegrityRequirement, assess: appleAnchored };
}
