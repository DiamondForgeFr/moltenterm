// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { command: string; data: any; opts: any }[] = [];
const subscriptions: any[] = [];

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {
        wshRpcCall: (command: string, data: any, opts: any) => {
            calls.push({ command, data, opts });
            if (command === "moltenreviewlist") {
                return Promise.resolve({ sessions: [{ id: "s1" }] });
            }
            return Promise.resolve({ status: "started" });
        },
    },
}));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: any) => {
        subscriptions.push(sub);
        return () => {};
    },
}));

import {
    endReviewSession,
    listReviewSessions,
    reviewScope,
    ReviewSessionRoute,
    startReviewSession,
    subscribeReviewSession,
} from "./review-session";

describe("review session entry point (FR-REV-004)", () => {
    beforeEach(() => {
        calls.length = 0;
        subscriptions.length = 0;
    });

    it("calls wavesrv's review session route", async () => {
        const res = await startReviewSession({ projectdir: "/p", repo: "o/r", number: 7, headref: "feature/7-x" });
        expect(res.status).toBe("started");
        await endReviewSession({ repo: "o/r", number: 7 });
        expect(await listReviewSessions()).toEqual([{ id: "s1" }]);
        expect(calls.map((c) => c.command)).toEqual(["moltenreviewstart", "moltenreviewend", "moltenreviewlist"]);
        expect(calls.every((c) => c.opts.route === ReviewSessionRoute)).toBe(true);
        // Starting may fetch the branch and create the worktree: it waits longer than the other calls.
        expect(calls[0].opts.timeout).toBeGreaterThan(calls[1].opts.timeout);
    });

    it("follows one PR's session", () => {
        const updates: any[] = [];
        subscribeReviewSession("o/r", 7, (u) => updates.push(u));
        expect(subscriptions[0].scope).toBe(reviewScope("o/r", 7));
        expect(subscriptions[0].scope).toBe("review:o/r#7");
        subscriptions[0].handler({ data: { ended: true } });
        expect(updates).toEqual([{ ended: true }]);
    });
});
