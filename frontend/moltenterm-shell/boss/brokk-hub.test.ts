// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import type { ToHandleItem } from "./boss-to-handle-model";
import { AfterActionMs, AfterLeaveMs } from "./brokk-gate";
import type { PanelId } from "./brokk-group-model";
import { BrokkHub, HubDeps, OverlayPollMs } from "./brokk-hub";
import { visitPanelOf } from "./brokk-visit";
import { BrokkEvent, DefaultVisitSettings, VisitSettings } from "./brokk-visit-events";
import { visitLineOf } from "./brokk-visit-line";
import { EmptyShared, readShared, sharedText, SharedVisit } from "./brokk-visit-share";

// Every test moves the clock by hand and runs the timers the hub set: nothing here waits for real time. 14:00 on the
// local clock, so that the default quiet hours (22:00 to 08:00) are far away.
const T = new Date(2026, 10, 6, 14, 0, 0).getTime();
const Min = 60_000;

type Fixture = {
    hub: BrokkHub;
    clock: { now: number };
    state: { overlay: boolean; panels: number; opened: PanelId[]; stored: SharedVisit; writes: number };
    advance: (ms: number) => void;
    timers: () => number;
};

function fixture(shared: { stored: SharedVisit } = null, start: number = T): Fixture {
    const clock = { now: start };
    const pending = new Map<number, { run: () => void; at: number }>();
    let nextId = 1;
    const state = {
        overlay: false,
        panels: 0,
        opened: [] as PanelId[],
        stored: shared?.stored ?? EmptyShared,
        writes: 0,
    };
    const deps: HubDeps = {
        now: () => clock.now,
        setTimer: (run, ms) => {
            const id = nextId++;
            pending.set(id, { run, at: clock.now + ms });
            return id;
        },
        clearTimer: (id) => pending.delete(id as number),
        overlayOpen: () => state.overlay,
        openPanel: (panel) => {
            state.panels++;
            state.opened.push(panel);
        },
        readShared: () => (shared == null ? state.stored : shared.stored),
        writeShared: (next) => {
            state.stored = next;
            state.writes++;
            if (shared != null) {
                shared.stored = next;
            }
        },
    };
    const hub = new BrokkHub(deps);
    // Runs the timers that fall due, in order, as the clock reaches them.
    const advance = (ms: number) => {
        const target = clock.now + ms;
        for (;;) {
            const due = [...pending.entries()]
                .filter(([, timer]) => timer.at <= target)
                .sort((a, b) => a[1].at - b[1].at);
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
    return { hub, clock, state, advance, timers: () => pending.size };
}

function row(key: string, tone: ToHandleItem["tone"], since: number): ToHandleItem {
    return {
        key,
        tone,
        notice: null,
        lineFromNotice: false,
        name: key,
        line: { text: key },
        place: "",
        since,
        rank: 1,
        seen: false,
        actions: [],
    };
}

// An agent that has waited for the developer for 6 minutes: past the 5 min threshold, so he comes.
const BlockedRow = () => row("agent:a", "waiting", T - 6 * Min);
const ErrorRow = () => row("agent:b", "error", T - 1 * Min);

function settings(coming: Partial<VisitSettings["coming"]>, rest: Partial<VisitSettings> = {}): VisitSettings {
    return { ...DefaultVisitSettings, coming: { ...DefaultVisitSettings.coming, ...coming }, ...rest };
}

function agent(blockid: string, state: AgentStateInfo["state"]): AgentStateInfo {
    return { blockid, agent: "claude", firstname: blockid, state, version: 1, since: 1 };
}

function states(...infos: AgentStateInfo[]): AgentStatesData {
    return { states: Object.fromEntries(infos.map((info) => [info.blockid, info])), versions: {} };
}

describe("the scene opens only when the gate is open (FR-BOSS-009, AC8, #2002)", () => {
    it("opens at once when nothing in the sidebar holds him", () => {
        const { hub } = fixture();
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().visit?.severity).toBe("important");
        expect(hub.getView().visit?.expression).toBe("doubtful");
    });

    it("never opens under the pointer, however long it stays, and carries the soft cue meanwhile", () => {
        const { hub, advance } = fixture();
        hub.gate({ type: "enter" });
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().cue).toBe(true);
        advance(60 * Min);
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().cue).toBe(true);
    });

    it("opens 1 s after the pointer left, on its own, and not a moment before", () => {
        const { hub, advance } = fixture();
        hub.gate({ type: "enter" });
        hub.syncRows([BlockedRow()]);
        hub.gate({ type: "leave" });
        advance(AfterLeaveMs - 1);
        expect(hub.getView().visit).toBeNull();
        advance(1);
        expect(hub.getView().visit).not.toBeNull();
        expect(hub.getView().cue).toBe(false);
    });

    it("opens 2 s after the last click, scroll, key or drag in the sidebar", () => {
        const { hub, advance } = fixture();
        hub.gate({ type: "act" });
        hub.syncRows([BlockedRow()]);
        advance(AfterActionMs - 1);
        expect(hub.getView().visit).toBeNull();
        advance(1);
        expect(hub.getView().visit).not.toBeNull();

        const dragged = fixture();
        dragged.hub.gate({ type: "dragstart" });
        dragged.hub.syncRows([BlockedRow()]);
        dragged.advance(10 * Min);
        expect(dragged.hub.getView().visit).toBeNull();
        dragged.hub.gate({ type: "dragend" });
        dragged.advance(AfterActionMs);
        expect(dragged.hub.getView().visit).not.toBeNull();
    });

    it("waits while the search field has the focus", () => {
        const { hub, advance } = fixture();
        hub.gate({ type: "search", focused: true });
        hub.syncRows([BlockedRow()]);
        advance(10 * Min);
        expect(hub.getView().visit).toBeNull();
        hub.gate({ type: "search", focused: false });
        advance(AfterActionMs);
        expect(hub.getView().visit).not.toBeNull();
    });

    it("waits while a menu or a dialog is open, looks again by itself, and opens when it closes", () => {
        const { hub, state, advance } = fixture();
        state.overlay = true;
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().visit).toBeNull();
        advance(OverlayPollMs * 20);
        expect(hub.getView().visit).toBeNull();
        state.overlay = false;
        advance(OverlayPollMs);
        expect(hub.getView().visit).not.toBeNull();
    });

    it("waits while the sidebar is not on screen, and opens once it shows (AC14)", () => {
        const { hub, advance } = fixture();
        hub.gate({ type: "hidden", hidden: true });
        hub.syncRows([BlockedRow()]);
        advance(60 * Min);
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().cue).toBe(true);
        hub.gate({ type: "hidden", hidden: false });
        expect(hub.getView().visit).not.toBeNull();
    });

    it("waits through the quiet hours without a cue, and comes when they end", () => {
        const night = new Date(2026, 10, 6, 22, 30, 0).getTime();
        const quiet = fixture(null, night);
        quiet.hub.syncRows([row("agent:a", "waiting", night - 6 * Min)]);
        expect(quiet.hub.getView().visit).toBeNull();
        expect(quiet.hub.getView().cue).toBe(false);
        quiet.advance(10 * 60 * Min);
        expect(quiet.hub.getView().visit).not.toBeNull();
    });

    it("does not come for a wait that has not reached the threshold yet, and comes when it does", () => {
        const { hub, advance } = fixture();
        hub.syncRows([row("agent:a", "waiting", T - 1 * Min)]);
        expect(hub.getView().visit).toBeNull();
        advance(4 * Min - 1);
        expect(hub.getView().visit).toBeNull();
        advance(2);
        expect(hub.getView().visit).not.toBeNull();
    });

    it("never comes when the master switch is on, and the badge still counts", () => {
        const { hub } = fixture();
        hub.settings(settings({}, { never: true }));
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().badge).toBe(1);
    });
});

