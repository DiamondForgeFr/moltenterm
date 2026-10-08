// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { termUpdateEntries } from "../palette/palette-sources";
import {
    applyOutdated,
    EmptyOutdated,
    OutdatedData,
    outdatedOfBlock,
    outdatedTitle,
    updatableWithoutAsking,
    updateAllDetail,
    updateAllSummary,
} from "./termupdate-model";

const shell = { blockid: "b1", reason: "nogeneration" as const, generation: 0, current: 1 };
const withAgent = { ...shell, blockid: "b2", agent: "claude", agentname: "Claude Code" };

describe("outdated terminals", () => {
    it("keeps the newest list", () => {
        const v2: OutdatedData = { terminals: [shell], version: 2 };
        const v1: OutdatedData = { terminals: [], version: 1 };
        expect(applyOutdated(EmptyOutdated, v2)).toEqual(v2);
        expect(applyOutdated(v2, v1)).toBe(v2);
        expect(outdatedOfBlock(v2, "b1")).toEqual(shell);
        expect(outdatedOfBlock(v2, "b9")).toBeNull();
    });

    it("explains why on hover", () => {
        expect(outdatedTitle(withAgent)).toContain(
            "Started before the update: Claude Code runs without MoltenTerm's browser and hooks."
        );
        expect(outdatedTitle(withAgent)).toContain("same conversation");
        expect(outdatedTitle(shell)).toContain("older MoltenTerm");
        expect(outdatedTitle(shell)).toContain("scrollback stays");
        expect(outdatedTitle(null)).toBe("");
    });

    it("leaves terminals running an agent to their own confirmation", () => {
        expect(updatableWithoutAsking({ terminals: [shell, withAgent], version: 1 })).toEqual([shell]);
    });

    it("summarises what the palette did", () => {
        expect(updateAllSummary([{ blockid: "b1", outcome: { status: "updated", message: "" } }])).toEqual({
            title: "1 terminal updated",
            message: "",
            kind: "success",
        });
        const mixed = updateAllSummary([
            { blockid: "b1", outcome: { status: "updated", message: "" } },
            { blockid: "b2", outcome: { status: "busy", message: "Finish or stop sleep first." } },
        ]);
        expect(mixed.kind).toBe("warning");
        expect(mixed.message).toBe("1 terminal was left as it is: Finish or stop sleep first.");
    });

    it("offers the palette entry only when some terminal is outdated", () => {
        expect(termUpdateEntries(0)).toEqual([]);
        const [entry] = termUpdateEntries(2);
        expect(entry).toMatchObject({ label: "Update outdated terminals", run: { kind: "updateterminals" } });
        expect(entry.detail).toBe(updateAllDetail(2));
        expect(updateAllDetail(1)).toBe("1 terminal started before MoltenTerm's update");
    });
});
