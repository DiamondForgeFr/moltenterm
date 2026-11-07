// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The hub of Brokk's visits for one view (FR-BOSS-009, AC5 to AC8, AC11, AC14, #2002): it owns the visit model
// (brokk-visit.ts) and drives it. The sources tell it what happens (the rows To handle, the agent states, the settings,
// the sidebar's pointer and focus), the surface reads its view, and the hub does the rest: it keeps the model's clock
// (it sets a timer for the moment the model asks to be woken), asks whether a menu or a dialog is open before each step,
// and shares with the other views of this computer what was told and what was pushed back with Plus tard.
//
// It knows no surface and no store: everything outside is handed in, and the clock and the timers are too, so the rules
// are tested without a wait. It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import type { AgentStatesData } from "../agent-state-model";
import type { ToHandleItem } from "./boss-to-handle-model";
import { GateEvent, gateHold } from "./brokk-gate";
import { finishedSetAfter } from "./brokk-hub-feed";
import {
    brokkAfter,
    BrokkInput,
    BrokkModel,
    BrokkStep,
    BrokkView,
    ExampleVisit,
    InitialBrokk,
    SnoozeChoiceId,
    Visit,
    VisitState,
} from "./brokk-visit";
import type { BrokkEvent, VisitSettings } from "./brokk-visit-events";
import { adoptInto, forgetIn, mergeShared, publishOf, SharedVisit } from "./brokk-visit-share";
import { visitEventsOfRows } from "./brokk-watch";

export const RowsSource = "rows";
export const FinishedSource = "finished";

// While a visit waits on a menu or a dialog, only the end of that menu can let it in, and nothing tells the hub: it
// looks again this often.
export const OverlayPollMs = 500;

const MaxTimerMs = 2 ** 31 - 1;

