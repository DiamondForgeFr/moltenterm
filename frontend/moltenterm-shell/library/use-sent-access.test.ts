// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { useSentAccess } from "./use-sent-access";

const mocks = vi.hoisted(() => ({ effects: [] as (() => () => void)[], setters: [] as ReturnType<typeof vi.fn>[], read: vi.fn(), remove: vi.fn(), undo: vi.fn() }));
vi.mock("react", () => ({
    useState: (initial: unknown) => {
        let value = typeof initial === "function" ? (initial as () => unknown)() : initial;
        const setter = vi.fn((next) => { value = typeof next === "function" ? next(value) : next; });
        mocks.setters.push(setter);
        return [value, setter];
    },
    useRef: (value: unknown) => ({ current: value }),
    useEffect: (effect: () => () => void) => { mocks.effects.push(effect); },
}));
vi.mock("@/util/util", () => ({ fireAndForget: (f: () => Promise<unknown>) => { void f(); } }));
vi.mock("../tab-activity", () => ({ TabActivity: { getInstance: () => ({ every: () => () => {} }) }, whileShown: (ms: number) => ms }));
vi.mock("./sent-panels", () => ({ readSentPanels: mocks.read }));
vi.mock("./library-model", () => ({ sentToAiRows: (rows: unknown) => rows }));
vi.mock("./share-access", () => ({ removeAccess: mocks.remove, giveAccessBack: mocks.undo }));

function deferred<T>() {
    let resolve: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
}

it("wires Remove and a surviving Undo to the live refresh barrier", async () => {
    const first = deferred<any[]>();
    const afterRemove = deferred<any[]>();
    const beforeUndo = deferred<any[]>();
    const afterUndo = deferred<any[]>();
    const remove = deferred<any[]>();
    const undo = deferred<number>();
    mocks.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(afterRemove.promise)
        .mockReturnValueOnce(beforeUndo.promise).mockReturnValueOnce(afterUndo.promise);
    mocks.remove.mockReturnValue(remove.promise);
    mocks.undo.mockReturnValue(undo.promise);
    const showUndo = vi.fn();
    const row = { key: "page", sessionId: "original" } as any;
    const firstMount = useSentAccess([{ id: "w" } as any], showUndo, vi.fn());
    const close = mocks.effects.shift()();
    firstMount.remove([row], "agent", false);
    first.resolve([row]);
    await first.promise;
    expect(mocks.setters[0]).not.toHaveBeenCalled();
    remove.resolve([row]);
    await vi.waitFor(() => expect(showUndo).toHaveBeenCalledOnce());
    const undoAction = showUndo.mock.calls[0][3] as () => Promise<number>;
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    close();
    useSentAccess([{ id: "w" } as any], showUndo, vi.fn());
    const closeAgain = mocks.effects.shift()();
    afterRemove.resolve([row]);
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(3));
    const restoring = undoAction();
    beforeUndo.resolve([]);
    await beforeUndo.promise;
    expect(mocks.setters[2]).not.toHaveBeenCalled();
    undo.resolve(0);
    await restoring;
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(4));
    afterUndo.resolve([row]);
    await vi.waitFor(() => expect(mocks.setters[2]).toHaveBeenCalledWith([row]));
    closeAgain();
});
