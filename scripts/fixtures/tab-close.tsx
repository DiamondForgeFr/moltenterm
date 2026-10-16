// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../../frontend/app/element/button";
import { HoldToCloseButton } from "../../frontend/moltenterm-shell/hold-to-close";
import { WaveEnvContext } from "./tab-close-mocks";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mount = document.createElement("main");
document.body.append(mount);
const root = createRoot(mount);
let now = 0, timerId = 0;
const timers = new Map<number, { at: number; callback: () => void }>();
window.setTimeout = ((callback: () => void, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { at: now + delay, callback });
    return id;
}) as typeof window.setTimeout;
window.clearTimeout = (id: number) => { timers.delete(id); };
function advance(ms: number) {
    const end = now + ms;
    while (true) {
        const next = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (next == null) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
    }
    now = end;
}
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
let closes = 0, parentEvents = 0, protectedAsks = 0, confirmedEvents: unknown[] = [];
const trigger = () => document.querySelector<HTMLButtonElement>('[data-testid="tab-close"]');
const dialog = () => document.querySelector<HTMLElement>('[data-role="molten-semantic-tab-close"]');
const buttons = () => Array.from(dialog().querySelectorAll<HTMLButtonElement>("button"));
const click = (el: Element, detail = 0) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
const key = (el: Element, type: string, value: string, repeat = false) =>
    el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: value, repeat }));
const pointer = (el: Element, type: string) =>
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0 }));

