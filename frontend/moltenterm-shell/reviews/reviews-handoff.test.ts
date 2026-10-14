// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const Mocks = vi.hoisted(() => ({ subscribe: vi.fn(() => () => {}) }));

vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: Mocks.subscribe }));
vi.mock("../review/review-tab-model", () => ({ ReviewTabModels: {} }));
vi.mock("./reviews-client", () => ({ reviewsGet: vi.fn() }));
vi.mock("./reviews-store", () => ({ ReviewsModel: { getInstance: () => ({}) } }));

import { installReviewHandoff, readHandoff, ReviewHandoff, ReviewHandoffDeps, runReviewHandoff } from "./reviews-handoff";
import { ReviewPr, ReviewsAnswer } from "./reviews-model";

const pr = { number: 12, title: "feat", branch: "feature/12-x", base: "develop" } as ReviewPr;
const answer = { dir: "/p", state: "ok", repo: "acme/app", ready: [pr], drafts: [] } as ReviewsAnswer;

function deps(sheets = { openPublish: vi.fn(async () => {}), openValidate: vi.fn(async () => {}) }) {
    const d: ReviewHandoffDeps = {
        reviews: vi.fn(async () => answer),
        openTab: vi.fn(async () => {}),
        sheets: vi.fn(async () => sheets),
    };
    return { d, sheets };
}

function handoff(action: ReviewHandoff["action"], number = 12): ReviewHandoff {
    return { id: "h-" + action + number, action, dir: "/p", number, at: 1 };
}

describe("review handoff", () => {
    it("opens the Review tab only for open", async () => {
        const { d, sheets } = deps();
        expect(await runReviewHandoff(handoff("open"), d)).toBe(true);
        expect(d.openTab).toHaveBeenCalledWith("/p", pr, "acme/app");
        expect(d.sheets).not.toHaveBeenCalled();
        expect(sheets.openPublish).not.toHaveBeenCalled();
    });

    it("opens the Publish sheet for publish and the Validate sheet for merge, never more", async () => {
        const { d, sheets } = deps();
        await runReviewHandoff(handoff("publish"), d);
        expect(sheets.openPublish).toHaveBeenCalledTimes(1);
        expect(sheets.openValidate).not.toHaveBeenCalled();
        await runReviewHandoff(handoff("merge"), d);
        expect(sheets.openValidate).toHaveBeenCalledTimes(1);
        expect(d.sheets).toHaveBeenCalledWith("acme/app", 12);
    });

    it("does nothing for a PR the Reviews data does not list", async () => {
        const { d } = deps();
        expect(await runReviewHandoff(handoff("merge", 99), d)).toBe(false);
        expect(d.openTab).not.toHaveBeenCalled();
    });

    it("gives up on the sheet when the tab's model is not ready", async () => {
        const { d } = deps();
        d.sheets = vi.fn(async () => null);
        expect(await runReviewHandoff(handoff("publish"), d)).toBe(false);
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
        expect(Mocks.subscribe).toHaveBeenCalledWith(expect.objectContaining({ eventType: "molten:review:handoff", scope: "ws-1" }));
        Mocks.subscribe.mockClear();
        installReviewHandoff("");
        expect(Mocks.subscribe).not.toHaveBeenCalled();
    });
});
