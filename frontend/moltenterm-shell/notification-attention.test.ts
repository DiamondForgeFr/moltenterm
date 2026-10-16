// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    attentionCount,
    checkAnswered,
    checkAnsweredInNotification,
    checkNeedsAnswer,
    missedForPanel,
    parsePanelPolicy,
    planArrivals,
    stillWaiting,
} from "./notification-attention";
import { MoltentermNotification, NotificationAction } from "./notifications-model";

function answer(id: string): NotificationAction {
    return { id, label: id, kind: "gesture", gesture: "molten:agenthandoff", args: { requestid: "r", decision: id } };
}

function entry(id: string, more: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return { id, source: "moltenterm", title: id, time: 1, updated: 1, kind: "info", read: false, ...more };
}

const question = (id: string, more: Partial<MoltentermNotification> = {}) =>
    entry(id, {
        key: `agenthandoff:${id}`,
        source: "agents" as any,
        kind: "warning",
        blockid: "senderBlock",
        actions: [answer("once"), answer("always"), answer("block")],
        ...more,
    });
const waiting = (id: string, more: Partial<MoltentermNotification> = {}) =>
    entry(id, { key: `attention:${id}`, source: "agent", kind: "warning", blockid: "b", ...more });
const done = (id: string, more: Partial<MoltentermNotification> = {}) =>
    entry(id, { source: "agent", kind: "success", blockid: "b", ...more });

describe("checkNeedsAnswer", () => {
    it("is a question or a waiting notification still open", () => {
        expect(checkNeedsAnswer(question("q"))).toBe(true);
        expect(checkNeedsAnswer(waiting("w"))).toBe(true);
        expect(checkNeedsAnswer(done("d"))).toBe(false);
        expect(checkNeedsAnswer(entry("e", { kind: "error" }))).toBe(false);
        expect(checkNeedsAnswer(question("q", { resolved: 2 }))).toBe(false);
        expect(checkNeedsAnswer(waiting("w", { archived: 2 }))).toBe(false);
        expect(checkNeedsAnswer(null)).toBe(false);
    });

    it("only questions are answered in the notification itself", () => {
        expect(checkAnsweredInNotification(question("q"))).toBe(true);
        expect(checkAnsweredInNotification(waiting("w"))).toBe(false);
        expect(checkAnsweredInNotification(question("q", { resolved: 3 }))).toBe(false);
    });
});

describe("planArrivals", () => {
    it("sends what needs an answer to the panel of a focused window, the rest to toasts", () => {
        expect(planArrivals([question("q"), done("d"), waiting("w")], "answers", true)).toEqual({
            panel: ["q", "w"],
            toast: ["d"],
        });
    });

    it("opens the panel for everything when the developer asked for it", () => {
        expect(planArrivals([question("q"), done("d")], "all", true)).toEqual({ panel: ["q", "d"], toast: [] });
    });

    it("never opens the panel of a window out of focus", () => {
        expect(planArrivals([question("q"), done("d")], "answers", false)).toEqual({ panel: [], toast: ["q", "d"] });
        expect(missedForPanel([question("q"), done("d")], "answers")).toEqual(["q"]);
        expect(missedForPanel([question("q"), done("d")], "all")).toEqual(["q", "d"]);
    });
});

describe("stillWaiting", () => {
    it("keeps the unread ones and the questions still open", () => {
        const entries = [
            question("q", { read: true }),
            waiting("w", { read: true }),
            done("d"),
            question("x", { resolved: 4 }),
        ];
        expect(stillWaiting(entries, ["q", "w", "d", "x", "gone"])).toEqual(["q", "d"]);
    });
});

describe("checkAnswered", () => {
    it("is true once every entry the panel opened for is closed", () => {
        expect(checkAnswered([question("q")], ["q"])).toBe(false);
        expect(checkAnswered([question("q", { resolved: 5 })], ["q"])).toBe(true);
        expect(checkAnswered([], ["q"])).toBe(true);
        expect(checkAnswered([question("q", { resolved: 5 }), waiting("w")], ["q", "w"])).toBe(false);
        expect(checkAnswered([entry("typed", { kind: "warning", read: true })], ["typed"])).toBe(true);
        expect(checkAnswered([question("q")], [])).toBe(false);
    });
});

describe("attentionCount", () => {
    it("counts the unread ones and the questions read but not answered", () => {
        expect(attentionCount([done("d"), question("q", { read: true }), waiting("w", { read: true })])).toBe(2);
        expect(attentionCount([question("q", { read: true, resolved: 2 })])).toBe(0);
    });
});

describe("parsePanelPolicy", () => {
    it("defaults to answers", () => {
        expect(parsePanelPolicy("all")).toBe("all");
        expect(parsePanelPolicy("answers")).toBe("answers");
        expect(parsePanelPolicy(undefined)).toBe("answers");
        expect(parsePanelPolicy(42)).toBe("answers");
    });
});