async function prepare(options: { enabled?: boolean; reduced?: boolean; custom?: boolean; protected?: boolean } = {}) {
    await act(async () => root.render(null));
    timers.clear();
    closes = parentEvents = protectedAsks = 0;
    confirmedEvents = [];
    const enabled = atom(options.enabled !== false), duration = atom(200), reduced = atom(!!options.reduced);
    const env = { getSettingsKeyAtom: (name: string) => name === "tab:holdtoclose" ? enabled : duration,
        atoms: { prefersReducedMotionAtom: reduced } };
    const close = (event: unknown) => {
        check(dialog() == null, "close callback ran before semantic dialog removal");
        confirmedEvents.push(event);
        if (options.protected) {
            protectedAsks++;
            return;
        }
        closes++;
    };
    const parent = () => parentEvents++;
    await act(async () => root.render(<StrictMode><WaveEnvContext.Provider value={env}>
        <div onClick={parent} onMouseDown={parent} onDoubleClick={parent} onAuxClick={parent} onContextMenu={parent}>
            <HoldToCloseButton className="opacity-0" onClose={close} as={options.custom ? Button : undefined} />
        </div>
        <button data-outside>Outside</button>
    </WaveEnvContext.Provider></StrictMode>));
    trigger().focus();
}
async function semantic() {
    await act(async () => click(trigger()));
    check(dialog(), "semantic activation did not open a confirmation");
    check(document.activeElement === buttons()[0], "confirmation did not focus Cancel");
    check(closes === 0, "semantic activation closed without confirmation");
}
async function runChecks() {
    const cases: string[] = [];
    for (const custom of [false, true]) {
        for (const enabled of [false, true]) {
            await prepare({ custom, enabled });
            await semantic();
            const cancel = buttons()[0];
            await act(async () => {
                cancel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                cancel.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
                cancel.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
                cancel.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
                click(cancel);
            });
            check(!dialog() && closes === 0 && parentEvents === 0, "Cancel leaked an ancestor event or close");
            check(document.activeElement === trigger(), "Cancel did not restore close control focus");
            await semantic();
            await act(async () => key(document.activeElement, "keydown", "Escape"));
            check(!dialog() && closes === 0 && document.activeElement === trigger(), "Escape did not cancel and restore focus");
            await semantic();
            const confirm = buttons()[1];
            await act(async () => { click(confirm); click(confirm); });
            check(closes === 1 && confirmedEvents.length === 1 && confirmedEvents[0] === null, "Confirm did not invoke the existing callback exactly once");
            check(parentEvents === 0, "Confirm selected the owning tab");
            cases.push(`semantic, cancel, Escape, once, isolation: custom=${custom} hold=${enabled}`);
            for (const value of ["Enter", " "]) {
                await prepare({ custom, enabled });
                const control = trigger();
                await act(async () => {
                    if (enabled) pointer(control, "pointerdown");
                    key(control, "keydown", value);
                    key(control, "keydown", value, true);
                    advance(5000);
                });
                check(!dialog() && closes === 0, "keyboard press started a timed hold");
                await act(async () => key(control, "keyup", value));
                check(dialog(), "keyboard release did not open confirmation");
                await act(async () => { click(buttons()[0]); click(control); });
                check(!dialog() && closes === 0, "follow-up native click reopened a cancelled confirmation");
                await act(async () => advance(0));
                await semantic();
                cases.push(`keyboard ${JSON.stringify(value)}: custom=${custom} hold=${enabled}`);
            }
        }
    }
    for (const reduced of [false, true]) {
        await prepare({ reduced });
        await act(async () => { pointer(trigger(), "pointerdown"); advance(50); pointer(trigger(), "pointerup"); click(trigger(), 1); });
        check(closes === 0 && !dialog() && document.querySelector('[data-testid="hold-hint"]'), "pointer click lost its hold hint");
        for (const cancellation of ["pointercancel", "pointerout", "blur"]) {
            await prepare({ reduced });
            await act(async () => {
                pointer(trigger(), "pointerdown");
                if (cancellation === "blur") {
                    trigger().dispatchEvent(new FocusEvent("focusout", { bubbles: true,
                        relatedTarget: document.querySelector("[data-outside]") }));
                    document.querySelector<HTMLButtonElement>("[data-outside]").focus();
                }
                else pointer(trigger(), cancellation);
                advance(5000);
            });
            check(closes === 0 && !dialog(), `${cancellation} closed a tab`);
            await semantic();
        }
        await prepare({ reduced });
        await act(async () => { pointer(trigger(), "pointerdown"); advance(500); pointer(trigger(), "pointerup"); click(trigger(), 1); });
        check(closes === 1 && !dialog(), "completed pointer hold did not close exactly once");
        await prepare({ reduced });
        await act(async () => { pointer(trigger(), "pointerdown"); root.render(null); });
        await act(async () => advance(5000));
        check(closes === 0, "unmounted hold closed a tab");
        cases.push(`pointer click, hold, cancellations, unmount: reduced=${reduced}`);
    }
    await prepare({ enabled: false });
    await act(async () => click(trigger(), 1));
    check(closes === 1 && !dialog(), "hold-disabled pointer click changed");
    await prepare({ protected: true });
    await semantic();
    await act(async () => click(buttons()[1]));
    check(protectedAsks === 1 && closes === 0, "semantic confirmation bypassed the caller's process protection");
    cases.push("hold-disabled pointer and protected callback handoff");
    return { cases, count: cases.length };
}
Object.assign(globalThis, { runTabCloseChecks: runChecks, prepareTabClose: prepare,
    prepareNativeTabClose: async (options: { enabled: boolean }) => {
        await prepare(options);
        // Native Chromium input is delivered outside React's test dispatcher; observe its committed DOM below.
        globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    },
    assertNativeTabClose: async () => {
        if (!dialog()) await new Promise<void>(resolve => {
            const observer = new MutationObserver(() => {
                if (dialog()) { observer.disconnect(); resolve(); }
            });
            observer.observe(document.body, { subtree: true, childList: true });
        });
        check(closes === 0, "native key closed without confirmation");
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    },
    cancelNativeTabClose: async () => {
        await act(async () => click(buttons()[0]));
        check(document.activeElement === trigger(), "native cancellation focus");
        check(getComputedStyle(trigger()).opacity === "1", "keyboard-focused close control remains invisible");
    },
    showTabCloseConfirmation: async () => { await prepare({ custom: true }); await semantic(); },
});
