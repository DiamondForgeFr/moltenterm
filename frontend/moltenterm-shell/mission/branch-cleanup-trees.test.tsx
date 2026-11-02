// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wos", () => ({ getWaveObjectAtom: vi.fn(), makeORef: vi.fn() }));
vi.mock("./mission-client", () => ({
    branchesAutoDelete: vi.fn(),
    branchesClean: vi.fn(),
    branchesCloseAndClean: vi.fn(),
    branchesPlan: vi.fn(() => new Promise(() => {})),
}));
vi.mock("../sessions/sessions-store", async () => {
    const { atom } = await import("jotai");
    const dataAtom = atom(null);
    return { DurableSessions: { getInstance: () => ({ dataAtom }) } };
});
vi.mock("../review/review-panels", () => ({ showPanel: vi.fn() }));

import { I18nModel } from "../i18n/i18n";
import { branchReason, CheckedTreesGroup, cleanErrorLines, HeldBranchActions, treeFacts } from "./branch-cleanup";
import type { BranchPlan } from "./mission-client";

describe("worktrees of other tools, outside the project or locked (#1028)", () => {
    const agent: BranchPlan = {
        name: "worktree-agent-a7e6",
        remote: false,
        action: "delete",
        reason: "merged-worktree",
        worktree: "/p/.claude/worktrees/agent-a7e6",
        tool: "claude-code",
        locked: true,
        confirm: true,
    };
    const conductor: BranchPlan = {
        name: "conductor-skills",
        remote: false,
        action: "delete",
        reason: "merged-worktree",
        pr: 412,
        worktree: "/home/me/conductor/workspaces/SaaSFoundry/gaborone",
        tool: "conductor",
        outside: true,
        ignoredfiles: 2,
        confirm: true,
    };

    it("lists them unchecked, each naming the folder deleted, its tool, locked and outside", () => {
        const html = renderToStaticMarkup(
            <CheckedTreesGroup
                branches={[agent, conductor]}
                trunk="develop"
                checked={new Set()}
                disabled={false}
                onToggle={() => {}}
            />
        );
        expect(html).toContain("Worktrees of other tools, outside the project or locked (2)");
        expect(html).not.toContain("checked=");
        expect(html).toContain("Deletes the folder /p/.claude/worktrees/agent-a7e6");
        expect(html).toContain("its commits are all on develop, its worktree is clean");
        expect(html).toContain("locked, made by a Claude Code agent");
        expect(html).toContain("Deletes the folder /home/me/conductor/workspaces/SaaSFoundry/gaborone");
        expect(html).toContain("merged in #412, its worktree is clean");
        expect(html).toContain("made by Conductor · outside the project folder · 2 ignored files go with it");
        expect(html).toContain("cursor-pointer");
    });

    it("shows a checked one as checked, and only that one", () => {
        const html = renderToStaticMarkup(
            <CheckedTreesGroup
                branches={[agent, conductor]}
                trunk="develop"
                checked={new Set([conductor.worktree])}
                disabled={false}
                onToggle={() => {}}
            />
        );
        expect(html.match(/checked=""/g)).toHaveLength(1);
    });

    it("says precisely why a worktree's branch stays", () => {
        const kept = (reason: any, extra: Partial<BranchPlan> = {}): BranchPlan => ({
            name: "x",
            remote: false,
            action: "keep",
            reason,
            worktree: "/w",
            ...extra,
        });
        expect(branchReason(kept("worktree-changes"), "develop")).toBe("its worktree has uncommitted changes");
        expect(branchReason(kept("worktree-commits"), "develop")).toBe(
            "its worktree's branch holds commits that are not on develop"
        );
        expect(branchReason(kept("worktree-operation", { operation: "rebase" }), "develop")).toBe(
            "a rebase is in progress in its worktree"
        );
        expect(
            branchReason(kept("worktree-process", { processes: [{ pid: 4242, name: "claude" }] }), "develop")
        ).toBe("its worktree is in use by claude (4242)");
        expect(branchReason(kept("worktree-in-use"), "develop")).toBe("a terminal is open in its worktree");
        expect(branchReason(kept("worktree-refused"), "develop")).toContain("MoltenTerm never deletes it");
        expect(treeFacts(kept("worktree-changes", { tool: "codex" }))).toEqual(["made by Codex"]);
    });

    it("words them in French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        try {
            expect(branchReason(agent, "develop")).toBe("tous ses commits sont sur develop, son worktree est propre");
            expect(treeFacts(agent)).toEqual(["verrouillé, créé par un agent Claude Code"]);
            expect(treeFacts(conductor)).toEqual([
                "créé par Conductor",
                "hors du dossier du projet",
                "2 fichiers ignorés partent avec lui",
            ]);
        } finally {
            I18nModel.getInstance().setLanguageSetting("en");
        }
    });

    it("names the process that kept a worktree at the removal", () => {
        const lines = cleanErrorLines(
            {
                deleted: [],
                failed: 1,
                errors: ["feature/b: kept (worktree-process)"],
                errorstext: [
                    {
                        code: "mission.branches.kept",
                        vars: { branch: "feature/b", reason: "worktree-process", pr: "0", processes: "codex (5151)" },
                    },
                ],
            },
            "develop"
        );
        expect(lines).toEqual(["feature/b: kept (its worktree is in use by codex (5151))"]);
    });

    it("never offers to close and clean another tool's worktree, only to show its session", () => {
        const html = renderToStaticMarkup(
            <HeldBranchActions
                branch={{ ...agent, action: "keep", reason: "worktree-in-use" }}
                holders={[{ blockid: "b1", name: "Agent" }]}
                busy={false}
                confirming={false}
                setConfirming={() => {}}
                onShow={() => {}}
                onCloseAndClean={() => {}}
            />
        );
        expect(html).toContain(">Show the session<");
        expect(html).not.toContain("clean");
    });
});