export type HubDeps = {
    now: () => number;
    setTimer: (run: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
    // A menu or a dialog is open, or his panel is: he does not come then.
    overlayOpen: () => boolean;
    // Shows his panel.
    openPanel: () => void;
    readShared: () => SharedVisit;
    writeShared: (shared: SharedVisit) => void;
};

function sameVisit(a: BrokkView["visit"], b: BrokkView["visit"]): boolean {
    if (a === b) {
        return true;
    }
    return (
        a != null &&
        b != null &&
        a.severity === b.severity &&
        a.count === b.count &&
        a.keys.join("\n") === b.keys.join("\n")
    );
}

// The same answer in other words: the view is kept as it was, so that no one draws again for it.
function sameView(a: BrokkView, b: BrokkView): boolean {
    return (
        sameVisit(a.visit, b.visit) &&
        a.cue === b.cue &&
        a.mayArrive === b.mayArrive &&
        a.badge === b.badge &&
        a.laterUntil === b.laterUntil
    );
}

// The events that were there and are not any more, or are another kind of event under the same key (an agent that waited
// and now failed): what was told of them does not hold for what comes next.
function endedKeys(before: VisitState, after: VisitState): string[] {
    return Object.keys(before.events).filter(
        (key) => after.events[key] == null || after.events[key].event.kind !== before.events[key].event.kind
    );
}

export class BrokkHub {
    private model: BrokkModel = InitialBrokk;
    // What the model answers, and what the surfaces read: the same, unless the example visit of the settings is up.
    private answer: BrokkView;
    private view: BrokkView;
    private example: Visit = null;
    private shared: SharedVisit;
    private finished: BrokkEvent[] = [];
    private agentsBefore: AgentStatesData = null;
    private wakeTimer: unknown = null;
    private pollTimer: unknown = null;
    private listeners = new Set<() => void>();
    private stopped = false;
    private deps: HubDeps;

    constructor(deps: HubDeps) {
        this.deps = deps;
        this.shared = deps.readShared();
        this.answer = brokkAfter(InitialBrokk, { type: "tick" }, deps.now()).view;
        this.view = this.answer;
        this.run({ type: "tick" });
    }

    getView = (): BrokkView => this.view;

    // "Show a visit" in the settings (FR-BOSS-009, AC31 and AC32, #2079): the example scene comes up whatever the quiet
    // hours, the switch and the pointer say. Nothing else moves: no event, no mark, no delay, no panel.
    showExample(): void {
        this.setExample(ExampleVisit);
    }

    // The scene folds: the example goes, and the visit the model holds (if any) is what the surfaces read again.
    closeExample(): void {
        this.setExample(null);
    }

    getModel = (): BrokkModel => this.model;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    settings(settings: VisitSettings): void {
        this.run({ type: "settings", settings });
    }

    // The rows To handle that can bring him: the whole set, whatever changed (an event that is gone is cancelled).
    syncRows(items: ToHandleItem[]): void {
        this.run({ type: "sync", source: RowsSource, events: visitEventsOfRows(items) });
    }

    // A source of events that is neither the rows nor the agents: the downloads, the update notice, the plan usage
    // (brokk-extra-feeds.ts). The whole set the source holds, whatever changed.
    feed(source: string, events: BrokkEvent[]): void {
        this.run({ type: "sync", source, events });
    }

    // The agent states, read once the first reading is in: who finished stays a good news for the badge.
    agents(data: AgentStatesData): void {
        const finished = finishedSetAfter(this.finished, this.agentsBefore, data, this.deps.now());
        this.agentsBefore = data;
        if (finished === this.finished) {
            return;
        }
        this.finished = finished;
        this.run({ type: "sync", source: FinishedSource, events: finished });
    }

    gate(event: GateEvent): void {
        this.run({ type: "gate", event });
    }

    later(choice: SnoozeChoiceId | "escape"): void {
        this.run({ type: "later", choice });
    }

    // His panel is open, wherever the developer opened it from: what waited is told, and the good news is heard.
    panelOpened(): void {
        this.finished = [];
        this.run({ type: "open" });
        this.run({ type: "sync", source: FinishedSource, events: [] });
    }

    // A click on the scene or the avatar, or Enter or Space on them: he folds back and his panel opens in one gesture.
    open(): void {
        this.panelOpened();
        this.deps.openPanel();
    }

    // Another view or window changed what is shared.
    sharedChanged(next: SharedVisit): void {
        this.shared = mergeShared(this.shared, next, this.deps.now());
        this.run({ type: "tick" });
    }

    // The time passed on its own: the store calls it when it has a reason to look again (a menu closed).
    wake(): void {
        this.run({ type: "tick" });
    }

    stop(): void {
        this.stopped = true;
        this.deps.clearTimer(this.wakeTimer);
        this.deps.clearTimer(this.pollTimer);
        this.wakeTimer = null;
        this.pollTimer = null;
        this.listeners.clear();
    }

    private run(input: BrokkInput): void {
        if (this.stopped) {
            return;
        }
        const now = this.deps.now();
        let model = this.model;
        const overlay = this.deps.overlayOpen();
        if (overlay !== model.gate.overlayOpen) {
            model = brokkAfter(model, { type: "gate", event: { type: "overlay", open: overlay } }, now).model;
        }
        let step = brokkAfter(model, input, now);
        // What was told of an event that ended is forgotten for every view: the same agent waiting again is a new event.
        const ended = endedKeys(this.model.visits, step.model.visits);
        const shared = ended.length > 0 ? forgetIn(this.shared, ended, now) : this.shared;
        const adopted = adoptInto(step.model.visits, shared, now);
        if (adopted !== step.model.visits) {
            step = brokkAfter({ ...step.model, visits: adopted }, { type: "tick" }, now);
        }
        const published = publishOf(shared, step.model.visits, now);
        if (published !== this.shared) {
            this.shared = published;
            this.deps.writeShared(published);
        }
        this.commit(step, now);
    }

    private setExample(visit: Visit): void {
        if (this.stopped) {
            return;
        }
        this.example = visit;
        if (this.publish(this.answer)) {
            this.listeners.forEach((listener) => listener());
        }
    }

    // The view the surfaces read: the model's answer, with the example's visit in place of its visit while it is up.
    // Returns whether it changed; the scene that is up stays the very same object while its visit says the same, so that
    // it is not drawn again for the badge rising.
    private publish(answer: BrokkView): boolean {
        const next = this.example == null ? answer : { ...answer, visit: this.example };
        if (sameView(this.view, next)) {
            return false;
        }
        this.view = sameVisit(this.view.visit, next.visit) ? { ...next, visit: this.view.visit } : next;
        return true;
    }

    private commit(step: BrokkStep, now: number): void {
        this.model = step.model;
        this.answer = step.view;
        const changed = this.publish(step.view);
        this.deps.clearTimer(this.wakeTimer);
        // The model asks for a moment strictly after now, and every rule it applies there holds at that very moment.
        this.wakeTimer =
            step.wakeAt == null
                ? null
                : this.deps.setTimer(() => this.run({ type: "tick" }), Math.min(step.wakeAt - now, MaxTimerMs));
        this.deps.clearTimer(this.pollTimer);
        this.pollTimer =
            step.view.cue && gateHold(step.model.gate, false, now) === "overlay"
                ? this.deps.setTimer(() => this.run({ type: "tick" }), OverlayPollMs)
                : null;
        if (changed) {
            this.listeners.forEach((listener) => listener());
        }
    }
}
