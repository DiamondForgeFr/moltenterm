// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The decision behind the lookalike warning (#2482, FR-BRW-024, DS-BRW-029), without Electron: which known domains a
// navigation is compared with, which navigations are held, what each guest is held for, and which domains the developer
// opens often. emain/moltenterm-lookalike.ts wires it to webRequest, the guests and the window.

import {
    domainOfAddress,
    knownDomainsFrom,
    LookalikeHold,
    LookalikeIndex,
    shownHost,
    SourceBookmark,
    SourceFrequent,
    SourcePinned,
    type KnownDomain,
} from "../frontend/moltenterm-shell/browser/lookalike";
import { topSiteDomains } from "../frontend/moltenterm-shell/browser/lookalike-top-sites";
import { LookalikeStore } from "./moltenterm-lookalike-store";

const MaxHeldUrlChars = 8192;

export class LookalikeGate {
    private bookmarks: KnownDomain[] = [];
    private pinned: KnownDomain[] = [];
    private index: LookalikeIndex = null;
    private holds = new Map<number, LookalikeHold>();
    private agentNavigations = new Set<number>();
    private lastDomain = new Map<number, string>();

    constructor(
        private store: LookalikeStore,
        private top: KnownDomain[] = topSiteDomains()
    ) {}

    // The window's bookmarks and pinned sites, as addresses.
    setKnown(bookmarks: unknown, pinned: unknown): void {
        this.bookmarks = knownDomainsFrom(bookmarks, SourceBookmark);
        this.pinned = knownDomainsFrom(pinned, SourcePinned);
        this.index = null;
    }

    private indexNow(): LookalikeIndex {
        if (this.index == null) {
            const frequent: KnownDomain[] = this.store.frequent().map((domain) => ({ domain, source: SourceFrequent }));
            this.index = new LookalikeIndex([...this.bookmarks, ...this.pinned, ...frequent, ...this.top]);
        }
        return this.index;
    }

    // An agent is navigating this guest: a navigation held meanwhile is the agent's.
    beginAgentNavigation(wcId: number): void {
        this.agentNavigations.add(wcId);
        this.holds.delete(wcId);
    }

    endAgentNavigation(wcId: number): void {
        this.agentNavigations.delete(wcId);
    }

    // The navigation to hold, or null to let it go. A held navigation is kept for the guest until the next one commits.
    check(wcId: number, address: string): LookalikeHold {
        let url: URL;
        try {
            url = new URL(address);
        } catch {
            return null;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return null;
        }
        const domain = domainOfAddress(address);
        if (domain == null || this.store.isAllowed(domain)) {
            return null;
        }
        const match = this.indexNow().find(url.hostname);
        if (match == null) {
            return null;
        }
        const hold: LookalikeHold = {
            url: address.slice(0, MaxHeldUrlChars),
            host: shownHost(url.hostname, true),
            domain: match.domain,
            resembles: match.resembles,
            source: match.source,
            reason: match.reason,
            agent: this.agentNavigations.has(wcId),
        };
        this.holds.set(wcId, hold);
        return hold;
    }

    holdOf(wcId: number): LookalikeHold {
        return this.holds.get(wcId) ?? null;
    }

    // Whether an agent's navigation on this guest was held, for its tool's answer.
    agentWasHeld(wcId: number): boolean {
        return this.holds.get(wcId)?.agent === true;
    }

    // The developer continued: the domain opens without the warning from now on. Returns what was held.
    continueTo(wcId: number): LookalikeHold {
        const hold = this.holds.get(wcId) ?? null;
        if (hold == null) {
            return null;
        }
        this.holds.delete(wcId);
        this.store.allow(hold.domain);
        return hold;
    }

    // The page the guest shows changed: a hold is over, and entering a domain is a visit to it. An agent's pages, and the
    // pages of a guest an agent is navigating, never count, so a page an agent is led to does not become one the
    // developer knows.
    noteCommitted(wcId: number, address: string, agentControlled: boolean): void {
        this.holds.delete(wcId);
        const domain = domainOfAddress(address);
        if (domain == null) {
            this.lastDomain.delete(wcId);
            return;
        }
        const entered = this.lastDomain.get(wcId) !== domain;
        this.lastDomain.set(wcId, domain);
        if (!entered || agentControlled || this.agentNavigations.has(wcId)) {
            return;
        }
        if (this.store.visit(domain)) {
            this.index = null;
        }
    }

    forget(wcId: number): void {
        this.holds.delete(wcId);
        this.agentNavigations.delete(wcId);
        this.lastDomain.delete(wcId);
    }
}
