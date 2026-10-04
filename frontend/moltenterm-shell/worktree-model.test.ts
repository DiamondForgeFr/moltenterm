// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { PaneState } from "./status-bar-model";
import {
    closePlanView,
    readWorktreeDismissed,
    readWorktreeLink,
    tabTreesTooltip,
    treeMarker,
    treeTooltipLine,
    withWorktreeDismissed,
    worktreeColor,
    worktreeOffer,
    WorktreePlan,
} from "./worktree-model";

const mainState: PaneState = { dir: "/r/src", root: "/r", project: "/r", branch: "develop", sha: "abcdef1234" };
const wtState: PaneState = {
    dir: "/w/feat-42",
    root: "/w/feat-42",
    project: "/r",
    branch: "feature/42-x",
    worktree: true,
};

function plan(over: Partial<WorktreePlan> = {}): WorktreePlan {
    return {
        path: "/w/feat-42",
        branch: "feature/42-x",
        changes: [],
        changecount: 0,
        ignored: [],
        ignoredcount: 0,
        unpushed: 0,
        trunk: "develop",
        merged: true,
        terminals: [],
        ...over,
    };
}

describe("treeMarker", () => {
    it("says main tree explicitly", () => {
        const m = treeMarker(mainState, "");
        expect(m.kind).toBe("main");
        expect(m.label).toBe("main tree");
        expect(m.branch).toBe("develop");
    });

    it("shows no marker outside a repository or while asking", () => {
        expect(treeMarker({ dir: "/tmp" }, "")).toBeNull();
        expect(treeMarker(null, "")).toBeNull();
    });

    it("names an unlinked worktree with its branch", () => {
        const m = treeMarker(wtState, "");
        expect(m.kind).toBe("worktree");
        expect(m.label).toBe("feat-42");
        expect(m.branch).toBe("feature/42-x");
        expect(m.linked).toBe(false);
    });

    it("keeps the linked worktree when the terminal leaves it", () => {
        const m = treeMarker({ ...mainState, linked: { path: "/w/feat-42", branch: "feature/42-x" } }, "/w/feat-42");
        expect(m.kind).toBe("worktree");
        expect(m.linked).toBe(true);
        expect(m.outside).toBe(true);
        expect(m.branch).toBe("feature/42-x");
        expect(m.title).toContain("outside its worktree");
    });

    it("falls back to missing worktree when it was removed outside", () => {
        const m = treeMarker({ ...mainState, linked: { path: "/w/feat-42", missing: true } }, "/w/feat-42");
        expect(m.kind).toBe("missing");
        expect(m.label).toBe("missing worktree");
    });

    it("gives two terminals on the same worktree the same marker", () => {
        const a = treeMarker(wtState, "");
        const b = treeMarker({ ...wtState, dir: "/w/feat-42/src" }, "/w/feat-42");
        expect(a.colorClass).toBe(b.colorClass);
        expect(a.label).toBe(b.label);
        expect(worktreeColor("/w/feat-42")).toBe(worktreeColor("/w/feat-42"));
    });
});

describe("worktreeOffer", () => {
    it("offers an unlinked worktree only", () => {
        expect(worktreeOffer(wtState, "", [])).toBe("/w/feat-42");
        expect(worktreeOffer(wtState, "/w/feat-42", [])).toBe("");
        expect(worktreeOffer(wtState, "", ["/w/feat-42"])).toBe("");
    });

    it("never offers the main tree", () => {
        expect(worktreeOffer(mainState, "", [])).toBe("");
        expect(worktreeOffer(null, "", [])).toBe("");
    });

    it("offers another worktree to a linked terminal", () => {
        expect(worktreeOffer(wtState, "/w/other", [])).toBe("/w/feat-42");
    });

    it("remembers Not now", () => {
        expect(withWorktreeDismissed(["/a"], "/b")).toEqual(["/a", "/b"]);
        expect(withWorktreeDismissed(["/a"], "/a")).toEqual(["/a"]);
        expect(readWorktreeDismissed({ "molten:worktreedismissed": ["/a", 3] })).toEqual(["/a"]);
        expect(readWorktreeLink({ "molten:worktree": "/w" })).toBe("/w");
        expect(readWorktreeLink(null)).toBe("");
    });
});

describe("tab tooltip", () => {
    it("lists the trees", () => {
        const lines = [treeTooltipLine(treeMarker(mainState, "")), treeTooltipLine(treeMarker(wtState, "")), ""];
        expect(tabTreesTooltip(lines)).toBe(
            "Trees:\n• main tree · develop\n• worktree feat-42 · feature/42-x (not linked)"
        );
        expect(tabTreesTooltip(["", ""])).toBe("");
    });
});

describe("closePlanView", () => {
    it("removes a clean, unshared worktree by default", () => {
        const v = closePlanView(plan());
        expect(v.atRisk).toBe(false);
        expect(v.defaultChoice).toBe("remove");
        expect(v.canDeleteBranch).toBe(true);
        expect(v.mergedLine).toContain("merged");
    });

    it("asks twice for uncommitted or unpushed work", () => {
        expect(closePlanView(plan({ changecount: 2, changes: ["a", "b"] })).atRisk).toBe(true);
        const v = closePlanView(plan({ unpushed: 1 }));
        expect(v.atRisk).toBe(true);
        expect(v.unpushedLine).toBe("1 commit on no remote");
    });

    it("keeps by default when another terminal uses it", () => {
        const v = closePlanView(plan({ terminals: [{ blockid: "b2", tab: "T2", workspace: "Work", linked: true }] }));
        expect(v.shared).toBe(true);
        expect(v.defaultChoice).toBe("keep");
        expect(v.terminalsLine).toContain("Work › T2");
    });

    it("never offers to delete an unmerged or long-lived branch", () => {
        expect(closePlanView(plan({ merged: false })).canDeleteBranch).toBe(false);
        expect(closePlanView(plan({ merged: undefined })).canDeleteBranch).toBe(false);
        expect(closePlanView(plan({ protected: true })).canDeleteBranch).toBe(false);
        expect(closePlanView(plan({ branch: "", detached: true, sha: "abc1234ff" })).canDeleteBranch).toBe(false);
    });

    it("keeps a locked worktree", () => {
        const v = closePlanView(plan({ locked: true }));
        expect(v.canRemove).toBe(false);
        expect(v.blockedReason).toContain("locked");
    });

    it("names the ignored files that go with it", () => {
        const v = closePlanView(plan({ ignored: [".env"], ignoredcount: 1 }));
        expect(v.ignoredLine).toBe("1 ignored entry removed too: .env");
    });
});