describe("what the sources raise and cancel", () => {
    it("takes his face from the gravest event waiting", () => {
        const { hub } = fixture();
        hub.settings(settings({ error: "vient" }));
        hub.syncRows([BlockedRow(), ErrorRow()]);
        expect(hub.getView().visit?.keys).toEqual(["agent:a", "agent:b"]);
        expect(hub.getView().visit?.severity).toBe("important");
    });

    it("cancels the visit when the developer handled the row elsewhere", () => {
        const { hub } = fixture();
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().visit).not.toBeNull();
        hub.syncRows([]);
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().badge).toBe(0);
    });

    it("leaves out a row the developer has seen, and a row that is no event of the table", () => {
        const { hub } = fixture();
        hub.syncRows([{ ...BlockedRow(), seen: true }, row("handoff:x", "waiting", T - 9 * Min)]);
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().badge).toBe(0);
    });

    it("counts an agent that finished on the badge only, until it works again", () => {
        const { hub } = fixture();
        hub.agents(states(agent("a", "working")));
        expect(hub.getView().badge).toBe(0);
        hub.agents(states(agent("a", "done")));
        expect(hub.getView().badge).toBe(1);
        expect(hub.getView().visit).toBeNull();
        hub.agents(states(agent("a", "working")));
        expect(hub.getView().badge).toBe(0);
    });

    it("does not count an agent that was done before the first reading", () => {
        const { hub } = fixture();
        hub.agents(states(agent("a", "done")));
        expect(hub.getView().badge).toBe(0);
    });

    // The defect of #2203: Bérénice finished, the Notifications panel held her Done card and nothing else, yet he came
    // saying "1 thing to handle" and his panel had nothing to handle. The Done card is already in the notifications: it
    // counts on the badge, whatever the setting says, and never brings him.
    it("never brings a visit for a finished agent, even set to Vient: its Done card is in the notifications", () => {
        const { hub } = fixture();
        hub.settings(settings({ finished: "vient" }));
        hub.agents(states(agent("berenice", "working")));
        hub.agents(states(agent("berenice", "done")));
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().badge).toBe(1);
        expect(hub.getView().comingKeys).toEqual([]);
        expect(hub.getView().cue).toBe(false);
    });

    it("still brings him for what is graver while a finished agent waits on the badge", () => {
        const { hub } = fixture();
        hub.settings(settings({ finished: "vient" }));
        hub.agents(states(agent("berenice", "working")));
        hub.agents(states(agent("berenice", "done")));
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().visit?.keys).toEqual(["agent:a"]);
        expect(hub.getView().visit?.count).toBe(1);
        expect(hub.getView().badge).toBe(2);
    });

    it("forgets the finished agents when his panel opens", () => {
        const { hub } = fixture();
        hub.agents(states(agent("a", "working")));
        hub.agents(states(agent("a", "done")));
        hub.panelOpened();
        expect(hub.getView().badge).toBe(0);
        hub.agents(states(agent("a", "done")));
        expect(hub.getView().badge).toBe(0);
    });

    it("counts nothing for an event set to Rien", () => {
        const { hub } = fixture();
        hub.settings(settings({ blocked: "rien" }));
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().badge).toBe(0);
        expect(hub.getView().visit).toBeNull();
    });
});

