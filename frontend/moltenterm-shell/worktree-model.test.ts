// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { PaneState } from "./status-bar-model";
import {
    closePlanView,
    closingWorktreeLink,
    keptWorktreeNoticeKey,
    makeTabCloseRows,
    readReviewPath,
    readWorktreeDismissed,
    readWorktreeLink,
    tabCloseRemovals,
    tabTreesTooltip,
    tabWorktrees,
    treeMarker,
    treeTooltipLine,
    unpushedAtRisk,
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
        ignoredfilecount: 0,
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
        const m = treeMarker(
            { ...mainState, linked: { path: "/w/feat-42", branch: "feature/42-x", inside: false } },
            "/w/feat-42"
        );
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

    it("does not offer the linked worktree spelled another way", () => {
        const state = { ...wtState, root: "/private/w/feat-42", linked: { path: "/w/feat-42", inside: true } };
        expect(worktreeOffer(state, "/w/feat-42", [])).toBe("");
        expect(treeMarker(state, "/w/feat-42").outside).toBe(false);
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
        const v = closePlanView(plan({ unpushed: 1, merged: false }));
        expect(v.atRisk).toBe(true);
        expect(v.unpushedAtRisk).toBe(true);
        expect(v.unpushedLine).toBe("1 commit on no remote");
    });

    it("asks once for a merged branch whose remote branch is gone (#134)", () => {
        const v = closePlanView(plan({ unpushed: 3, merged: true }));
        expect(v.atRisk).toBe(false);
        expect(v.unpushedAtRisk).toBe(false);
        expect(v.unpushedLine).toBe("3 commits on no remote, content already on develop");
        expect(unpushedAtRisk(plan({ unpushed: 3, merged: true }))).toBe(false);
        expect(unpushedAtRisk(plan({ unpushed: -1, merged: true }))).toBe(true);
        expect(unpushedAtRisk(plan({ unpushed: 3, merged: undefined }))).toBe(true);
        expect(closePlanView(plan({ unpushed: 3, merged: true, changecount: 1, changes: ["a"] })).atRisk).toBe(true);
    });

    it("keeps by default when another terminal uses it, and asks twice to remove", () => {
        const v = closePlanView(plan({ terminals: [{ blockid: "b2", tab: "T2", workspace: "Work", linked: true }] }));
        expect(v.shared).toBe(true);
        expect(v.atRisk).toBe(true);
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

    it("names the ignored files that go with it and asks twice for them", () => {
        const v = closePlanView(plan({ ignored: [".env"], ignoredcount: 1, ignoredfilecount: 1 }));
        expect(v.ignoredLine).toBe("1 ignored entry removed too: .env");
        expect(v.atRisk).toBe(true);
        expect(closePlanView(plan({ ignored: ["node_modules/"], ignoredcount: 1 })).atRisk).toBe(false);
    });

    it("treats commits git could not count as work at risk", () => {
        const v = closePlanView(plan({ unpushed: -1 }));
        expect(v.atRisk).toBe(true);
        expect(v.unpushedLine).toContain("could not count");
    });

    it("never removes a refused folder", () => {
        const v = closePlanView(plan({ refused: "the home folder" }));
        expect(v.canRemove).toBe(false);
        expect(v.blockedReason).toContain("home folder");
    });
});

describe("closing a tab with worktrees (#134)", () => {
    const term = (oid: string, link: string, more: Record<string, any> = {}) => ({
        oid,
        meta: { view: "term", "molten:worktree": link, ...more },
    });

    it("groups the tab's local terminals by linked worktree", () => {
        const blocks = [
            term("b1", "/w/a"),
            { oid: "b2", meta: { view: "preview" } },
            term("b3", "/w/b"),
            term("b4", "/w/a"),
            term("b5", "/w/c", { connection: "user@host" }),
            term("b6", ""),
        ];
        expect(tabWorktrees(blocks, () => false)).toEqual([
            { path: "/w/a", blockIds: ["b1", "b4"] },
            { path: "/w/b", blockIds: ["b3"] },
        ]);
        expect(tabWorktrees([], () => false)).toEqual([]);
        expect(tabWorktrees(blocks, (id) => id === "b3")).toEqual([{ path: "/w/a", blockIds: ["b1", "b4"] }]);
    });

    it("keeps every worktree unless a row says Remove, and asks twice only for rows at risk", () => {
        const rows = makeTabCloseRows([
            { path: "/w/clean", blockIds: ["b1"] },
            { path: "/w/dirty", blockIds: ["b2"] },
        ]);
        expect(rows.every((r) => r.choice === "keep")).toBe(true);
        rows[0].plan = plan({ path: "/w/clean" });
        rows[1].plan = plan({ path: "/w/dirty", changecount: 1, changes: ["x"] });
        expect(tabCloseRemovals(rows)).toEqual({ remove: [], atRisk: [] });
        rows[0].choice = "remove";
        expect(tabCloseRemovals(rows).remove.map((r) => r.path)).toEqual(["/w/clean"]);
        expect(tabCloseRemovals(rows).atRisk).toEqual([]);
        rows[1].choice = "remove";
        expect(tabCloseRemovals(rows).atRisk.map((r) => r.path)).toEqual(["/w/dirty"]);
        rows[0].removed = true;
        expect(tabCloseRemovals(rows).remove.map((r) => r.path)).toEqual(["/w/dirty"]);
    });

    it("never removes a row without a plan, or one MoltenTerm refuses", () => {
        const rows = makeTabCloseRows([
            { path: "/w/a", blockIds: ["b1"] },
            { path: "/w/b", blockIds: ["b2"] },
        ]);
        rows.forEach((r) => (r.choice = "remove"));
        rows[0].error = "not a linked worktree";
        rows[1].plan = plan({ path: "/w/b", locked: true });
        expect(tabCloseRemovals(rows).remove).toEqual([]);
    });
});

describe("a worktree kept when its terminal went alone (#134)", () => {
    it("names the notification and its action", () => {
        expect(keptWorktreeNoticeKey("/w/a")).toBe("worktree:kept:/w/a");
        expect(readReviewPath({ path: "/w/a" })).toBe("/w/a");
        expect(readReviewPath({ path: "w/a" })).toBe("");
        expect(readReviewPath({ path: 3 })).toBe("");
        expect(readReviewPath(null)).toBe("");
    });

    it("reads the link of a closing local terminal only", () => {
        expect(closingWorktreeLink({ view: "term", "molten:worktree": "/w/a" })).toBe("/w/a");
        expect(closingWorktreeLink({ view: "term", connection: "local", "molten:worktree": "/w/a" })).toBe("/w/a");
        expect(closingWorktreeLink({ view: "term", connection: "me@host", "molten:worktree": "/w/a" })).toBe("");
        expect(closingWorktreeLink({ view: "preview", "molten:worktree": "/w/a" })).toBe("");
        expect(closingWorktreeLink(null)).toBe("");
    });
});
