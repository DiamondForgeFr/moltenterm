// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Guards the one Wave patch of the first run across Wave merges: Wave's onboarding dialogs must stay unmounted.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve(__dirname, "../app/modals/modalsrenderer.tsx"), "utf8");

describe("modalsrenderer.tsx", () => {
    it("mounts MoltenTerm's startup hook", () => {
        expect(source).toContain("useMoltentermStartup()");
        expect(source).toContain("MOLTENTERM-PATCH (#161)");
    });

    it("no longer opens Wave's new-install or upgrade onboarding", () => {
        expect(source).not.toMatch(/@\/app\/onboarding\//);
        expect(source).not.toContain("onboarding:lastversion");
        expect(source).not.toContain("tosagreed");
        expect(source).not.toContain("newInstallOnboardingOpen");
        expect(source).not.toContain("upgradeOnboardingOpen");
    });
});