// FR-BOSS-009, AC79 (#2203): every unfold leads to an open panel that names the reason, and the words and the count of the
// scene are the visit's own, never a count of "things to handle" that no panel holds.
describe("every unfold names its reason (AC79)", () => {
    const AllVient = settings({
        security: "vient",
        blocked: "vient",
        error: "vient",
        ci: "vient",
        ready: "vient",
        download: "vient",
        update: "vient",
        usage: "vient",
    });
    const Quick = (kind: BrokkEvent["kind"], key: string): BrokkEvent => ({ key, kind, since: T - 10 * Min });
    const sources: { name: string; feed: (hub: BrokkHub) => void; panel: PanelId; rows?: ToHandleItem[] }[] = [
        { name: "an agent that waits", feed: (hub) => hub.syncRows([BlockedRow()]), panel: "notifications" },
        { name: "an agent in error", feed: (hub) => hub.syncRows([ErrorRow()]), panel: "notifications" },
        {
            name: "a failing CI",
            feed: (hub) => hub.syncRows([row("ci:/p:12", "error", T - Min)]),
            panel: "notifications",
        },
        {
            name: "a pull request ready",
            feed: (hub) => hub.syncRows([row("ready:/p:14", "success", T - Min)]),
            panel: "notifications",
        },
        {
            name: "a download",
            feed: (hub) => hub.feed("downloads", [Quick("downloadfailed", "download:1")]),
            panel: "downloads",
        },
        {
            name: "the update on offer",
            feed: (hub) => hub.feed("update", [Quick("update", "update:2.0.0")]),
            panel: "notifications",
        },
        { name: "a plan reading", feed: (hub) => hub.feed("usage", [Quick("usage", "usage:claude")]), panel: null },
    ];

    for (const source of sources) {
        it(`${source.name}: the scene names it and counts it, and the click opens the panel that holds it`, () => {
            const { hub, state } = fixture();
            hub.settings(AllVient);
            source.feed(hub);
            const visit = hub.getView().visit;
            expect(visit, "he unfolds").not.toBeNull();
            expect(visit.count).toBe(1);
            expect(visit.keys).toHaveLength(1);
            expect(hub.getView().badge).toBeGreaterThanOrEqual(visit.count);
            const words = JSON.stringify(visitLineOf(visit, [BlockedRow(), ErrorRow()], T));
            expect(words).not.toContain("toHandle");
            expect(visitPanelOf(visit)).toBe(source.panel);
            hub.open();
            expect(state.opened).toEqual([source.panel]);
        });
    }

    it("counts the events of the visit, all of them, and no other: the line says the first and 'and N more'", () => {
        const { hub } = fixture();
        hub.settings(AllVient);
        hub.syncRows([BlockedRow()]);
        hub.feed("downloads", [Quick("downloadfailed", "download:1")]);
        hub.feed("update", [Quick("update", "update:2.0.0")]);
        const visit = hub.getView().visit;
        expect(visit.count).toBe(3);
        const line = visitLineOf(visit, [BlockedRow()], T);
        expect(line.text).toMatch(/ and 2 more$/);
    });

    it("never unfolds for a Done card alone, however it is set, and still counts it on the badge", () => {
        const { hub, state } = fixture();
        hub.settings(AllVient);
        hub.agents(states(agent("berenice", "working")));
        hub.agents(states(agent("berenice", "done")));
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().badge).toBe(1);
        hub.open();
        expect(state.opened).toEqual([null]);
    });

    it("asks no panel of its own for the example, which has no reason in any panel", () => {
        const { hub, state } = fixture();
        hub.showExample();
        hub.open();
        expect(state.opened).toEqual([null]);
    });
});

