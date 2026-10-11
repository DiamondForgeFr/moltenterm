// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Hidden browser pages frozen and discarded (#459, FR-PERF-013): the pure side, a tracker per browser panel webview
// driven by the panel's reports (shown or hidden) and by timers. emain/moltenterm-webview-lifecycle.ts gives it the
// Electron actions.
//
// Measured on develop after #454 (a 60 fps canvas page with a 16 ms interval, 44 % of a core on screen): a page whose
// tab view is hidden, whose panel tab is in the background or whose window is minimised is already throttled by
// Chromium (no frames, timers aligned to 1 s: 0 to 0.2 %). What still runs is the page's timers, network callbacks and
// media once a second; a frozen page runs nothing at all (0 %). Chromium thaws a frozen page by itself as soon as it
// is shown again (its frames run before any message of ours), so a page can never stay frozen on screen.
//
// - Hidden for FreezeDelayMs: the page is frozen (CDP Page.setWebLifecycleState), unless moltenterm:hiddenpagefreeze
//   is false.
// - Hidden for moltenterm:hiddenpagediscardmin minutes (default 10, 0 never): the panel drops the page's webview; it
//   keeps the tab's URL, title and favicon, and reloads the page at its URL and scroll position when shown.
// - Never frozen nor discarded: a page an agent drives (#301, FR-BRW-008), a page playing audio, a page whose DevTools
//   are open. Never discarded: a page holding unsaved work (a changed form field, a focused field with text in it, or
//   a beforeunload listener that asks to stay), which the tab view budget asks too (#476). A page's fields are read
//   as it freezes (a frozen page cannot change) and, when it is not frozen, again before a discard.

export const HiddenPageFreezeSetting = "moltenterm:hiddenpagefreeze";
export const HiddenPageDiscardSetting = "moltenterm:hiddenpagediscardmin";

export const DefaultDiscardMinutes = 10;
export const MaxDiscardMinutes = 1440;
// Short enough to stop a hidden page's work soon, long enough that switching back and forth costs nothing.
export const FreezeDelayMs = 5000;
// A protected page (audio, an agent, DevTools) is looked at again this often while it stays hidden.
export const FreezeRetryMs = 30000;
export const DiscardRetryMs = 60000;

export type WebviewLifecycleConfig = {
    freeze: boolean;
    discardMs: number;
};

export function readWebviewLifecycleConfig(settings: Record<string, unknown>): WebviewLifecycleConfig {
    const raw = settings?.[HiddenPageDiscardSetting];
    let minutes = DefaultDiscardMinutes;
    if (typeof raw === "number" && Number.isFinite(raw)) {
        minutes = Math.min(MaxDiscardMinutes, Math.max(0, raw));
    }
    return {
        freeze: settings?.[HiddenPageFreezeSetting] !== false,
        discardMs: Math.round(minutes * 60000),
    };
}

export type PageScroll = { x: number; y: number };

// What a page holds, read from it (emain/moltenterm-webview-lifecycle.ts). null: the page could not be read.
// dirty: a changed form field, or a focused field with text in it. unloadListener: the page listens to beforeunload,
// which many pages do for their own bookkeeping (github.com always does); whether it would really ask the user to
// stay is tried only just before the page goes (LifecycleActions.wouldPromptOnUnload).
export type PageCheck = { dirty: boolean; unloadListener: boolean; scroll: PageScroll };

export type PageProtection = {
    gone: boolean;
    controlled: boolean;
    audible: boolean;
    devtools: boolean;
};

export function protectedFromLifecycle(p: PageProtection): string {
    if (p.controlled) {
        return "an agent drives it";
    }
    if (p.audible) {
        return "it plays audio";
    }
    if (p.devtools) {
        return "its DevTools are open";
    }
    return null;
}

export type LifecycleActions = {
    now(): number;
    setTimeout(fn: () => void, ms: number): any;
    clearTimeout(handle: any): void;
    config(): WebviewLifecycleConfig;
    protection(wcId: number): PageProtection;
    // Reads the page then freezes it; null when it could not.
    freeze(wcId: number): Promise<PageCheck>;
    thaw(wcId: number): Promise<void>;
    check(wcId: number): Promise<PageCheck>;
    // Runs the page's beforeunload listeners on a test event: whether one asks to stay; null when it cannot tell. Its
    // listeners run, so it is asked only of a page about to go.
    wouldPromptOnUnload(wcId: number): Promise<boolean>;
    // Asks the panel to drop the page; it answers by reporting the webview shown or by its destruction.
    discard(wcId: number, scroll: PageScroll): void;
    log(msg: string): void;
};

