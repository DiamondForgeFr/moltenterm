// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from "vitest";
import { useMaterialsProjects, useMaterialsScope } from "./use-materials-all";

const mocks = vi.hoisted(() => ({
    effects: [] as (() => void | (() => void))[],
    setters: [] as ReturnType<typeof vi.fn>[],
    read: vi.fn(),
    subscribe: vi.fn(),
    hooks: null as { slots: any[]; cursor: number; pending: { slot: any; effect: () => any }[] } | null,
}));
vi.mock("react", () => ({
    useState: (initial: unknown) => {
        if (mocks.hooks) {
            const hooks = mocks.hooks;
            const index = hooks.cursor++;
            if (!hooks.slots[index]) {
                const slot = { value: initial, setter: null as ReturnType<typeof vi.fn> };
                slot.setter = vi.fn((value) => {
                    slot.value = value;
                });
                hooks.slots[index] = slot;
                mocks.setters.push(slot.setter);
            }
            const slot = hooks.slots[index];
            return [slot.value, slot.setter];
        }
        const setter = vi.fn();
        mocks.setters.push(setter);
        return [initial, setter];
    },
    useRef: (value: unknown) => {
        if (!mocks.hooks) return { current: value };
        const hooks = mocks.hooks;
        const index = hooks.cursor++;
        return (hooks.slots[index] ??= { current: value });
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
        if (!mocks.hooks) {
            mocks.effects.push(effect);
            return;
        }
        const hooks = mocks.hooks;
        const index = hooks.cursor++;
        const slot = (hooks.slots[index] ??= {});
        if (!slot.deps || deps.some((dep, i) => !Object.is(dep, slot.deps[i]))) {
            slot.deps = deps;
            hooks.pending.push({ slot, effect });
        }
    },
}));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: mocks.subscribe }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: mocks.read } }));

function deferred<T>() {
    let resolve: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}

function mount() {
    const cleanups = mocks.effects.splice(0).map((effect) => effect());
    return () =>
        cleanups.forEach((cleanup) => {
            if (typeof cleanup === "function") cleanup();
        });
}

beforeEach(() => {
    mocks.effects = [];
    mocks.setters = [];
    mocks.hooks = null;
    mocks.read.mockReset().mockResolvedValue({ projects: [], materials: [] });
    mocks.subscribe.mockReset().mockImplementation(() => vi.fn());
});

it("serializes an in-place scope/workspace switch using the mounted hook's persistent refresh", async () => {
    const old = deferred<any>();
    const next = deferred<any>();
    mocks.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const hooks: NonNullable<typeof mocks.hooks> = { slots: [], cursor: 0, pending: [] };
    const render = (workspace: string, scope: Parameters<typeof useMaterialsScope>[2]) => {
        mocks.hooks = hooks;
        hooks.cursor = 0;
        const view = useMaterialsScope(workspace, `/${workspace}`, scope);
        mocks.hooks = null;
        const pending = hooks.pending.splice(0);
        pending.forEach(({ slot }) => slot.cleanup?.());
        pending.forEach(({ slot, effect }) => {
            slot.cleanup = effect();
        });
        return view;
    };
    expect(render("old", { kind: "all" })).toBeNull();
    const unsubscribe = mocks.subscribe.mock.results[0].value;
    expect(render("next", { kind: "project", key: "selected" })).toBeNull();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenCalledOnce();
    old.resolve({ materials: [{ id: "stale" }] });
    await old.promise;
    expect(mocks.setters[0]).not.toHaveBeenCalled();
    expect(mocks.read.mock.calls[1][1]).toEqual({ workspaceid: "next", project: "selected" });
    const current = { materials: [{ id: "current" }] };
    next.resolve(current);
    await next.promise;
    expect(render("next", { kind: "project", key: "selected" })).toBe(current);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(render("next", { kind: "active" })).toBeNull();
    expect(mocks.read).toHaveBeenCalledTimes(2);
    hooks.slots.forEach((slot) => slot.cleanup?.());
});

it("loads only summary metadata beside the active drawer and refreshes counts on all-project events", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    mocks.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useMaterialsProjects("w", "/project");
    useMaterialsScope("w", "/project", { kind: "active" });
    const unmount = mount();
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(
        "moltenmaterialslist",
        { workspaceid: "w", summary: true },
        expect.anything()
    );
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    const event = mocks.subscribe.mock.calls[0][0];
    expect(event.scope).toBe("all");
    first.resolve({ projects: [{ key: "p", count: 1 }] });
    await first.promise;
    expect(mocks.setters[0]).toHaveBeenLastCalledWith({
        key: "summary:w:/project",
        view: { projects: [{ key: "p", count: 1 }] },
    });
    event.handler({ data: { project: "other" } });
    second.resolve({ projects: [{ key: "p", count: 2 }] });
    await second.promise;
    expect(mocks.setters[0]).toHaveBeenLastCalledWith({
        key: "summary:w:/project",
        view: { projects: [{ key: "p", count: 2 }] },
    });
    expect(mocks.read.mock.calls.every(([, data]) => data.all !== true)).toBe(true);
    unmount();
});

it("subscribes only to the selected drawer, and requests all records only for All projects", async () => {
    useMaterialsScope("w", "/project", { kind: "project", key: "other" });
    const closeProject = mount();
    expect(mocks.read.mock.calls[0][1]).toEqual({ workspaceid: "w", project: "other" });
    expect(mocks.subscribe.mock.calls[0][0].scope).toBe("other");
    await Promise.resolve();
    for (const [subscription] of mocks.subscribe.mock.calls) {
        if (subscription.scope === "unrelated") subscription.handler({ data: { project: "unrelated" } });
    }
    expect(mocks.read).toHaveBeenCalledOnce();
    mocks.subscribe.mock.calls[0][0].handler({ data: { project: "other" } });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    closeProject();
    useMaterialsScope("w", "/project", { kind: "all" });
    const closeAll = mount();
    expect(mocks.read.mock.calls[2][1]).toEqual({ workspaceid: "w", all: true });
    expect(mocks.subscribe.mock.calls[1][0].scope).toBe("all");
    closeAll();
    useMaterialsScope("w", "/project", { kind: "none" });
    const closeNone = mount();
    expect(mocks.read.mock.calls[3][1]).toEqual({ workspaceid: "w", project: "noproject" });
    expect(mocks.subscribe.mock.calls[2][0].scope).toBe("noproject");
    closeNone();
});

it("drops an old scope response and unsubscribes when changing workspace", async () => {
    const old = deferred<any>();
    const next = deferred<any>();
    mocks.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    useMaterialsScope("old", "/old", { kind: "all" });
    const closeOld = mount();
    const oldSetter = mocks.setters[0];
    const unsubscribe = mocks.subscribe.mock.results[0].value;
    closeOld();
    expect(unsubscribe).toHaveBeenCalledOnce();
    useMaterialsScope("next", "/next", { kind: "project", key: "selected" });
    const closeNext = mount();
    old.resolve({ materials: [{ id: "stale" }] });
    await old.promise;
    expect(oldSetter).not.toHaveBeenCalled();
    next.resolve({ materials: [{ id: "current" }] });
    await next.promise;
    expect(mocks.setters[1]).toHaveBeenCalledExactlyOnceWith({
        key: "next:/next:project:selected",
        view: { materials: [{ id: "current" }] },
    });
    closeNext();
});
