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
    branchesPlan: vi.fn(() => new Promise(() => {})),
}));

import { BranchCleanupDialog, isMainBranch, KeptBranchRow } from "./branch-cleanup";

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