type Entry = {
    wcId: number;
    shown: boolean;
    hiddenAt: number;
    frozen: boolean;
    freezing: boolean;
    check: PageCheck;
    freezeTimer: any;
    discardTimer: any;
    discardAsked: boolean;
};

export class WebviewLifecycleTracker {
    actions: LifecycleActions;
    entries = new Map<number, Entry>();

    constructor(actions: LifecycleActions) {
        this.actions = actions;
    }

    entry(wcId: number): Entry {
        return this.entries.get(wcId);
    }

    report(wcId: number, shown: boolean) {
        let e = this.entries.get(wcId);
        if (e == null) {
            e = {
                wcId,
                shown: true,
                hiddenAt: null,
                frozen: false,
                freezing: false,
                check: null,
                freezeTimer: null,
                discardTimer: null,
                discardAsked: false,
            };
            this.entries.set(wcId, e);
        }
        if (shown) {
            this.show(e);
            return;
        }
        if (!e.shown) {
            return;
        }
        e.shown = false;
        e.hiddenAt = this.actions.now();
        e.discardAsked = false;
        const cfg = this.actions.config();
        if (cfg.freeze) {
            this.armFreeze(e, FreezeDelayMs);
        }
        if (cfg.discardMs > 0) {
            this.armDiscard(e, cfg.discardMs);
        }
    }

    forget(wcId: number) {
        const e = this.entries.get(wcId);
        if (e == null) {
            return;
        }
        this.clearTimers(e);
        this.entries.delete(wcId);
    }

    // An agent took the page: it runs again at once.
    noteControlled(wcId: number) {
        const e = this.entries.get(wcId);
        if (e == null || !e.frozen) {
            return;
        }
        this.thaw(e, "an agent drives it");
    }

    noteConfigChanged() {
        const cfg = this.actions.config();
        for (const e of this.entries.values()) {
            if (e.shown) {
                continue;
            }
            if (!cfg.freeze) {
                this.actions.clearTimeout(e.freezeTimer);
                e.freezeTimer = null;
                if (e.frozen) {
                    this.thaw(e, "freezing turned off");
                }
            } else if (!e.frozen && e.freezeTimer == null) {
                this.armFreeze(e, FreezeDelayMs);
            }
            this.actions.clearTimeout(e.discardTimer);
            e.discardTimer = null;
            if (cfg.discardMs > 0 && !e.discardAsked) {
                this.armDiscard(e, Math.max(0, e.hiddenAt + cfg.discardMs - this.actions.now()));
            }
        }
    }

    // The unsaved-work answer the tab view budget asks for (#476), right before it destroys the page's tab view: a
    // frozen page's form state from when it froze, else read now. A page that cannot be read counts as holding some.
    async hasUnsavedWork(wcId: number): Promise<boolean> {
        const e = this.entries.get(wcId);
        const check = e?.frozen && e.check != null ? e.check : await this.actions.check(wcId);
        return (await this.unsavedReason(wcId, check)) != null;
    }

    private async unsavedReason(wcId: number, check: PageCheck): Promise<string> {
        if (check == null) {
            return "it could not be read";
        }
        if (check.dirty) {
            return "it holds typed text";
        }
        if (check.unloadListener && (await this.actions.wouldPromptOnUnload(wcId)) !== false) {
            return "it asks to stay on unload";
        }
        return null;
    }

    private show(e: Entry) {
        const wasHidden = !e.shown;
        e.shown = true;
        e.hiddenAt = null;
        this.clearTimers(e);
        if (wasHidden && e.frozen) {
            this.thaw(e, null);
        }
    }

    private thaw(e: Entry, why: string) {
        e.frozen = false;
        e.check = null;
        if (why != null) {
            this.actions.log(`[#459] hidden page thawed (${why}) wc ${e.wcId}`);
        }
        this.actions.thaw(e.wcId).catch(() => {});
    }

    private clearTimers(e: Entry) {
        this.actions.clearTimeout(e.freezeTimer);
        this.actions.clearTimeout(e.discardTimer);
        e.freezeTimer = null;
        e.discardTimer = null;
    }

    private armFreeze(e: Entry, ms: number) {
        this.actions.clearTimeout(e.freezeTimer);
        e.freezeTimer = this.actions.setTimeout(() => {
            e.freezeTimer = null;
            void this.tryFreeze(e);
        }, ms);
    }

