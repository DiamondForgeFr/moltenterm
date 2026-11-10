// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk does not come for what the developer already has in view (FR-BOSS-009, AC63 and AC64, #2166).

import { describe, expect, it } from "vitest";
import type { AgentSeenView } from "../agent-state-model";
import { toastsToShow } from "../notification-toasts";
import type { MoltentermNotification } from "../notifications-model";
import { eventSourceInView, NothingInView, notificationInView } from "../source-in-view";
import { edgeNewsAfter, NoNews } from "./brokk-edge-model";
import { BrokkHub, HubDeps } from "./brokk-hub";
import { LeftViewDelayMs } from "./brokk-visit";
import type { BrokkEvent } from "./brokk-visit-events";
import { EmptyShared, SharedVisit } from "./brokk-visit-share";

// 14:00 on the local clock, far from the default quiet hours. The clock only moves by hand.
const T = new Date(2026, 10, 6, 14, 0, 0).getTime();
const Min = 60_000;
const Source = "test";

// An agent that has waited past the default threshold of 5 min: set to Vient by default.
const waiting: BrokkEvent = { key: "agent:blockA", kind: "blocked", since: T - 6 * Min };

const showsA: AgentSeenView = { active: true, blockIds: ["blockA", "blockB"], focusedBlockId: "blockB" };
const showsOther: AgentSeenView = { active: true, blockIds: ["blockC"], focusedBlockId: "blockC" };
const unfocused: AgentSeenView = NothingInView;

function fixture(shared: { stored: SharedVisit } = { stored: EmptyShared }) {
    const clock = { now: T };
    const pending = new Map<number, { run: () => void; at: number }>();
    let nextId = 1;
    const deps: HubDeps = {
        now: () => clock.now,
        setTimer: (run, ms) => {
            const id = nextId++;
            pending.set(id, { run, at: clock.now + ms });
            return id;
        },
        clearTimer: (id) => pending.delete(id as number),
        overlayOpen: () => false,
        openPanel: () => {},
        readShared: () => shared.stored,
        writeShared: (next) => {
            shared.stored = next;
        },
    };
    const hub = new BrokkHub(deps);
    const advance = (ms: number) => {
        const target = clock.now + ms;
        for (;;) {
            const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at);
            if (due.length === 0) {
                break;
            }
            const [id, timer] = due[0];
            pending.delete(id);
            clock.now = Math.max(clock.now, timer.at);
            timer.run();
        }
        clock.now = target;
    };
    hub.markReady();
    return { hub, clock, advance, shared };
}

function notice(id: string, blockid: string): MoltentermNotification {
    return { id, blockid, source: "agent", kind: "warning", title: id, time: T, updated: T, read: false } as any;
}

describe("what is in view (source-in-view.ts)", () => {
    it("knows an agent's pane, a finished agent and a pull request's project, only in the active view", () => {
        const view: AgentSeenView = { ...showsA, prDirs: ["C:\\work\\app"] };
        expect(eventSourceInView("agent:blockA", view)).toBe(true);
        expect(eventSourceInView("finished:blockB", view)).toBe(true);
        expect(eventSourceInView("agent:blockC", view)).toBe(false);
        expect(eventSourceInView("ci:C:\\work\\app:12", view)).toBe(true);
        expect(eventSourceInView("ready:/other:3", view)).toBe(false);
        expect(eventSourceInView("download:x", view)).toBe(false);
        expect(eventSourceInView("agent:blockA", { ...view, active: false })).toBe(false);
        expect(notificationInView({ blockid: "blockA" }, view)).toBe(true);
        expect(notificationInView({ blockid: "blockA" }, unfocused)).toBe(false);
        expect(notificationInView({}, view)).toBe(false);
    });
});

