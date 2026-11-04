// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The in-app update of a release install (#1860, FR-REL-005, Notulia's flow): the user accepts an offered release, the
// app downloads the file for this computer, verifies it against the signed checksums, and installs it. The rules that
// do not need Electron or the disk live here, shared by emain (the installer) and the renderer (Settings › About and
// the notifications): what is downloaded from where, where the app can replace itself, how the checksum list reads,
// the state the installer reports and what its failures are called. Kept free of both so that they are tested alone.

import { MoltentermProductName, MoltentermRepoUrl } from "../../util/moltenterm-identity";
import { compareVersions, Version } from "../releases/versions";

// must match the channels in emain/preload.ts
export const MoltentermReleaseInstallStateChannel = "moltenterm-release-install-state";
export const MoltentermReleaseInstallStartChannel = "moltenterm-release-install-start";
export const MoltentermReleaseInstallApplyChannel = "moltenterm-release-install-apply";
export const MoltentermReleaseInstallRevealChannel = "moltenterm-release-install-reveal";
export const MoltentermReleaseInstallLastChannel = "moltenterm-release-install-last";
// Pushed by emain to every window at each change of the state.
export const MoltentermReleaseInstallEventChannel = "moltenterm-release-install-event";

export const ChecksumsName = "SHA256SUMS.txt";
export const ChecksumsSignatureName = "SHA256SUMS.txt.asc";
// What the release workflow names its files (electron-builder.config.cjs artifactName, scripts/release-inventory.mjs):
// the macOS ones after the product, the Linux ones after the package.
export const ReleaseProductName = MoltentermProductName;
export const ReleasePackageName = "moltenterm";
// A checksum list or a signature is small; a bigger one is not what the release workflow wrote.
export const MaxChecksumsBytes = 256 * 1024;
export const MaxSignatureBytes = 16 * 1024;
// The biggest file the app downloads: the release files are about a quarter of this.
export const MaxArtifactBytes = 1024 * 1024 * 1024;

const TagRegex = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[1-9]\d*)?$/;
const FileNameRegex = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ChecksumLineRegex = /^([0-9a-f]{64}) [ *]([^\s/\\]+)$/;

export type ReleaseFileKind = "zip" | "dmg" | "AppImage" | "deb";

// swap: the app replaces itself (after it quits, with a rollback). download: the file is fetched and verified, then
// shown in its folder. none: nothing is done in the app; the release page has the files.
export type ReleaseInstallMode = "swap" | "download" | "none";

export type ReleaseInstallReason = "package" | "readonly" | "translocated" | "platform" | "dev";

export type ReleaseInstallPlan = {
    mode: ReleaseInstallMode;
    reason?: ReleaseInstallReason;
    kind?: ReleaseFileKind;
};

export type InstallFacts = {
    platform: string;
    arch: string;
    packaged: boolean;
    // The .app bundle of the running executable, on macOS.
    bundle?: string;
    // The AppImage file that runs, on Linux ($APPIMAGE).
    appImage?: string;
    // The place the app would replace can be written by the user, without elevated rights.
    writable?: boolean;
    // dpkg is on this Linux system: a .deb is the package to offer to one that is not an AppImage.
    dpkg?: boolean;
};

// The file of a release for this computer, or null for a platform or architecture no build is published for.
export function releaseFileName(kind: ReleaseFileKind, platform: string, arch: string, version: string): string {
    if (!/^\d+\.\d+\.\d+(?:-\d+)?$/.test(version ?? "")) {
        return null;
    }
    if (platform === "darwin" && (kind === "zip" || kind === "dmg") && (arch === "arm64" || arch === "x64")) {
        return `${ReleaseProductName}-darwin-${arch}-${version}.${kind}`;
    }
    if (platform === "linux" && kind === "AppImage" && (arch === "arm64" || arch === "x64")) {
        return `${ReleasePackageName}-linux-${arch === "x64" ? "x86_64" : arch}-${version}.AppImage`;
    }
    if (platform === "linux" && kind === "deb" && (arch === "arm64" || arch === "x64")) {
        return `${ReleasePackageName}-linux-${arch === "x64" ? "amd64" : arch}-${version}.deb`;
    }
    return null;
}

// What the app can do for this install. A macOS app moves its bundle and a Linux AppImage its file; neither works from
// a read-only place, from a translocated copy (Gatekeeper's randomized read-only path), or for a package a system
// manager owns, where replacing the files would need rights the app does not ask for (FR-REL-005).
export function installPlanOf(facts: InstallFacts): ReleaseInstallPlan {
    if (!facts.packaged) {
        return { mode: "none", reason: "dev" };
    }
    if (facts.platform === "darwin") {
        if (facts.arch !== "arm64" && facts.arch !== "x64") {
            return { mode: "none", reason: "platform" };
        }
        if (facts.bundle == null) {
            return { mode: "download", reason: "readonly", kind: "dmg" };
        }
        if (facts.bundle.includes("/AppTranslocation/")) {
            return { mode: "download", reason: "translocated", kind: "dmg" };
        }
        return facts.writable ? { mode: "swap", kind: "zip" } : { mode: "download", reason: "readonly", kind: "dmg" };
    }
    if (facts.platform === "linux") {
        if (facts.arch !== "arm64" && facts.arch !== "x64") {
            return { mode: "none", reason: "platform" };
        }
        if (facts.appImage) {
            return facts.writable
                ? { mode: "swap", kind: "AppImage" }
                : { mode: "download", reason: "readonly", kind: "AppImage" };
        }
        return { mode: "download", reason: "package", kind: facts.dpkg ? "deb" : "AppImage" };
    }
    return { mode: "none", reason: "platform" };
}

