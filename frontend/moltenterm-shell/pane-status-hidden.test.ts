// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/global", () => ({ getBlockComponentModel: () => null }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
const Events = vi.hoisted(() => ({ handlers: new Map<string, Set<(event: any) => void>>() }));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: ({ eventType, handler }: { eventType: string; handler: (event: any) => void }) => {
        const set = Events.handlers.get(eventType) ?? new Set();
        set.add(handler);
        Events.handlers.set(eventType, set);
        return () => set.delete(handler);
    },
}));

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { MissionCiEvent, MissionUpdateEvent } from "./mission/mission-client";
import { watchProjectEvents } from "./pane-status";
import type { ActivityState } from "./tab-activity-model";

function fixture(state: ActivityState) {
    const stateAtom = atom(state) as PrimitiveAtom<ActivityState>;
    const ask = vi.fn();
    const stop = watchProjectEvents("proj", ask, { stateAtom });
    return { ask, stop, move: (next: ActivityState) => globalStore.set(stateAtom, next) };
}

function emit(eventType: string, data?: unknown) {
    for (const handler of [...(Events.handlers.get(eventType) ?? [])]) {
        handler({ data });
    }
}

beforeEach(() => {
    Events.handlers.clear();
});

describe("the status bar's asks on the project's events (#2154, AC-2)", () => {
    it("are made at once in the view that shows, for a finished CI and for a mission update", () => {
        const { ask, stop } = fixture("active");
        emit(MissionCiEvent, { status: "success" });
        emit(MissionUpdateEvent);
        expect(ask).toHaveBeenCalledTimes(2);
        stop();
    });

    it("leave out a CI that is still running", () => {
        const { ask, stop } = fixture("active");
        emit(MissionCiEvent, { status: "running" });
        expect(ask).not.toHaveBeenCalled();
        stop();
    });

    it("are not made in a hidden view, whatever the events", () => {
        const { ask, stop } = fixture("hidden");
        for (let i = 0; i < 3; i++) {
            emit(MissionCiEvent, { status: "failure" });
            emit(MissionUpdateEvent);
        }
        expect(ask).not.toHaveBeenCalled();
        stop();
    });

    it("are made once when the hidden view shows again", () => {
        const { ask, stop, move } = fixture("hidden");
        emit(MissionCiEvent, { status: "failure" });
        emit(MissionUpdateEvent);
        move("active");
        expect(ask).toHaveBeenCalledTimes(1);
        stop();
    });

    it("are not made in a minimised window, nor once the bar is gone", () => {
        const { ask, stop, move } = fixture("minimized");
        emit(MissionUpdateEvent);
        stop();
        move("active");
        emit(MissionUpdateEvent);
        expect(ask).not.toHaveBeenCalled();
    });
});
