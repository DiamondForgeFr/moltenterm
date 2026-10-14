// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const Mocks = vi.hoisted(() => ({ subscribe: vi.fn(() => () => {}) }));

vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: Mocks.subscribe }));
vi.mock("@/app/store/global", () => ({ atoms: {}, getApi: () => ({}) }));
vi.mock("../review/review-sheet-request", () => ({ requestReviewSheet: vi.fn() }));
vi.mock("./reviews-client", () => ({ reviewsGet: vi.fn() }));
vi.mock("./reviews-store", () => ({ openPullRequestTab: vi.fn() }));

import {
    installReviewHandoff,
    readHandoff,
    ReviewHandoff,
    ReviewHandoffDeps,
    runReviewHandoff,
} from "./reviews-handoff";
import { ReviewPr, ReviewsAnswer } from "./reviews-model";

const pr = { number: 12, title: "feat", branch: "feature/12-x", base: "develop" } as ReviewPr;
const answer = { dir: "/p", state: "ok", repo: "acme/app", ready: [pr], drafts: [] } as ReviewsAnswer;

function deps(): ReviewHandoffDeps {
    return {
        reviews: vi.fn(async () => answer),
        openTab: vi.fn(async () => "tab-r"),
        requestSheet: vi.fn(async () => {}),
        showTab: vi.fn(),
    };
}

function handoff(action: ReviewHandoff["action"], number = 12): ReviewHandoff {
    return { id: "h-" + action + number, action, dir: "/p", number, at: 1 };
}

describe("review handoff", () => {
    it("opens and shows the Review tab, without a sheet for open", async () => {
        const d = deps();
        expect(await runReviewHandoff(handoff("open"), "ws-1", d)).toBe(true);
        expect(d.openTab).toHaveBeenCalledWith("ws-1", "/p", pr, "acme/app");
        expect(d.showTab).toHaveBeenCalledWith("tab-r");
        expect(d.requestSheet).not.toHaveBeenCalled();
    });

    it("leaves the Review tab the sheet publish and merge ask for", async () => {
        const d = deps();
        await runReviewHandoff(handoff("publish"), "ws-1", d);
        await runReviewHandoff(handoff("merge"), "ws-1", d);
        expect(d.requestSheet).toHaveBeenNthCalledWith(
            1,
            "tab-r",
            expect.objectContaining({ id: "h-publish12", action: "publish" })
        );
        expect(d.requestSheet).toHaveBeenNthCalledWith(
            2,
            "tab-r",
            expect.objectContaining({ id: "h-merge12", action: "merge" })
        );
    });

    it("leaves the Review tab Restart work's sheet for restart (FR-REV-011)", async () => {
        const d = deps();
        expect(readHandoff(handoff("restart"))).not.toBeNull();
        expect(await runReviewHandoff(handoff("restart"), "ws-1", d)).toBe(true);
        expect(d.requestSheet).toHaveBeenCalledWith(
            "tab-r",
            expect.objectContaining({ id: "h-restart12", action: "restart" })
        );
        expect(d.showTab).toHaveBeenCalledWith("tab-r");
    });

    it("does nothing for a PR the Reviews data does not list", async () => {
        const d = deps();
        expect(await runReviewHandoff(handoff("merge", 99), "ws-1", d)).toBe(false);
        expect(d.openTab).not.toHaveBeenCalled();
        expect(d.showTab).not.toHaveBeenCalled();
    });

    it("reads only well-formed handoffs", () => {
        expect(readHandoff(handoff("open"))).not.toBeNull();
        expect(readHandoff({ ...handoff("open"), action: "cleanup" })).toBeNull();
        expect(readHandoff({ ...handoff("open"), number: 0 })).toBeNull();
        expect(readHandoff({ ...handoff("open"), dir: "" })).toBeNull();
        expect(readHandoff(null)).toBeNull();
    });

    it("listens on the window's workspace only", () => {
        installReviewHandoff("ws-1");
        expect(Mocks.subscribe).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: "molten:review:handoff", scope: "ws-1" })
        );
        Mocks.subscribe.mockClear();
        installReviewHandoff("");
        expect(Mocks.subscribe).not.toHaveBeenCalled();
    });
});
