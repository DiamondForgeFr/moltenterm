// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
    call: vi.fn(),
    subscribe: vi.fn(),
}));

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: m.call } }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: m.subscribe }));

import { globalStore } from "@/app/store/jotaiStore";
import {
    AgentHandoffAnswerCommand,
    AgentHandoffPendingCommand,
    AgentHandoffPendingEvent,
    AgentHandoffRouteId,
    PendingHandoff,
} from "../agent-handoff";
import { MoltentermNotification } from "../notifications-model";
import { PendingHandoffs, ReadQuickTries, readRetryDelay, ReadRetryMs, ReadSlowRetryMs } from "./boss-handoffs";
import { buildToHandle, toHandleBadge } from "./boss-to-handle-model";

// A bounded wait for the state to settle; the deadline only bounds a failing run.
const Settle = { timeout: 30000 };

let store: PendingHandoffs;

function request(requestid: string, extra: Partial<PendingHandoff> = {}): PendingHandoff {
    return {
        requestid,
        fromblockid: "bs",
        toblockid: "br",
        from: "Chloé",
        to: "Léa",
        goal: `Goal of ${requestid}`,
        createdat: 1000,
        ...extra,
    };
}

function notificationOf(requestid: string): MoltentermNotification {
    return {
        id: `n-${requestid}`,
        key: `agenthandoff:${requestid}`,
        time: 5,
        updated: 5,
        source: "agents" as MoltentermNotification["source"],
        title: "A handoff",
        kind: "warning",
        read: false,
        blockid: "bs",
        actions: [{ id: "once", label: "Allow once", kind: "gesture", gesture: "molten:agenthandoff" }],
    } as MoltentermNotification;
}

// A stand-in for wavesrv's handoff route: the list it holds, the answers it took, the notifications it resolves, and the
// event it publishes when the list changes.
type Server = {
    waiting: PendingHandoff[];
    notifications: MoltentermNotification[];
    answers: { requestid: string; decision: string; route: string }[];
    handlers: ((event: unknown) => void)[];
    unsubscribed: number;
    publish: () => void;
};

let server: Server;

function startServer(waiting: PendingHandoff[]) {
    server = {
        waiting,
        notifications: waiting.map((w) => notificationOf(w.requestid)),
        answers: [],
        handlers: [],
        unsubscribed: 0,
        publish: () => server.handlers.forEach((handler) => handler({})),
    };
    m.subscribe.mockImplementation((sub: { eventType: string; handler: (event: unknown) => void }) => {
        expect(sub.eventType).toBe(AgentHandoffPendingEvent);
        server.handlers.push(sub.handler);
        return () => {
            server.unsubscribed++;
            server.handlers = server.handlers.filter((handler) => handler !== sub.handler);
        };
    });
    m.call.mockImplementation(async (command: string, data: any, opts: { route: string }) => {
        if (command === AgentHandoffPendingCommand) {
            expect(opts.route).toBe(AgentHandoffRouteId);
            return { entries: server.waiting };
        }
        if (command === AgentHandoffAnswerCommand) {
            server.answers.push({ requestid: data.requestid, decision: data.decision, route: opts.route });
            if (!server.waiting.some((w) => w.requestid === data.requestid)) {
                throw new Error("This handoff request is no longer waiting");
            }
            server.waiting = server.waiting.filter((w) => w.requestid !== data.requestid);
            server.notifications = server.notifications.map((n) =>
                n.key === `agenthandoff:${data.requestid}` ? { ...n, resolved: 9 } : n
            );
            server.publish();
            return null;
        }
        throw new Error(`unexpected call ${command}`);
    });
}

const waitForIds = (ids: string[]) =>
    vi.waitFor(() => expect(globalStore.get(store.dataAtom).map((w) => w.requestid)).toEqual(ids), Settle);