describe("a click on the scene folds it and opens his panel (AC6)", () => {
    it("is one gesture: the panel opens once, the scene is gone, what waited is told", () => {
        const { hub, state, advance } = fixture();
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().visit).not.toBeNull();
        hub.open();
        expect(state.panels).toBe(1);
        expect(hub.getView().visit).toBeNull();
        advance(8 * Min);
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().badge).toBe(1);
    });

    it("tells him again only when it grows graver", () => {
        const { hub, advance } = fixture();
        hub.syncRows([BlockedRow()]);
        hub.open();
        // The row began 6 min ago: it turns grave at 3 times the 5 min threshold, 9 min from now.
        advance(9 * Min - 1);
        expect(hub.getView().visit).toBeNull();
        advance(1);
        expect(hub.getView().visit?.severity).toBe("grave");
        expect(hub.getView().visit?.expression).toBe("frown");
    });

    it("also tells what waited when the panel was opened some other way", () => {
        const { hub, state } = fixture();
        hub.syncRows([BlockedRow()]);
        hub.panelOpened();
        expect(state.panels).toBe(0);
        expect(hub.getView().visit).toBeNull();
    });

    it("waits while the panel is open, and looks again when it closes", () => {
        const { hub, state } = fixture();
        state.overlay = true;
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().visit).toBeNull();
        state.overlay = false;
        hub.wake();
        expect(hub.getView().visit).not.toBeNull();
    });
});

