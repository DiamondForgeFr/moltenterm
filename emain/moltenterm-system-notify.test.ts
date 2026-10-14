// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: {}, Notification: class {} }));
vi.mock("./emain-window", () => ({ getAllWaveWindows: () => [], getWaveWindowByWebContentsId: () => null }));

import { ShownNotification, SystemNotifier } from "./moltenterm-system-notify";

type FakeNotification = ShownNotification & {
    title: string;
    body: string;
    shown: boolean;
    closed: boolean;
    fire(event: string): void;
};

function setup(focused = false) {
    const made: FakeNotification[] = [];
    const clicks: [string, number][] = [];
    const state = { focused, supported: true };
    const notifier = new SystemNotifier({
        anyWindowFocused: () => state.focused,
        supported: () => state.supported,
        make: (title, body) => {
            const listeners = new Map<string, () => void>();
            const n: FakeNotification = {
                title,
                body,
                shown: false,
                closed: false,
                show: () => {
                    n.shown = true;
                },
                close: () => {
                    n.closed = true;
                    listeners.get("close")?.();
                },
                on: (event, listener) => {
                    listeners.set(event, listener);
                },
                fire: (event) => listeners.get(event)?.(),
            };
            made.push(n);
            return n;
        },
        onClick: (id, senderId) => clicks.push([id, senderId]),
    });
    return { notifier, made, clicks, state };
}

const Question = { id: "n1", title: "Camille wants to hand work to Jules", body: "projecta → projectb" };

describe("SystemNotifier", () => {
    it("shows the question while no window is focused", () => {
        const { notifier, made } = setup();
        expect(notifier.notify(Question, 7)).toBe("shown");
        expect(made).toHaveLength(1);
        expect(made[0]).toMatchObject({ title: Question.title, body: Question.body, shown: true });
    });

    it("stays silent while a window is focused: the toast is enough", () => {
        const { notifier, made } = setup(true);
        expect(notifier.notify(Question, 7)).toBe("focused");
        expect(made).toHaveLength(0);
    });

    it("shows one id once, whichever tab view asks", () => {
        const { notifier, made } = setup();
        notifier.notify(Question, 7);
        expect(notifier.notify(Question, 8)).toBe("duplicate");
        expect(made).toHaveLength(1);
    });

    it("asks again later once the id is forgotten", () => {
        const { notifier, made } = setup();
        notifier.notify(Question, 7, 0);
        expect(notifier.notify(Question, 7, 11 * 60 * 1000)).toBe("shown");
        expect(made).toHaveLength(2);
    });

    it("does not remember a question it did not show", () => {
        const { notifier, state } = setup(true);
        expect(notifier.notify(Question, 7)).toBe("focused");
        state.focused = false;
        expect(notifier.notify(Question, 7)).toBe("shown");
    });

    it("refuses a request without id or title, and a system without notifications", () => {
        const { notifier, made, state } = setup();
        expect(notifier.notify({ id: "", title: "x", body: "" }, 7)).toBe("invalid");
        expect(notifier.notify({ id: "n2", title: " ", body: "" }, 7)).toBe("invalid");
        expect(notifier.notify(null, 7)).toBe("invalid");
        state.supported = false;
        expect(notifier.notify(Question, 7)).toBe("unsupported");
        expect(made).toHaveLength(0);
    });

    it("tells the click with the id and the tab view that asked", () => {
        const { notifier, made, clicks } = setup();
        notifier.notify(Question, 7);
        made[0].fire("click");
        expect(clicks).toEqual([["n1", 7]]);
    });

    it("keeps each notification until it closes, and closes it when the question is answered", () => {
        const { notifier, made } = setup();
        notifier.notify(Question, 7);
        expect(notifier.live.has("n1")).toBe(true);
        notifier.close("n1");
        expect(made[0].closed).toBe(true);
        expect(notifier.live.has("n1")).toBe(false);
        notifier.close("n1");
        notifier.close("unknown");
    });
});