beforeEach(() => {
    PendingHandoffs.resetInstance();
    store = PendingHandoffs.getInstance();
    m.call.mockReset();
    m.subscribe.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("the window's copy of the pending hand-off requests (FR-BOSS-005)", () => {
    it("reads the list from the handoff route when a bubble starts, and says a first reading is in", async () => {
        startServer([request("r1"), request("r2")]);
        expect(globalStore.get(store.loadedAtom)).toBe(false);
        const stop = store.start();
        await waitForIds(["r1", "r2"]);
        expect(globalStore.get(store.loadedAtom)).toBe(true);
        stop();
    });

    it("reads again when wavesrv says the list changed, and keeps nothing once the last bubble is gone", async () => {
        startServer([request("r1")]);
        const stopA = store.start();
        const stopB = store.start();
        expect(m.subscribe).toHaveBeenCalledTimes(1);
        await waitForIds(["r1"]);

        server.waiting = [request("r1"), request("r2")];
        server.publish();
        await waitForIds(["r1", "r2"]);

        stopA();
        stopA();
        expect(server.unsubscribed).toBe(0);
        stopB();
        expect(server.unsubscribed).toBe(1);
        expect(globalStore.get(store.dataAtom)).toEqual([]);
        expect(globalStore.get(store.loadedAtom)).toBe(false);
        const calls = m.call.mock.calls.length;
        server.publish();
        store.load();
        expect(m.call.mock.calls.length).toBe(calls);
    });

    it("follows a burst of changes with one more reading, and ends on the last state", async () => {
        startServer([request("r1")]);
        let release: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const serve = m.call.getMockImplementation();
        let reads = 0;
        m.call.mockImplementation(async (command: string, data: any, opts: { route: string }) => {
            if (command === AgentHandoffPendingCommand && ++reads === 1) {
                const snapshot = [...server.waiting];
                await gate;
                return { entries: snapshot };
            }
            return serve(command, data, opts);
        });
        const stop = store.start();
        await vi.waitFor(() => expect(reads).toBe(1), Settle);
        server.waiting = [request("r1"), request("r2"), request("r3")];
        server.publish();
        server.publish();
        server.publish();
        release();
        await waitForIds(["r1", "r2", "r3"]);
        expect(reads).toBe(2);
        stop();
    });

    it("tries a failed first reading again, and says nothing is in until one succeeds", async () => {
        vi.useFakeTimers();
        startServer([request("r1")]);
        const serve = m.call.getMockImplementation();
        let failing = true;
        m.call.mockImplementation(async (command: string, data: any, opts: { route: string }) => {
            if (failing) {
                throw new Error("wavesrv is not ready");
            }
            return serve(command, data, opts);
        });
        const stop = store.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(globalStore.get(store.loadedAtom)).toBe(false);
        failing = false;
        await vi.advanceTimersByTimeAsync(5000);
        expect(globalStore.get(store.loadedAtom)).toBe(true);
        expect(globalStore.get(store.dataAtom).map((w) => w.requestid)).toEqual(["r1"]);
        stop();
    });
});

describe("a read that keeps failing never silences Brokk (#2223)", () => {
    it("counts the list as read after the quick tries, keeps trying, and takes the requests once a read succeeds", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        startServer([request("r1")]);
        const serve = m.call.getMockImplementation();
        let failing = true;
        m.call.mockImplementation(async (command: string, data: any, opts: { route: string }) => {
            if (failing) {
                throw new Error("wavesrv is not ready");
            }
            return serve(command, data, opts);
        });
        const stop = store.start();
        await vi.advanceTimersByTimeAsync(ReadRetryMs * ReadQuickTries);
        expect(globalStore.get(store.loadedAtom)).toBe(true);
        expect(globalStore.get(store.dataAtom)).toEqual([]);
        const tries = m.call.mock.calls.length;
        await vi.advanceTimersByTimeAsync(ReadSlowRetryMs * 3);
        expect(m.call.mock.calls.length).toBeGreaterThan(tries);
        failing = false;
        await vi.advanceTimersByTimeAsync(ReadSlowRetryMs);
        expect(globalStore.get(store.dataAtom).map((w) => w.requestid)).toEqual(["r1"]);
        stop();
    });

    it("keeps the last good list through a failed read", async () => {
        vi.useFakeTimers();
        startServer([request("r1")]);
        const serve = m.call.getMockImplementation();
        let failing = false;
        m.call.mockImplementation(async (command: string, data: any, opts: { route: string }) => {
            if (failing) {
                throw new Error("lost the route");
            }
            return serve(command, data, opts);
        });
        const stop = store.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(globalStore.get(store.dataAtom).map((w) => w.requestid)).toEqual(["r1"]);
        failing = true;
        server.publish();
        await vi.advanceTimersByTimeAsync(ReadRetryMs);
        expect(globalStore.get(store.dataAtom).map((w) => w.requestid)).toEqual(["r1"]);
        expect(globalStore.get(store.loadedAtom)).toBe(true);
        stop();
    });

    it("waits a little between the first tries, then longer", () => {
        expect(readRetryDelay(1)).toBe(ReadRetryMs);
        expect(readRetryDelay(ReadQuickTries - 1)).toBe(ReadRetryMs);
        expect(readRetryDelay(ReadQuickTries)).toBe(ReadSlowRetryMs);
        expect(readRetryDelay(ReadQuickTries * 10)).toBe(ReadSlowRetryMs);
    });
});

describe("answering a request from the card (FR-BOSS-005)", () => {
    it.each(["once", "always", "block"] as const)(
        "gives %s to the route the notification answers through, and the row leaves",
        async (decision) => {
            startServer([request("r1"), request("r2")]);
            const stop = store.start();
            await waitForIds(["r1", "r2"]);

            await store.answer("r1", decision);

            expect(server.answers).toEqual([{ requestid: "r1", decision, route: AgentHandoffRouteId }]);
            expect(m.call).toHaveBeenCalledWith(
                AgentHandoffAnswerCommand,
                { requestid: "r1", decision },
                expect.objectContaining({ route: AgentHandoffRouteId })
            );
            expect(globalStore.get(store.dataAtom).map((w) => w.requestid)).toEqual(["r2"]);
            await waitForIds(["r2"]);
            stop();
        }
    );

    it("takes the row and the notification away together, and the badge with them", async () => {
        startServer([request("r1"), request("r2")]);
        const stop = store.start();
        await waitForIds(["r1", "r2"]);
        const list = () =>
            buildToHandle({
                states: { states: {}, versions: {} } as any,
                notifications: server.notifications,
                answers: {},
                readied: {},
                sessions: [],
                parked: {},
                handoffs: globalStore.get(store.dataAtom),
            });
        expect(list().items.map((item) => item.key)).toEqual(["handoff:r1", "handoff:r2"]);
        expect(toHandleBadge(list()).count).toBe(2);

        const once = list().items[0].actions[0].run;
        expect(once).toEqual({ kind: "handoff", requestid: "r1", decision: "once" });
        if (once.kind !== "handoff") {
            throw new Error("not an answer");
        }
        await store.answer(once.requestid, once.decision);

        expect(list().items.map((item) => item.key)).toEqual(["handoff:r2"]);
        expect(toHandleBadge(list()).count).toBe(1);
        expect(server.notifications.find((n) => n.id === "n-r1").resolved).toBe(9);
        stop();
    });

    it("leaves the row when the notification answered first, and the card follows without a click", async () => {
        startServer([request("r1")]);
        const stop = store.start();
        await waitForIds(["r1"]);
        // The developer answered through the notification's own button.
        server.waiting = [];
        server.publish();
        await waitForIds([]);
        stop();
    });

    it("says why a request could not be answered, and reads the list again so a gone request leaves", async () => {
        startServer([request("r1")]);
        const stop = store.start();
        await waitForIds(["r1"]);
        // Another window answered it between the card's last reading and this click.
        server.waiting = [];

        await expect(store.answer("r1", "once")).rejects.toThrow(/no longer waiting/);

        await waitForIds([]);
        stop();
    });
});