describe("Plus tard (AC7)", () => {
    it("keeps him away for the delay, whatever arrives, and he comes once for everything", () => {
        const { hub, advance } = fixture();
        hub.syncRows([BlockedRow()]);
        hub.later("15min");
        expect(hub.getView().visit).toBeNull();
        hub.syncRows([BlockedRow(), ErrorRow()]);
        hub.settings(settings({ error: "vient" }));
        advance(15 * Min - 1);
        expect(hub.getView().visit).toBeNull();
        advance(1);
        expect(hub.getView().visit?.count).toBe(2);
    });

    it("takes the default delay of the severity on Escape", () => {
        const important = fixture();
        important.hub.syncRows([BlockedRow()]);
        important.hub.later("escape");
        important.advance(15 * Min - 1);
        expect(important.hub.getView().visit).toBeNull();
        important.advance(1);
        expect(important.hub.getView().visit).not.toBeNull();

        const grave = fixture();
        grave.hub.syncRows([row("agent:a", "waiting", T - 16 * Min)]);
        expect(grave.hub.getView().visit?.severity).toBe("grave");
        grave.hub.later("escape");
        grave.advance(5 * Min - 1);
        expect(grave.hub.getView().visit).toBeNull();
        grave.advance(1);
        expect(grave.hub.getView().visit).not.toBeNull();
    });

    it("does nothing when no scene is up", () => {
        const { hub, state } = fixture();
        hub.later("1h");
        expect(hub.getView().laterUntil).toBe(0);
        expect(state.writes).toBe(0);
    });
});

