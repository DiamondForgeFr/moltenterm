// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildCardTitle, ciLine, lastBuildLine } from "./builds-model";

describe("Build local menu (FR-MC-012)", () => {
    const now = Date.parse("2026-10-03T12:00:00Z");

    it("says when the last build was made, or that there is none", () => {
        expect(lastBuildLine({ commit: "9c425c4abcdef", builtAt: "2026-10-03T11:54:00Z" }, now)).toBe(
            "Last: 6 minutes ago · 9c425c4"
        );
        expect(lastBuildLine({ commit: "9c425c4abcdef", builtAt: "2026-10-01T12:00:00Z" }, now)).toBe(
            "Last: 2 days ago · 9c425c4"
        );
        expect(lastBuildLine(null, now)).toBe("Never built");
    });

    it("says where the CI stands on the trunk", () => {
        expect(ciLine({ trunk: "develop", builds: [], ci: { status: "success", sha: "a" } })).toBe(
            "CI green on develop."
        );
        expect(
            ciLine({ trunk: "develop", builds: [], ci: { status: "failure", failed: ["check", "e2e"], sha: "a" } })
        ).toBe("CI red on develop (check, e2e): it runs again first, and the build stops if it fails.");
        expect(ciLine({ trunk: "develop", builds: [] })).toBe("The local CI will run first on develop.");
    });

    it("names a card after the project and the build", () => {
        expect(buildCardTitle("MoltenTerm", { id: "gold", title: "Gold" })).toBe("MoltenTerm Gold");
        expect(buildCardTitle("Notulia", { id: "gold", title: "Notulia Gold" })).toBe("Notulia Gold");
        expect(buildCardTitle("P", { id: "rc" })).toBe("P rc");
    });
});
