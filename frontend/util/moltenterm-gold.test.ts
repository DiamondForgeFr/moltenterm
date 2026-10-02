// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { appBundleOf, checkGoldManifest, GoldAppName, GoldIdentifier, parseSwapStatus } from "./moltenterm-gold";

const manifest = {
    schema: 1,
    identifier: GoldIdentifier,
    productName: "Moltenterm",
    version: "0.14.5",
    buildId: 200,
    builtAt: "2026-10-02T10:00:00Z",
    commit: "abc",
    app: GoldAppName,
    notes: [{ sha: "abc", subject: "fix(#68): x" }],
};

describe("checkGoldManifest", () => {
    it("offers a newer build", () => {
        expect(checkGoldManifest(manifest, 100)).toMatchObject({ available: true, manifest: { buildId: 200 } });
    });

    it("never offers the running build or an older one", () => {
        expect(checkGoldManifest(manifest, 200)).toMatchObject({
            available: false,
            reason: "not newer than the running build",
        });
        expect(checkGoldManifest(manifest, 300).available).toBe(false);
    });

    it("refuses a manifest that is not a Moltenterm gold", () => {
        expect(checkGoldManifest({ ...manifest, schema: 2 }, 0).reason).toContain("schema");
        expect(checkGoldManifest({ ...manifest, identifier: "com.other" }, 0).reason).toContain("com.other");
        expect(checkGoldManifest({ ...manifest, app: "../evil.app" }, 0).reason).toContain(GoldAppName);
        expect(checkGoldManifest({ ...manifest, buildId: "200" }, 0).reason).toContain("build id");
        expect(checkGoldManifest(null, 0).available).toBe(false);
        expect(checkGoldManifest({ ...manifest, notes: "x" }, 0).manifest.notes).toEqual([]);
    });
});

describe("swap status and bundle path", () => {
    it("reads the swap's outcome", () => {
        expect(parseSwapStatus("installed 200\n")).toEqual({ state: "installed", buildId: 200 });
        expect(parseSwapStatus("rolledback 200")).toEqual({ state: "rolledback", buildId: 200 });
        expect(parseSwapStatus("failed: Moltenterm did not quit")).toEqual({
            state: "failed",
            detail: "Moltenterm did not quit",
        });
        expect(parseSwapStatus("")).toBeNull();
    });

    it("finds the running app bundle", () => {
        expect(appBundleOf("/Applications/Moltenterm.app/Contents/MacOS/Moltenterm")).toBe(
            "/Applications/Moltenterm.app"
        );
        expect(appBundleOf("/usr/local/bin/electron")).toBeNull();
    });
});