describe("what the views of this computer share (#2002)", () => {
    it("folds the scene of a second view when the first pushed him back", () => {
        const shared = { stored: EmptyShared };
        const first = fixture(shared);
        const second = fixture(shared);
        first.hub.syncRows([BlockedRow()]);
        second.hub.syncRows([BlockedRow()]);
        expect(second.hub.getView().visit).not.toBeNull();
        first.hub.later("1h");
        second.hub.sharedChanged(readShared(sharedText(shared.stored), T));
        expect(second.hub.getView().visit).toBeNull();
        expect(second.hub.getView().laterUntil).toBe(T + 60 * Min);
    });

    it("does not play a visit again in a view that starts after the developer pushed him back", () => {
        const shared = { stored: EmptyShared };
        const first = fixture(shared);
        first.hub.syncRows([BlockedRow()]);
        first.hub.later("1h");
        const second = fixture(shared);
        second.hub.syncRows([BlockedRow()]);
        expect(second.hub.getView().visit).toBeNull();
        second.advance(60 * Min);
        expect(second.hub.getView().visit).not.toBeNull();
    });

    it("does not tell again in a second view what the first one told", () => {
        const shared = { stored: EmptyShared };
        const first = fixture(shared);
        const second = fixture(shared);
        first.hub.syncRows([BlockedRow()]);
        second.hub.syncRows([BlockedRow()]);
        first.hub.open();
        second.hub.sharedChanged(readShared(sharedText(shared.stored), T));
        expect(second.hub.getView().visit).toBeNull();
        const third = fixture(shared);
        third.hub.syncRows([BlockedRow()]);
        expect(third.hub.getView().visit).toBeNull();
    });

    it("brings him again when the same agent waits again, after the developer answered it", () => {
        const shared = { stored: EmptyShared };
        const { hub, advance } = fixture(shared);
        hub.syncRows([BlockedRow()]);
        hub.open();
        expect(hub.getView().visit).toBeNull();
        // The developer answered the agent: the wait ends. The same agent, the same key, waits again later.
        hub.syncRows([]);
        advance(Min);
        hub.syncRows([{ ...BlockedRow(), since: T + Min - 6 * Min }]);
        expect(hub.getView().visit).not.toBeNull();
    });

    it("brings him again in a second view too, whichever view saw the wait end first", () => {
        const shared = { stored: EmptyShared };
        const first = fixture(shared);
        const second = fixture(shared);
        first.hub.syncRows([BlockedRow()]);
        second.hub.syncRows([BlockedRow()]);
        first.hub.open();
        second.hub.sharedChanged(readShared(sharedText(shared.stored), T));
        expect(second.hub.getView().visit).toBeNull();
        first.hub.syncRows([]);
        second.hub.sharedChanged(readShared(sharedText(shared.stored), T));
        second.hub.syncRows([]);
        const again = [{ ...BlockedRow(), since: T - 6 * Min }];
        second.hub.syncRows(again);
        first.hub.syncRows(again);
        expect(second.hub.getView().visit).not.toBeNull();
        expect(first.hub.getView().visit).not.toBeNull();
    });

    it("tells an agent again that changed from waiting to failing: it is another event", () => {
        const shared = { stored: EmptyShared };
        const { hub } = fixture(shared);
        hub.settings(settings({ error: "vient" }));
        hub.syncRows([BlockedRow()]);
        hub.open();
        expect(hub.getView().visit).toBeNull();
        hub.syncRows([row("agent:a", "error", T)]);
        expect(hub.getView().visit?.expression).toBe("doubtful");
    });

    it("writes nothing when nothing changed for the other views", () => {
        const { hub, state } = fixture();
        hub.syncRows([BlockedRow()]);
        hub.syncRows([BlockedRow()]);
        hub.gate({ type: "enter" });
        expect(state.writes).toBe(0);
    });
});

describe("the view is stable", () => {
    it("returns the very same view while nothing changes, and tells the listeners only when it does", () => {
        const { hub } = fixture();
        let heard = 0;
        hub.subscribe(() => heard++);
        const before = hub.getView();
        hub.gate({ type: "overlay", open: false });
        hub.syncRows([]);
        hub.agents(states());
        expect(hub.getView()).toBe(before);
        expect(heard).toBe(0);
        hub.syncRows([BlockedRow()]);
        expect(hub.getView()).not.toBe(before);
        expect(heard).toBeGreaterThan(0);
    });

    it("sets no timer once stopped, and none while nothing waits", () => {
        const { hub, timers } = fixture();
        expect(timers()).toBe(0);
        hub.syncRows([BlockedRow()]);
        hub.stop();
        hub.syncRows([]);
        expect(timers()).toBe(0);
    });
});

