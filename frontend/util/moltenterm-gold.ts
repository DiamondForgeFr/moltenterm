// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The gold update (#64), shared by emain/moltenterm-update.ts and the renderer: the manifest the gold delivery writes
// (scripts/moltenterm-gold-deliver.mjs) and the rules that decide whether it is an update for the running app.

// must match scripts/moltenterm-gold-deliver.mjs
export const GoldManifestSchema = 1;
// The name inside the gold folder, kept from the first golds so they keep recognising their updates.
export const GoldAppName = "Moltenterm.app";
export const GoldIdentifier = "fr.diamondforge.moltenterm";
export const GoldMaxManifestBytes = 1 << 20;

// must match the channels in emain/preload.ts
export const MoltentermUpdateCheckChannel = "moltenterm-update-check";
export const MoltentermUpdateApplyChannel = "moltenterm-update-apply";
export const MoltentermUpdateLastChannel = "moltenterm-update-last";

export type GoldNote = { sha: string; subject: string };

export type GoldManifest = {
    schema: number;
    identifier: string;
    productName: string;
    version: string;
    buildId: number;
    builtAt: string;
    commit: string;
    app: string;
    notes: GoldNote[];
};

export type GoldCheck = {
    available: boolean;
    manifest?: GoldManifest;
    // Why a manifest found is not offered (an older build, a broken file…); empty when there is none.
    reason?: string;
};

export type GoldApplyWhen = "now" | "quit";

export type GoldApplyResult = { ok: boolean; error?: string };

// The outcome of the last swap, read once at the next launch.
export type GoldSwapStatus = { state: "installed" | "rolledback" | "failed"; buildId?: number; detail?: string };

export function checkGoldManifest(manifest: any, ownBuildId: number): GoldCheck {
    if (manifest == null || typeof manifest !== "object") {
        return { available: false, reason: "unreadable manifest" };
    }
    if (manifest.schema !== GoldManifestSchema) {
        return { available: false, reason: `manifest schema ${manifest.schema} is not ${GoldManifestSchema}` };
    }
    if (manifest.identifier !== GoldIdentifier) {
        return { available: false, reason: `the build is ${manifest.identifier}, not ${GoldIdentifier}` };
    }
    if (manifest.app !== GoldAppName) {
        return { available: false, reason: `the app must be ${GoldAppName}` };
    }
    if (!Number.isInteger(manifest.buildId) || manifest.buildId <= 0) {
        return { available: false, reason: "the manifest has no build id" };
    }
    const checked: GoldManifest = { ...manifest, notes: Array.isArray(manifest.notes) ? manifest.notes : [] };
    if (!(manifest.buildId > ownBuildId)) {
        return { available: false, manifest: checked, reason: "not newer than the running build" };
    }
    return { available: true, manifest: checked };
}

export function parseSwapStatus(text: string): GoldSwapStatus {
    const line = (text ?? "").trim();
    const installed = /^installed (\d+)$/.exec(line);
    if (installed) {
        return { state: "installed", buildId: Number(installed[1]) };
    }
    const rolled = /^rolledback (\d+)$/.exec(line);
    if (rolled) {
        return { state: "rolledback", buildId: Number(rolled[1]) };
    }
    if (line.startsWith("failed")) {
        return { state: "failed", detail: line.replace(/^failed:?\s*/, "") };
    }
    return null;
}

// The .app bundle of a macOS executable path (…/Moltenterm.app/Contents/MacOS/Moltenterm), or null.
export function appBundleOf(execPath: string): string {
    const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath ?? "");
    return match ? match[1] : null;
}
