// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-dom", async (importOriginal) => ({
    ...(await importOriginal<typeof import("react-dom")>()),
    createPortal: (node: React.ReactNode) => node,
}));
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

import {
    BranchCleanupDialog,
    branchHolders,
    branchReason,
    HeldBranchActions,
    isMainBranch,
    KeptBranchRow,
} from "./branch-cleanup";
import type { BranchPlan } from "./mission-client";

describe("a merged branch held by a session (#932)", () => {
    const held: BranchPlan = {
        name: "fix/890-dialog",
        remote: false,
        action: "keep",
        reason: "worktree-in-use",
        pr: 891,
        worktree: "/data/work-891",
        terminals: [
            { blockid: "b1", tab: "T1" },
            { blockid: "b2", tab: "Review" },
        ],
    };
    const sessions: any[] = [{ id: "j1", blockid: "b1", tabname: "CI #891", folder: "/data/work-891" }];

    it("names the sessions holding the worktree, by their Sessions list name, else their tab", () => {
        const holders = branchHolders(held, sessions, "/home/me");
        expect(holders).toEqual([
            { blockid: "b1", name: "CI #891" },
            { blockid: "b2", name: "Review" },
        ]);
        expect(branchReason(held, "develop", holders)).toBe(
            "merged in #891, but the sessions CI #891, Review have terminals open in its worktree"
        );
        const one = branchHolders({ ...held, terminals: [{ blockid: "b1" }] }, sessions, "/home/me");
        expect(branchReason(held, "develop", one)).toBe(
            "merged in #891, but the session CI #891 has a terminal open in its worktree"
        );
        expect(branchReason(held, "develop")).toBe("merged in #891, but a terminal is open in its worktree");
    });

    it("never names holders for another reason, uncommitted changes included", () => {
        expect(branchHolders({ ...held, reason: "worktree-changes" }, sessions, "")).toEqual([]);
        expect(branchHolders({ ...held, remote: true }, sessions, "")).toEqual([]);
        const html = renderToStaticMarkup(
            <HeldBranchActions
                branch={held}
                holders={[]}
                busy={false}
                confirming={false}
                setConfirming={() => {}}
                onShow={() => {}}
                onCloseAndClean={() => {}}
            />
        );
        expect(html).toBe("");
    });

    // Renders the actions and keeps the element tree, so the buttons' handlers can be pressed without a DOM.
    function renderActions(props: Partial<React.ComponentProps<typeof HeldBranchActions>>) {
        let tree: React.ReactElement = null;
        const all = {
            branch: held,
            holders: [{ blockid: "b1", name: "CI #891" }],
            busy: false,
            confirming: false,
            setConfirming: () => {},
            onShow: () => {},
            onCloseAndClean: () => {},
            ...props,
        };
        function Probe() {
            tree = HeldBranchActions(all) as React.ReactElement;
            return tree;
        }
        const html = renderToStaticMarkup(<Probe />);
        const buttons: React.ReactElement<any>[] = [];
        const walk = (node: any) => {
            if (node == null || typeof node !== "object") {
                return;
            }
            if (Array.isArray(node)) {
                node.forEach(walk);
                return;
            }
            if (node.type === "button") {
                buttons.push(node);
            }
            walk(node.props?.children);
        };
        walk(tree);
        return { html, buttons };
    }

    it("offers Show the session and Close the session and clean, which only asks", () => {
        const onShow = vi.fn();
        const setConfirming = vi.fn();
        const onCloseAndClean = vi.fn();
        const { html, buttons } = renderActions({ onShow, setConfirming, onCloseAndClean });
        expect(html).toContain(">Show the session<");
        expect(html).toContain("Close the session and clean…");
        buttons[0].props.onClick();
        expect(onShow).toHaveBeenCalledWith({ blockid: "b1", name: "CI #891" });
        buttons[1].props.onClick();
        expect(setConfirming).toHaveBeenCalledWith(true);
        expect(onCloseAndClean).not.toHaveBeenCalled();
    });

    it("names each session to show when several hold the worktree", () => {
        const { html } = renderActions({
            holders: [
                { blockid: "b1", name: "CI #891" },
                { blockid: "b2", name: "Review" },
            ],
        });
        expect(html).toContain(">Show CI #891<");
        expect(html).toContain(">Show Review<");
        expect(html).toContain("Close the sessions and clean…");
    });

    it("confirms naming the session and the stopping agent; Cancel changes nothing", () => {
        const setConfirming = vi.fn();
        const onCloseAndClean = vi.fn();
        const { html, buttons } = renderActions({ confirming: true, setConfirming, onCloseAndClean });
        expect(html).toContain("Close the session CI #891?");
        expect(html).toContain("an agent running in it stops");
        expect(html).toContain("fix/890-dialog");
        buttons[0].props.onClick();
        expect(setConfirming).toHaveBeenCalledWith(false);
        expect(onCloseAndClean).not.toHaveBeenCalled();
        buttons[1].props.onClick();
        expect(onCloseAndClean).toHaveBeenCalledTimes(1);
    });
});

describe("main branches in the list of branches that stay (#920)", () => {
    const kept = (name: string, remote: boolean, reason: any) => ({ name, remote, action: "keep" as const, reason });

    it("marks only the branches kept as main branches", () => {
        for (const b of [kept("develop", false, "protected"), kept("main", true, "protected")]) {
            expect(isMainBranch(b)).toBe(true);
        }
        expect(isMainBranch(kept("feature/1-x", false, "not-on-trunk"))).toBe(false);
        expect(isMainBranch(kept("feature/2-y", true, "open-pr"))).toBe(false);
        expect(isMainBranch({ name: "develop", remote: false, action: "delete", reason: "protected" })).toBe(false);
    });

    it("draws a main branch's name and icon in the info colour, keeps its reason, and leaves other branches plain", () => {
        const main = renderToStaticMarkup(<KeptBranchRow branch={kept("main", true, "protected")} trunk="develop" />);
        expect(main).toContain('data-main-branch="true"');
        expect(main).toMatch(/<i class="[^"]*fa-code-branch[^"]*text-info/);
        expect(main).toMatch(/<code class="text-info">origin\/main<\/code>/);
        expect(main).toContain("a main branch");

        const feature = renderToStaticMarkup(
            <KeptBranchRow branch={kept("feature/1-x", false, "not-on-trunk")} trunk="develop" />
        );
        expect(feature).not.toContain("data-main-branch");
        expect(feature).not.toContain("text-info");
        expect(feature).toMatch(/<i class="[^"]*fa-code-branch[^"]*text-muted/);
    });
});

describe("the branch cleaning dialog (#746)", () => {
    it("is a modal dialog on the shared frame, with Cancel first", () => {
        vi.stubGlobal("document", { body: {} });
        const html = renderToStaticMarkup(<BranchCleanupDialog dir="/p" onClose={() => {}} onCleaned={() => {}} />);
        vi.unstubAllGlobals();
        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-modal="true"');
        expect(html).toContain('aria-label="Clean branches"');
        expect(html).toContain("molten-scrim");
        const buttons = html.match(/<button[^>]*>[^<]*/g);
        expect(buttons[0]).toMatch(/>Cancel$/);
        // While the plan loads there is nothing to delete, so no Delete button (#745).
        expect(html).not.toContain("Delete");
    });
});
