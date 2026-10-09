// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The sign-in refusal bar of the browser panel (FR-BRW-003, DS-BRW-003). A provider that refuses embedded browsers
// (Google's "This browser or app may not be secure") is detected from its URL, in the panel tab itself or in a popup
// the tab opened (emain/moltenterm-popups.ts closes the popup); the tab then offers to continue in the installed
// browser, from the page the user was on before the provider's.

import { Button } from "@/app/element/button";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import {
    SignInBar,
    signInDismiss,
    signInOnNavigate,
    signInOnPopupRefused,
    SignInRefusal,
    SignInTabState,
} from "./browser-popup";

// The per-tab sign-in state of one panel, in memory only: a refusal is not worth restoring after a restart.
export class BrowserSignInModel {
    statesAtom = atom({}) as PrimitiveAtom<Record<string, SignInTabState>>;

    get(tabId: string): SignInTabState {
        return globalStore.get(this.statesAtom)[tabId];
    }

    set(tabId: string, next: SignInTabState): void {
        const all = globalStore.get(this.statesAtom);
        if (all[tabId] === next) {
            return;
        }
        globalStore.set(this.statesAtom, { ...all, [tabId]: next });
    }

    noteNavigation(tabId: string, url: string): void {
        this.set(tabId, signInOnNavigate(this.get(tabId), url));
    }

    notePopupRefused(tabId: string, refusal: SignInRefusal, tabUrl: string): void {
        if (refusal?.provider == null) {
            return;
        }
        this.set(tabId, signInOnPopupRefused(this.get(tabId), refusal, tabUrl));
    }

    dismiss(tabId: string): void {
        this.set(tabId, signInDismiss(this.get(tabId)));
    }

    forget(tabId: string): void {
        const all = globalStore.get(this.statesAtom);
        if (!(tabId in all)) {
            return;
        }
        const next = { ...all };
        delete next[tabId];
        globalStore.set(this.statesAtom, next);
    }

    bar(tabId: string): SignInBar {
        return this.get(tabId)?.bar ?? null;
    }
}

export type SignInBarProps = {
    signIn: BrowserSignInModel;
    tabId: string;
    // The installed browser's name, or null when none is found (the bar then only explains).
    browserName: string;
    onContinue: (bar: SignInBar) => void;
};

export function SignInRefusalBar({ signIn, tabId, browserName, onContinue }: SignInBarProps) {
    const states = useAtomValue(signIn.statesAtom);
    const bar = states[tabId]?.bar;
    if (bar == null) {
        return null;
    }
    return (
        <div
            role="alert"
            className="molten-browser-signin flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-2 py-1.5 text-12"
        >
            <i className="fa fa-solid fa-triangle-exclamation shrink-0 text-[var(--mt-state-waiting)]" />
            <span className="min-w-0 flex-1 text-primary">
                {bar.label} doesn't allow signing in from MoltenTerm's browser.
                <span className="text-secondary">
                    {browserName
                        ? ` Continue in ${browserName} from the page you were on.`
                        : " Open the page in a browser where you can sign in."}
                </span>
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
                {browserName ? (
                    <Button className="!h-6 !px-2.5 !text-12" onClick={() => onContinue(bar)}>
                        Continue in {browserName}
                    </Button>
                ) : null}
                <Button className="ghost grey !h-6 !px-2 !text-12" onClick={() => signIn.dismiss(tabId)}>
                    Dismiss
                </Button>
            </div>
        </div>
    );
}