describe("AC-1: the agent waits while its pane is in view", () => {
    it("he does not come and the sidebar does not move, but the badge counts it", () => {
        const { hub } = fixture();
        hub.inView(showsA);
        hub.feed(Source, [waiting]);
        const view = hub.getView();
        expect(view.visit).toBeNull();
        expect(view.cue).toBe(false);
        expect(view.badge).toBe(1);
        expect(view.badgeKeys).toEqual(["agent:blockA"]);
        expect(view.comingKeys).toEqual([]);
        expect(view.heldKeys).toEqual(["agent:blockA"]);
        const ready = edgeNewsAfter(NoNews, [], [], false, true);
        const step = edgeNewsAfter(ready.news, view.badgeKeys, view.comingKeys, false, true, view.heldKeys);
        expect(step.fresh).toBe(false);
    });

    it("folds a visit that is up when the developer brings the pane into view", () => {
        const { hub } = fixture();
        hub.inView(showsOther);
        hub.feed(Source, [waiting]);
        expect(hub.getView().visit).not.toBeNull();
        hub.inView(showsA);
        expect(hub.getView().visit).toBeNull();
    });

    it("toasts nothing for a notification of a pane in view, and the rest as before", () => {
        const entries = [notice("n1", "blockA"), notice("n2", "blockC")];
        const ids = new Set(["n1", "n2"]);
        expect(toastsToShow(entries, ids, showsA).map((e) => e.id)).toEqual(["n2"]);
        expect(toastsToShow(entries, ids, unfocused).map((e) => e.id)).toEqual(["n1", "n2"]);
    });
});

describe("AC-2: the pane is in another view, or the window is not focused", () => {
    it("he comes as today", () => {
        for (const view of [showsOther, unfocused]) {
            const { hub } = fixture();
            hub.inView(view);
            hub.feed(Source, [waiting]);
            expect(hub.getView().visit?.keys).toEqual(["agent:blockA"]);
            expect(hub.getView().comingKeys).toEqual(["agent:blockA"]);
            expect(hub.getView().heldKeys).toEqual([]);
        }
    });
});

describe("AC-3: the developer leaves the view while the agent still waits", () => {
    it("he comes once, about a minute after, as if it had just arrived", () => {
        const { hub, advance } = fixture();
        hub.inView(showsA);
        hub.feed(Source, [waiting]);
        advance(5 * Min);
        expect(hub.getView().visit).toBeNull();
        hub.inView(showsOther);
        expect(hub.getView().visit).toBeNull();
        advance(LeftViewDelayMs - 1000);
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().heldKeys).toEqual(["agent:blockA"]);
        advance(1000);
        expect(hub.getView().visit?.keys).toEqual(["agent:blockA"]);
        expect(hub.getView().comingKeys).toEqual(["agent:blockA"]);
        hub.open();
        // Until it turns grave (15 min of waiting), which is told again as before.
        advance(2 * Min);
        expect(hub.getView().visit).toBeNull();
    });

    it("the sidebar moves for it once it is let go", () => {
        const before = edgeNewsAfter(edgeNewsAfter(NoNews, [], [], false, true).news, ["k"], [], false, true, ["k"]);
        expect(before.fresh).toBe(false);
        const after = edgeNewsAfter(before.news, ["k"], ["k"], false, true, []);
        expect(after.fresh).toBe(true);
        expect(edgeNewsAfter(after.news, ["k"], ["k"], false, true, []).fresh).toBe(false);
    });

    it("nothing comes when the developer acted before leaving", () => {
        const { hub, advance } = fixture();
        hub.inView(showsA);
        hub.feed(Source, [waiting]);
        advance(Min);
        hub.feed(Source, []);
        hub.inView(showsOther);
        advance(10 * Min);
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().badge).toBe(0);
    });

    it("another view or window holds it too while the source is in view, and lets it go after the delay", () => {
        const shared = { stored: EmptyShared };
        const front = fixture(shared);
        front.hub.inView(showsA);
        front.hub.feed(Source, [waiting]);
        const other = fixture(shared);
        other.hub.inView(unfocused);
        other.hub.sharedChanged(shared.stored);
        other.hub.feed(Source, [waiting]);
        expect(other.hub.getView().visit).toBeNull();
        // The front view keeps renewing its hold while the pane stays shown.
        for (let i = 0; i < 6; i++) {
            front.advance(20_000);
            other.clock.now = front.clock.now;
            other.hub.sharedChanged(shared.stored);
            expect(other.hub.getView().visit).toBeNull();
        }
        // The front window closes: its last hold ends by itself, within a minute.
        other.advance(LeftViewDelayMs);
        expect(other.hub.getView().visit?.keys).toEqual(["agent:blockA"]);
    });
});
