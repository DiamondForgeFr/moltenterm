// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-dom", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-dom")>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import { AssistedReviewDialog, AssistedReviewModel, PendingAssistedReview } from "./assisted-review-dialog";

beforeAll(() => {
    vi.stubGlobal("document", { body: {} });
});

function pending(extra: Partial<PendingAssistedReview> = {}): PendingAssistedReview {
    return { number: 17, branch: "fix/11-invoice", base: "develop", agent: "Claude Code", answer: vi.fn(), ...extra };
}

function buttonTag(html: string, testId: string): string {
    return new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
}

describe("Assisted review's confirmation (FR-REV-033 AC1, AC5)", () => {
    it("says what will happen before anything starts: the agent, the PR, its branch, on the left of the diff", () => {
        const html = renderToStaticMarkup(<AssistedReviewDialog pending={pending()} />);
        expect(html).toContain("Assisted review of PR #17");
        expect(html).toContain("fix/11-invoice → develop");
        expect(html).toContain(
            "Claude Code starts on PR #17 in a copy of its branch, on the left of the diff. It reads the changes, prepares a briefing and answers your questions. It only reads: nothing changes on fix/11-invoice."
        );
    });

    it("offers Cancel, Diff only and a molten Start the agent", () => {
        const html = renderToStaticMarkup(<AssistedReviewDialog pending={pending()} />);
        expect(buttonTag(html, "assisted-review-cancel")).not.toContain("molten-btn");
        expect(buttonTag(html, "assisted-review-diff")).not.toContain("molten-btn");
        expect(buttonTag(html, "assisted-review-start")).toContain("molten-btn");
        expect(html).toContain(">Diff only<");
        expect(html.indexOf("assisted-review-cancel")).toBeLessThan(html.indexOf("assisted-review-start"));
    });

    it("names the agent generically until wavesrv names it", () => {
        const html = renderToStaticMarkup(<AssistedReviewDialog pending={pending({ agent: "" })} />);
        expect(html).toContain("Your agent starts on PR #17");
    });
});

describe("AssistedReviewModel (FR-REV-033 AC1)", () => {
    it("resolves with the developer's answer and closes", async () => {
        const model = AssistedReviewModel.getInstance();
        const asked = model.ask({ number: 17, branch: "b", base: "develop" });
        model.nameAgent(17, "Codex");
        expect(globalStore.get(model.pendingAtom).agent).toBe("Codex");
        globalStore.get(model.pendingAtom).answer("agent");
        await expect(asked).resolves.toBe("agent");
        expect(globalStore.get(model.pendingAtom)).toBeNull();
    });

    it("a second ask cancels the first, which starts nothing", async () => {
        const model = AssistedReviewModel.getInstance();
        const first = model.ask({ number: 17, branch: "b", base: "develop" });
        const second = model.ask({ number: 18, branch: "c", base: "develop" });
        await expect(first).resolves.toBeNull();
        model.nameAgent(17, "Codex");
        expect(globalStore.get(model.pendingAtom).agent).toBeUndefined();
        globalStore.get(model.pendingAtom).answer(null);
        await expect(second).resolves.toBeNull();
    });
});
