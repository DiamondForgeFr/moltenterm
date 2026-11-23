// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a browser panel knows about how its tabs are served (#1980, FR-BRW-023) and about the navigations held as a
// lookalike domain (#2482, FR-BRW-024): the state Electron main sends per tab, the password warning shown for a page and
// the held navigation per tab. connectionView decides what the button next to the address shows. Kept apart from the
// view so the panel holds the state without loading the popover's code (NFR-PERF-003).

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import {
    connectionLevel,
    ConnectionState,
    insecureReason,
    LevelInsecure,
    LevelSecure,
    passwordWarningKey,
    ReasonMixed,
    warnsAboutPassword,
} from "./connection-security";
import type { LookalikeHold } from "./lookalike";

export const ViewSecure = "secure";
export const ViewInsecure = "insecure";
export const ViewMixed = "mixed";
export const ViewSuspect = "suspect";

// What the button beside the address shows: a lock, a warning, or (null) nothing for a local or non-web page.
export type ConnectionView = { kind: typeof ViewSecure | typeof ViewInsecure | typeof ViewMixed | typeof ViewSuspect };

export function connectionGlyph(kind: ConnectionView["kind"]): string {
    return kind === ViewSecure ? "fa-lock" : "fa-triangle-exclamation";
}

// The i18n key of the word a button shows for a state that is not secure.
export function connectionWordKey(kind: ConnectionView["kind"]): string {
    return `browser.connection.${kind}`;
}

// address: what the tab shows. state: what main knows of the page the guest holds, null before its first page. held: the
// navigation held for the tab. failed: the page failed to load and the error page is shown.
export function connectionView(input: {
    address: string;
    state: ConnectionState | null;
    held: LookalikeHold | null;
    failed: boolean;
}): ConnectionView {
    if (input.held != null) {
        return { kind: ViewSuspect };
    }
    if (input.failed) {
        return null;
    }
    // Before the guest's first page main has nothing: plain http still warns from the address, a lock never does.
    const address = input.state?.url ?? input.address;
    const mixed = input.state?.mixed === true;
    const level = connectionLevel(address, mixed);
    if (level === LevelSecure) {
        return input.state == null ? null : { kind: ViewSecure };
    }
    if (level === LevelInsecure) {
        return { kind: insecureReason(address, mixed) === ReasonMixed ? ViewMixed : ViewInsecure };
    }
    return null;
}

export class ConnectionModel {
    statesAtom = atom({}) as PrimitiveAtom<Record<string, ConnectionState>>;
    // The address of the page each tab's password warning shows for.
    warningsAtom = atom({}) as PrimitiveAtom<Record<string, string>>;
    private dismissed = new Set<string>();

    setState(tabId: string, state: ConnectionState): void {
        globalStore.set(this.statesAtom, { ...globalStore.get(this.statesAtom), [tabId]: state });
    }

    stateOf(tabId: string): ConnectionState {
        return globalStore.get(this.statesAtom)[tabId] ?? null;
    }

    // A password field took the focus in the page whose committed address is `address`. The page cannot ask for this
    // warning for another address: the address is read from the webview, not from the message.
    notePasswordField(tabId: string, address: string): void {
        if (!warnsAboutPassword(address) || this.dismissed.has(passwordWarningKey(tabId, address))) {
            return;
        }
        const all = globalStore.get(this.warningsAtom);
        if (all[tabId] !== address) {
            globalStore.set(this.warningsAtom, { ...all, [tabId]: address });
        }
    }

    // The warning to show for the page the tab holds now, or null.
    warningFor(tabId: string, address: string): string {
        const shown = globalStore.get(this.warningsAtom)[tabId];
        if (shown == null || !warnsAboutPassword(address)) {
            return null;
        }
        return passwordWarningKey(tabId, shown) === passwordWarningKey(tabId, address) ? shown : null;
    }

    dismissWarning(tabId: string): void {
        const all = globalStore.get(this.warningsAtom);
        const shown = all[tabId];
        if (shown == null) {
            return;
        }
        this.dismissed.add(passwordWarningKey(tabId, shown));
        const { [tabId]: _gone, ...rest } = all;
        globalStore.set(this.warningsAtom, rest);
    }

    forgetTab(tabId: string): void {
        const states = globalStore.get(this.statesAtom);
        if (states[tabId] != null) {
            const { [tabId]: _gone, ...rest } = states;
            globalStore.set(this.statesAtom, rest);
        }
        const warnings = globalStore.get(this.warningsAtom);
        if (warnings[tabId] != null) {
            const { [tabId]: _gone, ...rest } = warnings;
            globalStore.set(this.warningsAtom, rest);
        }
    }
}

export class LookalikeModel {
    holdsAtom = atom({}) as PrimitiveAtom<Record<string, LookalikeHold>>;

    hold(tabId: string, hold: LookalikeHold): void {
        globalStore.set(this.holdsAtom, { ...globalStore.get(this.holdsAtom), [tabId]: hold });
    }

    holdOf(tabId: string): LookalikeHold {
        return globalStore.get(this.holdsAtom)[tabId] ?? null;
    }

    clear(tabId: string): void {
        const all = globalStore.get(this.holdsAtom);
        if (all[tabId] != null) {
            const { [tabId]: _gone, ...rest } = all;
            globalStore.set(this.holdsAtom, rest);
        }
    }
}
