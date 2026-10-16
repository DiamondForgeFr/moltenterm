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

import { BranchCleanupDialog } from "./branch-cleanup";

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
