// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { groupNotes, restartWarning, shouldOffer, summarizeTerminals, updateLabel } from "./update-model";

const manifest = { buildId: 200, commit: "07e51a72fed3" } as any;

describe("update model", () => {
    it("groups the changes by kind", () => {
        const groups = groupNotes([
            { sha: "a", subject: "feat(#64): updates" },
            { sha: "b", subject: "fix(#68): glitch" },
            { sha: "c", subject: "chore: x" },
            { sha: "d", subject: "Merge branch y" },
        ]);
        expect([groups.features.length, groups.fixes.length, groups.other.length]).toEqual([1, 1, 2]);
        expect(groupNotes(null).other).toEqual([]);
    });

    it("offers a build unless the user put it off, and offers newer ones again", () => {
        expect(shouldOffer(manifest, 0)).toBe(true);
        expect(shouldOffer(manifest, 200)).toBe(false);
        expect(shouldOffer(manifest, 150)).toBe(true);
        expect(shouldOffer(null, 0)).toBe(false);
        expect(updateLabel(manifest)).toBe("07e51a7 · build 200");
    });

    it("says what a restart stops", () => {
        const summary = summarizeTerminals([
            { workspace: "Notulia", tab: "T1", shellState: "running-command", lastCommand: "claude" },
            { workspace: "Notulia", tab: "T2", shellState: "ready", lastCommand: "ls" },
            { workspace: "Moltenterm", tab: "T1", shellState: "running-command", lastCommand: "" },
        ]);
        expect(summary).toEqual({
            total: 3,
            running: [
                { workspace: "Notulia", tab: "T1", command: "claude" },
                { workspace: "Moltenterm", tab: "T1", command: "a command" },
            ],
        });
        expect(restartWarning(summary)).toBe("Restarting closes 3 terminals, and 2 are running a command:");
        expect(restartWarning({ total: 1, running: [] })).toBe(
            "Restarting closes 1 terminal; none is running a command."
        );
        expect(restartWarning({ total: 0, running: [] })).toBe("No terminal is open.");
    });
});
