// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot } from "react-dom/client";
import { ToastStack } from "../../frontend/moltenterm-shell/toast-stack";
import { Toasts } from "../../frontend/moltenterm-shell/toast-store";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mount = document.createElement("main");
document.body.append(mount);
const root = createRoot(mount);
const model = Toasts.getInstance();
const bell = document.createElement("button");
document.body.append(bell);
bell.getBoundingClientRect = () => ({ left: 20, top: 20, width: 20, height: 20, right: 40, bottom: 40 }) as DOMRect;
const bellRef = { current: bell };
let now = 0;
let nextId = 0;
const timers = new Map<number, { at: number; callback: () => void }>();
const allCallbacks: (() => void)[] = [];
window.setTimeout = ((callback: () => void, delay = 0) => {
    const id = ++nextId;
    timers.set(id, { at: now + delay, callback });
    allCallbacks.push(callback);
    return id;
}) as typeof window.setTimeout;
window.clearTimeout = (id: number) => {
    timers.delete(id);
};
Date.now = () => now;
function advance(ms: number) {
    const end = now + ms;
    for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
    }
    now = end;
}
function check(value: unknown, message: string) {
    if (!value) throw new Error(message);
}
function toast() {
    return document.querySelector<HTMLElement>('[data-testid="toast"]');
}

async function runChecks() {
    await act(async () => root.render(<ToastStack onOpenCenter={() => {}} bellRef={bellRef} />));
    await act(async () => model.push({ id: "same", title: "old", notificationId: "n", dismissMs: 100 }));
    toast().getBoundingClientRect = () => ({ left: 100, top: 100, width: 100, height: 40 }) as DOMRect;
    await act(async () => advance(100));
    check(toast().dataset.flight === "bell", "original toast did not enter flight");
    const oldNode = toast();
    const oldFallback = allCallbacks[allCallbacks.length - 1];
    await act(async () =>
        model.push({ id: "same", title: "replacement", stays: true, thumbnail: "data:image/png;base64,AA==" })
    );
    check(toast() !== oldNode && !toast().dataset.flight, "replacement did not start a fresh lifecycle");
    check(!!toast().querySelector("img"), "replacement lost its thumbnail");
    await act(async () => {
        oldFallback();
        advance(1000);
    });
    check(model.stack()[0]?.title === "replacement", "old flight dismissed the replacement");
    await act(async () => model.push({ id: "same", title: "timed", dismissMs: 300 }));
    await act(async () => advance(299));
    check(model.stack()[0]?.title === "timed", "replacement did not get its full timeout");
    await act(async () => advance(1));
    check(model.stack().length === 0, "replacement did not time out");
    await act(async () => root.unmount());
    return "PASS: flight replacement, stale callback, thumbnail, and full timeout";
}
Object.assign(globalThis, { runToastReplacementChecks: runChecks });
