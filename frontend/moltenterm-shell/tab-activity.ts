// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tab activity model (FR-PERF-009, DS-PERF-008): one per tab view, it says whether this view is active, visible
// in an unfocused window, hidden behind another tab or workspace, or in a minimised window. The window's state comes
// from the main process (emain/moltenterm-tab-activity.ts); whether this view is the one on screen comes from the
// workspace (the window shows this view's workspace and its active tab is this view's tab), and from the document's
// visibility once hidden views are really hidden (FR-PERF-008).
//
// Every periodic job of the MoltenTerm frontend goes through every(): it declares its period in each state, pauses
// when it should not run and runs at once when it comes back overdue. A lint rule keeps setInterval out of the other
// MoltenTerm files. The root element carries data-mt-motion="still" whenever the view is not active, so infinite
// working animations stand still (moltenterm-shell.css).

import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { useEffect, useState } from "react";
import {
    ActivityPolicy,
    ActivityRunReason,
    ActivityScheduler,
    ActivityState,
    deriveActivity,
    WindowActivity,
} from "./tab-activity-model";
import { getWindowWorkspaceIdAtom } from "./tab-workspace";

export { always, whileShown } from "./tab-activity-model";
export type { ActivityPolicy, ActivityRunReason, ActivityState } from "./tab-activity-model";

// The sysinfo chart while its panel or the window is not focused (FR-PERF-009-AC3).
export const SysinfoUnfocusedRedrawMs = 5000;

type TabActivityElectronApi = {
    moltentermGetWindowActivity?: () => WindowActivity;
    onMoltentermWindowActivity?: (callback: (activity: WindowActivity) => void) => void;
};

function activityApi(): TabActivityElectronApi {
    return ((globalThis as any).api ?? {}) as TabActivityElectronApi;
}

// This view is on screen when its window shows its workspace and the workspace's active tab is its tab. Unknown
// values count as on screen: a view must never stop its work for lack of data.
export function makeOnScreenAtom(
    windowWorkspaceId: Atom<string>,
    viewWorkspaceId: Atom<string>,
    viewWorkspace: Atom<Workspace>,
    staticTabId: Atom<string>
): Atom<boolean> {
    return atom((get) => {
        const shown = windowWorkspaceId == null ? null : get(windowWorkspaceId);
        const own = viewWorkspaceId == null ? null : get(viewWorkspaceId);
        if (shown != null && own != null && shown !== own) {
            return false;
        }
        const activeTabId = viewWorkspace == null ? null : get(viewWorkspace)?.activetabid;
        const tabId = staticTabId == null ? null : get(staticTabId);
        return activeTabId == null || tabId == null || activeTabId === tabId;
    });
}

export class TabActivity {
    private static instance: TabActivity = null;

    windowAtom = atom(null) as PrimitiveAtom<WindowActivity>;
    documentFocusedAtom = atom(true) as PrimitiveAtom<boolean>;
    documentVisibleAtom = atom(true) as PrimitiveAtom<boolean>;
    onScreenAtom: Atom<boolean>;
    stateAtom: Atom<ActivityState>;
    scheduler: ActivityScheduler;
    started = false;

    private constructor() {
        // The global atoms exist only once the view is initialised: the derived atom is built at the first read after.
        let derived: Atom<boolean> = null;
        const onScreenAtom = atom((get) => {
            if (atoms == null) {
                return true;
            }
            derived ??= makeOnScreenAtom(
                getWindowWorkspaceIdAtom(),
                atoms.workspaceId,
                atoms.workspace,
                atoms.staticTabId
            );
            return get(derived);
        });
        this.onScreenAtom = onScreenAtom;
        this.stateAtom = atom((get) =>
            deriveActivity({
                window: get(this.windowAtom),
                documentFocused: get(this.documentFocusedAtom),
                documentVisible: get(this.documentVisibleAtom),
                onScreen: get(onScreenAtom),
            })
        );
        this.scheduler = new ActivityScheduler("active");
    }

    static getInstance(): TabActivity {
        if (!TabActivity.instance) {
            TabActivity.instance = new TabActivity();
        }
        return TabActivity.instance;
    }

    static resetInstance(): void {
        TabActivity.instance = null;
    }

    // Called once the view is initialised for its tab (wave.ts), and by the first job otherwise. Idempotent.
    start() {
        if (this.started) {
            return;
        }
        this.started = true;
        // For the performance harness and DevTools: the state and the jobs holding a timer.
        (globalThis as any).moltenTabActivity = this;
        const api = activityApi();
        try {
            globalStore.set(this.windowAtom, api.moltentermGetWindowActivity?.() ?? null);
            api.onMoltentermWindowActivity?.((activity) => globalStore.set(this.windowAtom, activity ?? null));
        } catch (e) {
            console.log("tab activity: no window state from the main process", e);
        }
        if (globalThis.document != null) {
            const readDocument = () => {
                globalStore.set(this.documentVisibleAtom, document.visibilityState !== "hidden");
                globalStore.set(this.documentFocusedAtom, document.hasFocus());
            };
            readDocument();
            document.addEventListener("visibilitychange", readDocument);
            window.addEventListener("focus", readDocument);
            window.addEventListener("blur", readDocument);
        }
        this.applyState();
        globalStore.sub(this.stateAtom, () => this.applyState());
    }

    // Re-reads the window state from the main process: a reused view (wave-init again) may belong to another window.
    refreshWindow() {
        try {
            const activity = activityApi().moltentermGetWindowActivity?.();
            if (activity != null) {
                globalStore.set(this.windowAtom, activity);
            }
        } catch {
            // The pushed updates keep the state.
        }
    }

    state(): ActivityState {
        return globalStore.get(this.stateAtom);
    }

    every(policy: ActivityPolicy, run: (reason: ActivityRunReason) => void, label = ""): () => void {
        this.start();
        return this.scheduler.every(policy, run, label);
    }

    private applyState() {
        const state = globalStore.get(this.stateAtom);
        this.scheduler.setState(state);
        const root = globalThis.document?.documentElement;
        if (root == null) {
            return;
        }
        root.dataset.mtActivity = state;
        root.dataset.mtMotion = state === "active" ? "live" : "still";
    }
}

// Hands onValue the value of source as a display should show it: every change while `live` holds and the view is
// active, a sample every slowMs while the view shows otherwise, nothing while it is hidden or minimised, and the
// current value at once when the view comes back. The sysinfo chart redraws on each value (FR-PERF-009-AC3).
export function followActivityGated<T>(
    activity: TabActivity,
    source: Atom<T>,
    live: boolean,
    slowMs: number,
    onValue: (value: T) => void
): () => void {
    const read = () => onValue(globalStore.get(source));
    let stop: () => void = null;
    let following: boolean = null;
    const apply = () => {
        const next = live && activity.state() === "active";
        if (next === following) {
            return;
        }
        following = next;
        stop?.();
        if (next) {
            read();
            stop = globalStore.sub(source, read);
            return;
        }
        stop = activity.every({ active: slowMs, visible: slowMs }, read, "gated-value");
    };
    activity.start();
    apply();
    const unsubscribeState = globalStore.sub(activity.stateAtom, apply);
    return () => {
        unsubscribeState();
        stop?.();
    };
}

export function useActivityGatedValue<T>(source: Atom<T>, live: boolean, slowMs: number): T {
    const [value, setValue] = useState<T>(() => globalStore.get(source));
    useEffect(
        () => followActivityGated(TabActivity.getInstance(), source, live, slowMs, setValue),
        [source, live, slowMs]
    );
    return value;
}
