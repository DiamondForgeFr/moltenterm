// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { act, StrictMode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { Provider } from "jotai";
import { globalStore } from "../../frontend/app/store/jotaiStore";
import { DialogFrame, useEscape } from "../../frontend/moltenterm-shell/dialog-frame";
import { EndSessionDialog, CleanupDialog } from "../../frontend/moltenterm-shell/sessions/sessions-dialogs";
import { WorktreeCloseDialog, TabCloseDialog } from "../../frontend/moltenterm-shell/worktree-close";
import { WorkspaceResetHost, askResetWorkspace } from "../../frontend/moltenterm-shell/workspace-reset";
import { fixture } from "./dialog-focus-mocks";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const main = document.createElement("main");
document.body.append(main);
let root = createRoot(main);
const session = {
    id: "fixture", shortid: "fixture", connection: "", connstate: "connected" as const,
    workspaceorder: 0, shown: false, canshow: false, canend: true, command: "fixture command",
};
const running = [{ kind: "command" as const, label: "fixture", blockId: "fixture", workspaceId: "fixture", tabId: "fixture" }];
let open: (kind: string) => void;
let removeOpener: () => void;
let removeWorkflow: () => void;
let inlineEscapes = 0;
let outerEscapes = 0;
const closes: string[] = [];

function CustomModal({ close }: { close: () => void }) {
    const ref = useRef<HTMLButtonElement>(null);
    const [previous] = useState(() => document.activeElement as HTMLElement);
    useEscape(true, close, "custom-fixture");
    useLayoutEffect(() => {
        ref.current.focus();
        return () => queueMicrotask(() => {
            if (!ref.current?.isConnected && previous?.isConnected) previous.focus();
        });
    }, [previous]);
    return createPortal(<div data-role="custom-fixture"><div role="dialog" aria-modal="true" aria-label="Custom modal">
        <button ref={ref} onClick={close}>Custom close</button>
    </div></div>, document.body);
}

function Layer({ role, close, empty = false, nested = false, custom = false }: { role: string; close: () => void; empty?: boolean; nested?: boolean; custom?: boolean }) {
    const [inner, setInner] = useState(false);
    const [busy, setBusy] = useState(false);
    return <>
        <DialogFrame role={role} title={role} trapFocus={false}
            onEscape={busy ? undefined : () => { outerEscapes++; close(); }} buttons={empty ? <button disabled>Disabled</button> : <>
            <button data-testid="safe" onClick={close}>Cancel</button>
            <button style={{ display: "none" }}>Hidden</button>
            <button style={{ visibility: "hidden" }}>Invisible</button>
            <fieldset disabled><button>Disabled fieldset</button></fieldset>
            <button hidden>Hidden attribute</button>
            <button onClick={() => nested ? setInner(true) : setBusy(true)}>Continue</button>
        </>}>
            {busy ? <button disabled>Busy</button> : null}
            {inner ? custom ? <CustomModal close={() => setInner(false)} /> : <Layer role={role} close={() => setInner(false)} /> : null}
        </DialogFrame>
    </>;
}

function App() {
    const [kind, setKind] = useState("");
    const [opener, setOpener] = useState(true);
    const [workflow, setWorkflow] = useState(true);
    open = setKind;
    removeOpener = () => setOpener(false);
    removeWorkflow = () => setWorkflow(false);
    useEscape(true, () => inlineEscapes++);
    const close = () => { closes.push(kind); setKind(""); };
    const end = async () => {
        fixture.writes.push("end");
        await new Promise<void>((resolve, reject) => fixture.pending.push({ resolve, reject }));
        close();
    };
    return <>
        {workflow ? <><section data-testid="workflow">
            {opener ? <button id="opener" onClick={() => setKind("end")}>Open</button> : null}
            <button id="survivor">Surviving workflow control</button>
        </section>
        <input id="background" aria-label="Background terminal" /></> : null}
        {kind === "end" ? <EndSessionDialog session={session} home="/fixture" now={1} onKeep={close} onEnd={end} /> : null}
        {kind === "cleanup" ? <CleanupDialog sessions={[session]} home="/fixture" onKeep={close} onEnd={end} /> : null}
        {kind === "worktree" ? <WorktreeCloseDialog request={{ path: "/fixture/tree", blockId: "fixture", close, running }} onDone={close} /> : null}
        {kind === "tab" ? <TabCloseDialog request={{ tabId: "fixture", rows: [{ path: "/fixture/tree", blockIds: ["fixture"], remove: false }], blockIds: ["fixture"], running, answer: () => {} }} onDone={close} /> : null}
        {kind === "nested" ? <Layer role="outer" nested close={close} /> : null}
        {kind === "custom" ? <Layer role="outer" nested custom close={close} /> : null}
        {kind === "empty" ? <Layer role="empty" empty close={close} /> : null}
        <WorkspaceResetHost />
    </>;
}