    private armDiscard(e: Entry, ms: number) {
        this.actions.clearTimeout(e.discardTimer);
        e.discardTimer = this.actions.setTimeout(() => {
            e.discardTimer = null;
            void this.tryDiscard(e);
        }, ms);
    }

    private live(e: Entry): boolean {
        return this.entries.get(e.wcId) === e && !e.shown;
    }

    private async tryFreeze(e: Entry) {
        if (!this.live(e) || e.frozen || e.freezing || !this.actions.config().freeze) {
            return;
        }
        const p = this.actions.protection(e.wcId);
        if (p.gone) {
            this.forget(e.wcId);
            return;
        }
        if (protectedFromLifecycle(p) != null) {
            this.armFreeze(e, FreezeRetryMs);
            return;
        }
        e.freezing = true;
        let check: PageCheck = null;
        try {
            check = await this.actions.freeze(e.wcId);
        } finally {
            e.freezing = false;
        }
        if (check == null) {
            this.armFreeze(e, FreezeRetryMs);
            return;
        }
        e.frozen = true;
        e.check = check;
        // Shown, or taken by an agent, while it froze.
        if (!this.live(e) || this.actions.protection(e.wcId).controlled) {
            this.thaw(e, null);
        }
    }

    private async tryDiscard(e: Entry) {
        if (!this.live(e) || e.discardAsked || this.actions.config().discardMs <= 0) {
            return;
        }
        const p = this.actions.protection(e.wcId);
        if (p.gone) {
            this.forget(e.wcId);
            return;
        }
        const why = protectedFromLifecycle(p);
        if (why != null) {
            this.armDiscard(e, DiscardRetryMs);
            return;
        }
        const check = e.frozen && e.check != null ? e.check : await this.actions.check(e.wcId);
        if (!this.live(e)) {
            return;
        }
        const unsaved = await this.unsavedReason(e.wcId, check);
        if (!this.live(e)) {
            return;
        }
        if (unsaved != null) {
            this.actions.log(`[#459] hidden page kept: ${unsaved}, wc ${e.wcId}`);
            // A frozen page cannot change; another one may submit or clear its form meanwhile.
            if (!e.frozen) {
                this.armDiscard(e, DiscardRetryMs);
            }
            return;
        }
        e.discardAsked = true;
        this.actions.log(`[#459] discarding a page hidden for ${Math.round((this.actions.now() - e.hiddenAt) / 1000)} s, wc ${e.wcId}`);
        this.actions.discard(e.wcId, check.scroll);
    }
}

// A beforeunload event the page's listeners can cancel, as a closing tab would fire it (minus the dialog): a page that
// asks to stay cancels it or sets returnValue (preventDefault, `e.returnValue = ""`, an onbeforeunload returning text).
export const WouldPromptExpression = `(() => {
    const e = document.createEvent("BeforeUnloadEvent");
    e.initEvent("beforeunload", false, true);
    window.dispatchEvent(e);
    return e.defaultPrevented || (typeof e.returnValue === "string" && e.returnValue !== "");
})()`;

// Run in the page (main world, through the DevTools protocol, which also answers a frozen page): whether a form field
// was changed or a focused field holds text, and the scroll position. Frameworks keep the value attribute in step
// with the typed value (defaultValue then equals value), so the focused field is the best sign left for them.
export const PageCheckExpression = `(() => {
    const filled = (el) => (el.isContentEditable ? (el.textContent || "").trim() !== "" : String(el.value || "") !== "");
    let dirty = false;
    for (const el of document.querySelectorAll("input,textarea,select")) {
        if (el instanceof HTMLSelectElement) {
            dirty = Array.from(el.options).some((o) => o.selected !== o.defaultSelected);
        } else if (el instanceof HTMLTextAreaElement) {
            dirty = el.value !== el.defaultValue;
        } else if (el instanceof HTMLInputElement) {
            const t = el.type;
            if (t === "checkbox" || t === "radio") {
                dirty = el.checked !== el.defaultChecked;
            } else if (!["hidden", "submit", "button", "reset", "image"].includes(t)) {
                dirty = el.value !== el.defaultValue;
            }
        }
        if (dirty) break;
    }
    const a = document.activeElement;
    const focusedText = a != null && a !== document.body && (a.isContentEditable || a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) && filled(a);
    return { dirty: dirty || focusedText, x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
})()`;