// A test instance may serve the release files on this machine (MOLTENTERM_RELEASE_DOWNLOAD_URL, http://127.0.0.1 only,
// with MOLTENTERM_BACKGROUND=1, as the feed override of #1806); any other value is ignored.
export function releaseDownloadOverride(env: Record<string, string | undefined>): string {
    const override = env?.MOLTENTERM_RELEASE_DOWNLOAD_URL;
    if (!override || env?.MOLTENTERM_BACKGROUND !== "1") {
        return null;
    }
    try {
        const url = new URL(override);
        if (url.protocol === "http:" && url.hostname === "127.0.0.1") {
            return url.toString().replace(/\/$/, "");
        }
    } catch {
        // unreadable: no override
    }
    return null;
}

// The address of one file of a release, built from the release's tag and the file's name and from nothing the feed
// carries: the feed cannot point the download anywhere else than this repository's releases.
export function releaseFileUrl(tag: string, name: string, env: Record<string, string | undefined> = {}): string {
    if (!TagRegex.test(tag ?? "") || !FileNameRegex.test(name ?? "")) {
        return null;
    }
    const override = releaseDownloadOverride(env);
    if (override != null) {
        return `${override}/${tag}/${name}`;
    }
    return `${MoltentermRepoUrl}/releases/download/${tag}/${name}`;
}

// The SHA-256 of each file of SHA256SUMS.txt (the sha256sum format release.yml writes), or null when a line is not one
// of those or a name appears twice: a list that is not exactly what the workflow writes is not trusted.
export function parseChecksums(text: string): Map<string, string> {
    const rtn = new Map<string, string>();
    for (const line of (text ?? "").replace(/\r\n/g, "\n").split("\n")) {
        if (line === "") {
            continue;
        }
        const m = ChecksumLineRegex.exec(line);
        if (m == null || rtn.has(m[2])) {
            return null;
        }
        rtn.set(m[2], m[1]);
    }
    return rtn.size === 0 ? null : rtn;
}

export type ReleaseInstallPhase = "idle" | "downloading" | "verifying" | "ready" | "error";

// Each is a sentence in Settings › About (update.install.error.<kind>); detail is the technical word for whoever reports it.
export type ReleaseInstallErrorKind =
    | "network"
    | "missing"
    | "unsigned"
    | "signature"
    | "checksum"
    | "toolarge"
    | "unpack"
    | "notapp"
    | "codesign"
    | "disk"
    | "stale"
    | "busy"
    | "unsupported"
    | "swap";

export type ReleaseInstallError = { kind: ReleaseInstallErrorKind; detail?: string };

export type ReleaseInstallState = {
    phase: ReleaseInstallPhase;
    tag?: string;
    version?: string;
    mode?: ReleaseInstallMode;
    // 0 to 100 while the file downloads; absent when its size is not known.
    percent?: number;
    // download mode: the verified file.
    file?: string;
    // swap mode: the update is staged and installs when MoltenTerm quits.
    armed?: boolean;
    error?: ReleaseInstallError;
};

export const IdleInstallState: ReleaseInstallState = { phase: "idle" };

export type ReleaseInstallResult = { ok: boolean; error?: ReleaseInstallError };

export type ReleaseApplyWhen = "now" | "quit";

// The outcome of the last swap, read once at the next launch.
export type ReleaseSwapStatus = {
    state: "installed" | "rolledback" | "failed";
    version?: string;
    detail?: string;
    unchecked?: boolean;
};

export function parseReleaseSwapStatus(text: string): ReleaseSwapStatus {
    const line = (text ?? "").trim();
    const done = /^(installed|rolledback) (\S+?)( unchecked)?$/.exec(line);
    if (done) {
        return {
            state: done[1] as "installed" | "rolledback",
            version: done[2],
            unchecked: done[1] === "installed" && done[3] != null,
        };
    }
    if (line.startsWith("failed")) {
        return { state: "failed", detail: line.replace(/^failed:?\s*/, "") };
    }
    return null;
}

const OwnVersionRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([1-9]\d*))?$/;

function versionOfText(text: string): Version {
    const m = OwnVersionRegex.exec(text ?? "");
    return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), rc: Number(m[4] ?? 0) } : null;
}

// Whether the version running is a later one than the last that ran: an update was installed since (never on a first
// run, which has no last version). The swap writes its outcome only after the new build has stayed open, so the new
// build announces itself from this comparison, as the gold does from its build id.
export function upgradedFrom(lastRun: string, running: string): boolean {
    const last = versionOfText(lastRun);
    const own = versionOfText(running);
    return last != null && own != null && compareVersions(own, last) > 0;
}

export function installError(kind: ReleaseInstallErrorKind, detail?: string): ReleaseInstallError {
    return detail ? { kind, detail } : { kind };
}

// Whether a state is one of the installer's own work, which another check must not disturb (Notulia's holdsTheRow): a
// download in flight, and a staged update waiting for its restart.
export function holdsTheOffer(state: ReleaseInstallState): boolean {
    return state?.phase === "downloading" || state?.phase === "verifying" || state?.phase === "ready";
}

export function isReleaseInstallState(value: unknown): value is ReleaseInstallState {
    const phase = (value as ReleaseInstallState)?.phase;
    return (
        phase === "idle" || phase === "downloading" || phase === "verifying" || phase === "ready" || phase === "error"
    );
}