function check(condition: unknown, message: string) {
    if (!condition) throw new Error(`${message}\nFocus: ${(document.activeElement as HTMLElement)?.outerHTML}\n${document.body.innerText}`);
}
const dialogs = () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
const top = () => dialogs().at(-1);
const focused = () => top()?.contains(document.activeElement);
const key = async (value: string, shiftKey = false) => {
    await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })));
};
const settle = async () => { await act(async () => {}); };
const launch = async (kind: string) => {
    document.getElementById("opener")?.focus();
    await act(async () => kind === "reset" ? askResetWorkspace("fixture") : open(kind));
    check(top(), `Missing ${kind}`);
};
const cycle = async () => {
    const controls = Array.from(top().querySelectorAll<HTMLElement>("button, input, select"))
        .filter((el) => !el.matches(":disabled") && el.getClientRects().length && !el.hidden);
    const valid = () => focused() && !document.activeElement.matches(":disabled") && getComputedStyle(document.activeElement).visibility !== "hidden";
    for (let i = 0; i < controls.length + 2; i++) { await key("Tab"); check(valid(), "Forward Tab escaped or reached a disabled/hidden control"); }
    for (let i = 0; i < controls.length + 2; i++) { await key("Tab", true); check(valid(), "Reverse Tab escaped or reached a disabled/hidden control"); }
    await act(async () => document.getElementById("background").focus());
    check(focused(), "Background terminal stole focus");
};

export async function runDialogChecks() {
    await act(async () => root.render(<StrictMode><Provider store={globalStore}><App /></Provider></StrictMode>));
    const passed: string[] = [];
    for (const kind of ["end", "cleanup", "worktree", "tab", "reset"]) {
        await launch(kind);
        const expected = kind === "end" || kind === "cleanup" ? "Keep it" : kind === "reset" ? "Reset workspace" : "Cancel";
        check(document.activeElement?.textContent === expected, `${kind}: existing initial target`);
        await cycle();
        const before = inlineEscapes;
        await key("Escape");
        check(!top(), `${kind}: Escape did not dismiss`);
        check(inlineEscapes === before, `${kind}: background Escape ran`);
        check(document.activeElement?.id === "opener", `${kind}: opener not restored`);
        passed.push(`${kind}: safe initial focus, forward/reverse Tab, background focus and Escape/restoration`);
    }
    const inlineBefore = inlineEscapes;
    await key("Escape");
    check(inlineEscapes === inlineBefore + 1, "Nonmodal Escape changed without a modal");
    const waveBackdrop = document.createElement("div");
    waveBackdrop.className = "modal-backdrop";
    document.body.append(waveBackdrop);
    await key("Escape");
    check(inlineEscapes === inlineBefore + 1, "Nonmodal Escape ran behind a legacy modal");
    waveBackdrop.remove();
    passed.push("inline Escape preserved without a modal and blocked behind legacy modal backdrops");
    await launch("end");
    await act(async () => (Array.from(top().querySelectorAll("button")).at(-1) as HTMLButtonElement).click());
    await settle();
    check(document.activeElement === top(), "All-disabled busy state lacks focus fallback");
    await cycle();
    await key("Escape");
    check(top(), "Busy Escape dismissed the dialog");
    await act(async () => fixture.pending.shift().reject(new Error("Fixture failed")));
    check(top().textContent.includes("Fixture failed"), "Error state missing");
    await cycle();
    await key("Escape");
    passed.push("busy all-disabled fallback, Escape restriction and retryable error state");

    await launch("nested");
    const innerTrigger = Array.from(top().querySelectorAll<HTMLButtonElement>("button")).at(-1);
    await act(async () => { innerTrigger.focus(); innerTrigger.click(); });
    check(dialogs().length === 2 && focused(), "Nested dialog lost initial focus");
    await act(async () => innerTrigger.focus());
    check(focused(), "Underlying dialog stole topmost focus");
    await cycle();
    const before = outerEscapes;
    await key("Escape");
    check(dialogs().length === 1 && outerEscapes === before + 1, "Escape dismissed more than the top dialog");
    check(document.activeElement === innerTrigger, "Nested close did not restore underlying trigger");
    await key("Escape");
    check(!top() && document.activeElement?.id === "opener", "Final nested close did not restore invoker");
    passed.push("nested topmost focus/Escape and return to underlying dialog");

    await launch("custom");
    const customTrigger = Array.from(top().querySelectorAll<HTMLButtonElement>("button")).at(-1);
    await act(async () => { customTrigger.focus(); customTrigger.click(); });
    check(top().getAttribute("aria-label") === "Custom modal" && focused(), "Shared dialog blocked custom modal focus");
    await key("Escape");
    check(dialogs().length === 1 && document.activeElement === customTrigger, "Custom modal Escape/restoration disturbed underlying dialog");
    await key("Escape");
    passed.push("custom modal above the shared frame retains its own keyboard lifecycle");

    await launch("empty");
    check(document.activeElement === top(), "Empty modal lacks container fallback");
    await cycle();
    await key("Escape");
    await launch("end");
    await act(async () => removeOpener());
    await key("Escape");
    check(document.activeElement?.id === "survivor", "Removed opener did not use surviving workflow control");
    passed.push("empty control fallback and disappearing invoker restoration");

    document.getElementById("survivor").focus();
    await act(async () => open("nested"));
    await act(async () => open("empty"));
    check(document.activeElement === top(), "Replacement dialog lost focus during cleanup");
    await key("Escape");
    check(document.activeElement?.id === "survivor", "Replacement dialog lost original invoker");
    passed.push("replacement dialog opened during prior cleanup owns focus");
    await act(async () => open("empty"));
    await act(async () => removeWorkflow());
    await key("Escape");
    check(document.activeElement === main, "Removed workflow did not use the app landmark fallback");
    passed.push("removed invoking pane falls back to the surviving app landmark");
    await act(async () => root.unmount());
    root = createRoot(main);
    return passed;
}
(globalThis as any).runDialogChecks = runDialogChecks;
(globalThis as any).prepareNativeDialog = async () => {
    await act(async () => root.render(<StrictMode><Provider store={globalStore}><App /></Provider></StrictMode>));
    await launch("end");
};
