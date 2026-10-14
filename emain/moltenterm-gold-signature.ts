// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The gold update's signature check (#663). The gold folder is writable by any process of the user, so a bundle there
// is taken only when it is signed by the same identity as the running gold: it must satisfy the running app's
// designated requirement (for a gold signed "MoltenTerm Local", #224: identifier "fr.diamondforge.moltenterm.gold" and
// certificate leaf = H"…"), with every nested helper sealed (--deep --strict). An ad hoc signature names no identity
// (its requirement is the bundle's own cdhash), so it is refused, and a running gold signed ad hoc refuses every
// update: install one gold signed with the local identity by hand (UPSTREAM.md, "Local builds and their signature").

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const CodesignPath = "/usr/bin/codesign";

export type CodesignResult = { code: number; stdout: string; stderr: string };
export type CodesignRunner = (args: string[]) => Promise<CodesignResult>;

export const runCodesign: CodesignRunner = async (args) => {
    try {
        const { stdout, stderr } = await execFileAsync(CodesignPath, args, { maxBuffer: 1024 * 1024 });
        return { code: 0, stdout, stderr };
    } catch (e) {
        return { code: typeof e?.code === "number" ? e.code : 1, stdout: e?.stdout ?? "", stderr: e?.stderr ?? "" };
    }
};

// The requirement text of `codesign -d -r- <app>`: "designated => <requirement>".
export function parseDesignatedRequirement(output: string): string {
    for (const line of (output ?? "").split("\n")) {
        const at = line.indexOf("designated => ");
        if (at >= 0) {
            const req = line.slice(at + "designated => ".length).trim();
            return req === "" ? null : req;
        }
    }
    return null;
}

// An ad hoc signature's designated requirement only names the bundle's hash; a signing identity adds a certificate
// or an anchor.
export function isIdentityRequirement(req: string): boolean {
    if (req == null || req.trim() === "") {
        return false;
    }
    return /\b(certificate|anchor)\b/.test(req);
}

export function isAdhocSignature(details: string): boolean {
    return /^Signature=adhoc$/m.test(details ?? "") || /flags=0x[0-9a-f]*\(([^)]*,)?adhoc/.test(details ?? "");
}

// The requirement a candidate must meet: the running app's own, when it is signed with an identity.
export async function ownGoldRequirement(installedApp: string, run: CodesignRunner = runCodesign): Promise<string> {
    const shown = await run(["-d", "-r-", installedApp]);
    const req = parseDesignatedRequirement(shown.stdout + "\n" + shown.stderr);
    if (shown.code !== 0 || req == null) {
        throw new Error("this MoltenTerm's own signature cannot be read, so no update can be checked against it");
    }
    if (!isIdentityRequirement(req)) {
        throw new Error(
            "this MoltenTerm is signed ad hoc, so no update can be checked against it: install a gold signed with the local identity once by hand"
        );
    }
    return req;
}

// Null when app is signed by the identity requirement names, else why it is refused.
export async function checkGoldSignature(
    app: string,
    requirement: string,
    run: CodesignRunner = runCodesign
): Promise<string> {
    const details = await run(["-dv", "--verbose=2", app]);
    if (details.code !== 0) {
        return "the app is not signed";
    }
    if (isAdhocSignature(details.stdout + "\n" + details.stderr)) {
        return "the app is signed ad hoc, not by the identity of this MoltenTerm";
    }
    const verified = await run(["--verify", "--deep", "--strict", "-R", "=" + requirement, app]);
    if (verified.code !== 0) {
        return "the app is not signed by the identity of this MoltenTerm, or was changed after signing";
    }
    return null;
}
