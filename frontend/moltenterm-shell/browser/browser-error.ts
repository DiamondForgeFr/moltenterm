// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A page that fails to load (FR-SHELL-051, DS-SHELL-092): MoltenTerm draws its own error page over the webview instead
// of Chromium's black one. The error is sorted into a class (DNS, refused, timeout, TLS, offline) told in one plain
// sentence; the Chromium code stays under Details. Only the host and the code are shown, never page content.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";

export type LoadErrorClass = "dns" | "refused" | "timeout" | "tls" | "offline" | "other";

export type LoadError = {
    url: string;
    code: number;
    // Chromium's name for the code (ERR_NAME_NOT_RESOLVED).
    description: string;
};

export type ErrorPageView = {
    errorClass: LoadErrorClass;
    host: string;
    title: string;
    hint: string;
    local: boolean;
    details: string;
};

// net_error_list.h: ERR_ABORTED is a navigation the user (or the page) replaced, not a failure.
export const ErrAborted = -3;

const DnsCodes = new Set([-105, -137]);
const RefusedCodes = new Set([-102, -100, -101, -104, -109]);
const TimeoutCodes = new Set([-7, -118]);
const OfflineCodes = new Set([-106, -21]);
// SSL and certificate errors outside the -200 range (protocol, cipher, client certificate, weak key).
const TlsCodes = new Set([-107, -110, -113, -117, -123, -129, -134, -141, -159]);

export function classifyLoadError(code: number): LoadErrorClass {
    if (DnsCodes.has(code) || (code <= -800 && code > -900)) {
        return "dns";
    }
    if (RefusedCodes.has(code)) {
        return "refused";
    }
    if (TimeoutCodes.has(code)) {
        return "timeout";
    }
    if (OfflineCodes.has(code)) {
        return "offline";
    }
    if (TlsCodes.has(code) || (code <= -200 && code > -300)) {
        return "tls";
    }
    return "other";
}

// A did-fail-load worth an error page: the main frame, and not an aborted navigation.
export function isPageFailure(e: { errorCode?: number; isMainFrame?: boolean }): boolean {
    return (
        e?.isMainFrame !== false && typeof e?.errorCode === "number" && e.errorCode !== ErrAborted && e.errorCode < 0
    );
}

function parseUrl(url: string): URL {
    try {
        return new URL(url);
    } catch {
        return null;
    }
}

export function isLocalHost(host: string): boolean {
    const h = (host ?? "").toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || /^127\./.test(h);
}

function plainHint(errorClass: LoadErrorClass, local: boolean, port: string): string {
    switch (errorClass) {
        case "dns":
            return "The address could not be found. Check it for typos.";
        case "refused":
            if (local) {
                return port ? `Nothing is answering on port ${port}.` : "Nothing is answering on this machine.";
            }
            return "The server refused the connection.";
        case "timeout":
            return "The server took too long to answer.";
        case "tls":
            return "The site's security certificate can't be trusted, so the page was not opened.";
        case "offline":
            return "You seem to be offline. Check your connection.";
        default:
            return "The page could not be loaded.";
    }
}

export function errorPageView(error: LoadError): ErrorPageView {
    const u = parseUrl(error?.url);
    const host = u?.host || error?.url || "this page";
    const local = isLocalHost(u?.hostname);
    const errorClass = classifyLoadError(error?.code);
    const code = error?.description ? `${error.description} (${error.code})` : `Error ${error?.code}`;
    return {
        errorClass,
        host,
        title: `Can't reach ${host}`,
        hint: plainHint(errorClass, local, u?.port ?? ""),
        local,
        details: code,
    };
}

type TabErrorState = { error?: LoadError; failedSinceStart?: boolean; retrying?: boolean };

// The failed page per tab, in memory. A load clears the error only once it ends without failing, so a Retry that
// fails again keeps the page up instead of flashing the webview.
export class BrowserErrorModel {
    errorsAtom = atom({}) as PrimitiveAtom<Record<string, TabErrorState>>;

    get(tabId: string): TabErrorState {
        return globalStore.get(this.errorsAtom)[tabId];
    }

    error(tabId: string): LoadError {
        return this.get(tabId)?.error ?? null;
    }

    update(tabId: string, patch: TabErrorState): void {
        const all = globalStore.get(this.errorsAtom);
        globalStore.set(this.errorsAtom, { ...all, [tabId]: { ...(all[tabId] ?? {}), ...patch } });
    }

    noteStart(tabId: string): void {
        this.update(tabId, { failedSinceStart: false });
    }

    noteFailure(tabId: string, error: LoadError): void {
        this.update(tabId, { error, failedSinceStart: true, retrying: false });
    }

    noteStop(tabId: string): void {
        const state = this.get(tabId);
        if (state == null) {
            return;
        }
        if (state.failedSinceStart) {
            this.update(tabId, { retrying: false });
            return;
        }
        this.forget(tabId);
    }

    noteRetry(tabId: string): void {
        this.update(tabId, { retrying: true });
    }

    forget(tabId: string): void {
        const all = globalStore.get(this.errorsAtom);
        if (!(tabId in all)) {
            return;
        }
        const next = { ...all };
        delete next[tabId];
        globalStore.set(this.errorsAtom, next);
    }
}