describe("Show a visit: the example of the settings (FR-BOSS-009, AC31 and AC32, #2079)", () => {
    // 14:00 is inside these quiet hours, and the master switch is on: nothing real would come now.
    const HeldBack = () => settings({}, { quiet: { on: true, from: 13 * 60, to: 15 * 60 }, never: true });

    it("comes up whatever the quiet hours and the master switch say", () => {
        const { hub } = fixture();
        hub.settings(HeldBack());
        hub.showExample();
        expect(hub.getView().visit).toMatchObject({ example: true, severity: "important", expression: "doubtful" });
        hub.closeExample();
        expect(hub.getView().visit).toBeNull();
    });

    it("changes no notification and records no visit: no mark, no delay, no panel, no write, the badge as it was", () => {
        const { hub, state } = fixture();
        hub.syncRows([BlockedRow()]);
        const badge = hub.getView().badge;
        const writes = state.writes;
        hub.showExample();
        hub.closeExample();
        expect(hub.getView().badge).toBe(badge);
        expect(state.writes).toBe(writes);
        expect(state.panels).toBe(0);
        expect(hub.getModel().visits.told).toEqual({});
        expect(hub.getModel().visits.laterUntil).toBe(0);
        expect(hub.getModel().visits.events["agent:a"]).toBeDefined();
    });

    it("leaves the state as before: a real visit that was up is up again once the example folds", () => {
        const { hub } = fixture();
        hub.syncRows([BlockedRow()]);
        const real = hub.getView().visit;
        expect(real).not.toBeNull();
        hub.showExample();
        expect(hub.getView().visit?.example).toBe(true);
        expect(hub.getModel().visits.shown).toBe(true);
        hub.closeExample();
        expect(hub.getView().visit).toEqual(real);
    });

    it("tells the listeners once when it comes up and once when it folds, and nothing for a second close", () => {
        const { hub } = fixture();
        let heard = 0;
        hub.subscribe(() => heard++);
        hub.showExample();
        hub.showExample();
        expect(heard).toBe(1);
        hub.closeExample();
        hub.closeExample();
        expect(heard).toBe(2);
    });
});

describe("Brokk off means off (FR-BOSS-009, #2218)", () => {
    it("raises no visit for an agent that reaches the threshold after he was turned off", () => {
        const { hub, advance, timers } = fixture();
        hub.syncRows([row("agent:a", "waiting", T - 1 * Min)]);
        expect(timers()).toBeGreaterThan(0);
        hub.power(false);
        expect(timers()).toBe(0);
        advance(10 * Min);
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().cue).toBe(false);
        expect(hub.getView().comingKeys).toEqual([]);
    });

    it("raises nothing for an event that comes while he is off, held back or not", () => {
        const { hub, advance, timers } = fixture();
        hub.power(false);
        hub.gate({ type: "enter" });
        hub.syncRows([BlockedRow(), ErrorRow()]);
        expect(hub.getView().cue).toBe(false);
        hub.gate({ type: "leave" });
        advance(60 * Min);
        expect(hub.getView().visit).toBeNull();
        expect(timers()).toBe(0);
    });

    it("folds the visit that is up and tells the listeners", () => {
        const { hub } = fixture();
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().visit).not.toBeNull();
        let heard = 0;
        hub.subscribe(() => heard++);
        hub.power(false);
        expect(hub.getView().visit).toBeNull();
        expect(heard).toBe(1);
    });

    it("folds the example of the settings too", () => {
        const { hub } = fixture();
        hub.showExample();
        hub.power(false);
        expect(hub.getView().visit).toBeNull();
    });

    it("keeps the badge's keys current for the rail while he is off", () => {
        const { hub } = fixture();
        hub.power(false);
        hub.syncRows([BlockedRow(), ErrorRow()]);
        expect(hub.getView().badgeKeys).toEqual(["agent:a", "agent:b"]);
        hub.syncRows([ErrorRow()]);
        expect(hub.getView().badgeKeys).toEqual(["agent:b"]);
    });

    it("keeps the developer's settings: they apply again once he is back on", () => {
        const { hub } = fixture();
        hub.power(false);
        hub.settings(settings({ blocked: "badge", error: "vient" }));
        hub.syncRows([BlockedRow(), ErrorRow()]);
        expect(hub.getView().visit).toBeNull();
        hub.power(true);
        expect(hub.getModel().settings.never).toBe(false);
        expect(hub.getView().visit?.keys).toEqual(["agent:b"]);
    });

    it("leaves the master switch of the settings as the developer set it", () => {
        const { hub } = fixture();
        hub.settings(settings({}, { never: true }));
        hub.power(false);
        hub.power(true);
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().visit).toBeNull();
    });
});
