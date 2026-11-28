// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the window feeds Brokk's hub with (FR-BOSS-009, AC5, AC8, AC11, AC14, #2002): the rows To handle, the agent states,
// the settings, and what happens in the sidebar (the search field, a drag, the sidebar being on screen) and around it
// (his panel opening or closing). One subscription per source, each telling the hub only when its value changed. The
// sources are handed in, so the wiring is tested against a store of its own; brokk-hub-store.ts hands in the window's.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import type { Atom, createStore } from "jotai";
import type { AgentSeenView, AgentStatesData } from "../agent-state-model";
import type { DownloadRecord } from "../downloads/downloads-model";
import type { ToHandleList } from "./boss-to-handle-model";
import type { UsageReadings } from "./boss-usage";
import {
    acknowledgeDownloads,
    downloadEventsOf,
    DownloadsSource,
    EmptyUsageMemory,
    makeDownloadsMemory,
    securityFixEventsOf,
    SecurityFixSource,
    updateEventsOf,
    UpdateSource,
    type UsageMemory,
    UsageSource,
} from "./brokk-extra-feeds";
import type { BrokkHub } from "./brokk-hub";
import type { UsageContext } from "./brokk-usage-model";
import type { VisitSettings } from "./brokk-visit-events";

// The rules that tell which plan usage calls him load when a reading first comes: until then there is nothing to tell
// (NFR-PERF-003, bundle.initialJsMB, #2341). A test loads them first, so that a change is told in the event that brought it.
type UsageVisit = typeof import("./brokk-usage-visit");
let usageVisit: UsageVisit = null;

export function loadUsageVisit(): Promise<UsageVisit> {
    return import("./brokk-usage-visit").then((mod) => (usageVisit = mod));
}

type Store = Pick<ReturnType<typeof createStore>, "get" | "sub">;

export type HubSources = {
    store: Store;
    agentsAtom: Atom<AgentStatesData>;
    agentsLoadedAtom: Atom<boolean>;
    toHandleAtom: Atom<ToHandleList>;
    settingsAtom: Atom<VisitSettings>;
    // Brokk is turned on (boss:show, #2218): off, he raises nothing, and the sources still feed the badge's keys. A window
    // without one leaves it out.
    onAtom?: Atom<boolean>;
    // The sidebar is on screen: docked, or floating over the content. Hidden, there is no scene to stand on.
    sidebarOnScreenAtom: Atom<boolean>;
    // The sidebar is collapsed at the window's edge with his face on it (#2070): the visit stands there, half open, and
    // the pointer rules do not hold it. A window without one leaves it out.
    sidebarEdgeAtom?: Atom<boolean>;
    // The top field (the search field) is open: it holds the focus.
    searchOpenAtom: Atom<boolean>;
    // A view, a tile or a block is being dragged in the sidebar.
    dragAtom: Atom<boolean>;
    // His panel is open.
    cardOpenAtom: Atom<boolean>;
    // The downloads (#1992), the update on offer ("" for none: a gold's build or a release's version) and the plan usage
    // readings (brokk-extra-feeds.ts). A window without one leaves it out.
    downloadsAtom?: Atom<DownloadRecord[]>;
    // The downloads whose notification was settled or cleared: their event is handled (FR-BOSS-009, AC16).
    closedDownloadsAtom?: Atom<ReadonlySet<string>>;
    updateOfferAtom?: Atom<string>;
    // The keys of the notifications of a security fix that are still open (FR-REV-036 AC13, #2589): the fix MoltenTerm
    // started, or that needs the developer. A window without one leaves it out.
    securityFixKeysAtom?: Atom<string[]>;
    usageAtom?: Atom<UsageReadings>;
    // What the usage grid reads besides the readings (#2341): the use of each agent over 7 days and the developer's
    // choices. A provider the grid does not show never brings him for its usage. A window without one leaves it out, and
    // every provider counts.
    usageContextAtom?: Atom<UsageContext>;
    // Where the plan usage already seen is kept across restarts (#2223), read anew at each feed: every page shares it
    // (#2391). A window without one starts empty each time.
    usageMemory?: { read: () => UsageMemory; write: (memory: UsageMemory) => void };
    // The update offer already shown, shared by every page (#2391). A window without one keeps it itself.
    updateSeen?: { read: () => string; write: (offer: string) => void };
    // The last moment the developer opened his group, in any page (FR-BOSS-009, AC106, #2391): what finished or ended
    // before it is heard. A window without one counts from when it began to listen.
    heardAtAtom?: Atom<number>;
    // Changes when what the pages share changed (the client's meta): the feeds read it again.
    sharedAtom?: Atom<unknown>;
    // This page writes what every page computes the same way (pageWrites in brokk-marks-store.ts): the page the
    // developer is in. A window without one writes it.
    writesShared?: () => boolean;
    // What this tab view shows the developer (makeSeenViewAtom, #2166): what is in it does not bring him. A window
    // without one leaves it out.
    inViewAtom?: Atom<AgentSeenView>;
    // The agents whose Done card the Notifications panel still lists (#2210): a finish whose card the developer archived
    // leaves the badge. A window without one leaves it out.
    openDoneAtom?: Atom<ReadonlySet<string>>;
    // The keys of the events of another context than the window's (FR-BOSS-009, #2476), sorted. The agents and the rows
    // are fed whole, whichever context they are of, so that an event that merely leaves the window's scope is not taken
    // for one that ended (which forgets what was told of it, for every view); these keys only keep such an event out of
    // what the hub shows and counts. A window without one shows every event.
    hiddenKeysAtom?: Atom<string[]>;
};

// Reads `atom` now and at every change, and calls `tell` with the new value each time it differs from the last. The
// first reading is told only when `tellFirst` says so: a drag that ends is a gesture, one that never began is not.
function follow<T>(
    store: Store,
    atom: Atom<T>,
    tell: (value: T) => void,
    tellFirst: (value: T) => boolean = () => true
): () => void {
    let last = store.get(atom);
    if (tellFirst(last)) {
        tell(last);
    }
    return store.sub(atom, () => {
        const next = store.get(atom);
        if (next !== last) {
            last = next;
            tell(next);
        }
    });
}

// The downloads, the update notice and the plan usage, each raising its events while the fact holds and the developer has
// not opened Brokk since. Returns what to call on a change, on opening, and the sources to listen to.
function extraFeeds(hub: BrokkHub, src: HubSources) {
    const { store } = src;
    const startedAt = Date.now();
    let downloads = makeDownloadsMemory(startedAt);
    let securitySeen: ReadonlySet<string> = new Set();
    let localUpdate = "";
    let localUsage = EmptyUsageMemory;
    const seenUpdate = () => (src.updateSeen != null ? src.updateSeen.read() : localUpdate);
    const usage = () => (src.usageMemory != null ? src.usageMemory.read() : localUsage);
    // `gesture`: the developer opened his group here, so this page writes it. Otherwise the memory only moves because a
    // provider cooled down, which every page reads the same: only the page the developer is in writes it.
    const keepUsage = (before: UsageMemory, next: UsageMemory, gesture: boolean) => {
        if (next === before) {
            return;
        }
        localUsage = next;
        if (gesture || (src.writesShared?.() ?? true)) {
            src.usageMemory?.write(next);
        }
    };
    // The downloads that ended before his group was last opened, in any page, are heard (#2391).
    const floor = () => (src.heardAtAtom != null ? store.get(src.heardAtAtom) || startedAt : startedAt);
    const items = () => (src.downloadsAtom != null ? store.get(src.downloadsAtom) : []);
    const offer = () => (src.updateOfferAtom != null ? store.get(src.updateOfferAtom) : "");
    const readings = () => (src.usageAtom != null ? store.get(src.usageAtom) : {});
    const usageContext = () => (src.usageContextAtom != null ? store.get(src.usageContextAtom) : undefined);
    const closed = () => (src.closedDownloadsAtom != null ? store.get(src.closedDownloadsAtom) : undefined);
    const feedDownloads = () =>
        hub.feed(DownloadsSource, downloadEventsOf({ ...downloads, floor: floor() }, items(), closed()));
    const feedUpdate = () => hub.feed(UpdateSource, updateEventsOf(offer(), seenUpdate()));
    const securityKeys = () => (src.securityFixKeysAtom != null ? store.get(src.securityFixKeysAtom) : []);
    const feedSecurityFix = () => hub.feed(SecurityFixSource, securityFixEventsOf(securityKeys(), securitySeen));
    // Runs `run` with the rules at hand: at once when they are loaded, else when they are, and never for no reading at all,
    // which has nothing to tell.
    const withVisit = (run: (visit: UsageVisit) => void) => {
        if (usageVisit != null) {
            run(usageVisit);
        } else if (Object.keys(readings() ?? {}).length > 0) {
            loadUsageVisit().then(run, () => {});
        }
    };
    const feedUsage = () =>
        withVisit((visit) => {
            const before = usage();
            const step = visit.usageEventsAfter(before, readings(), hub.now(), usageContext());
            keepUsage(before, step.memory, false);
            hub.feed(UsageSource, step.events);
        });
    const acknowledgeUsageSeen = () =>
        withVisit((visit) => {
            const before = usage();
            const next = visit.acknowledgeUsage(readings(), hub.now(), before, usageContext());
            const same = next.seen.size === before.seen.size && [...next.seen].every((p) => before.seen.has(p));
            keepUsage(before, same ? before : next, true);
        });
    const feedAll = () => {
        feedDownloads();
        feedUpdate();
        feedUsage();
        feedSecurityFix();
    };
    const acknowledge = () => {
        downloads = acknowledgeDownloads(downloads, items());
        securitySeen = new Set([...securitySeen, ...securityKeys()]);
        if (offer() !== seenUpdate()) {
            localUpdate = offer();
            src.updateSeen?.write(offer());
        }
        acknowledgeUsageSeen();
        feedAll();
    };
    const stops = [
        src.downloadsAtom != null ? store.sub(src.downloadsAtom, feedDownloads) : null,
        src.closedDownloadsAtom != null ? store.sub(src.closedDownloadsAtom, feedDownloads) : null,
        src.updateOfferAtom != null ? store.sub(src.updateOfferAtom, feedUpdate) : null,
        src.securityFixKeysAtom != null ? store.sub(src.securityFixKeysAtom, feedSecurityFix) : null,
        src.usageAtom != null ? store.sub(src.usageAtom, feedUsage) : null,
        src.usageContextAtom != null ? store.sub(src.usageContextAtom, feedUsage) : null,
        src.heardAtAtom != null ? store.sub(src.heardAtAtom, feedDownloads) : null,
    ].filter((stop) => stop != null);
    feedAll();
    return { acknowledge, feedAll, stop: () => stops.forEach((stop) => stop()) };
}

export function feedBrokkHub(hub: BrokkHub, src: HubSources): () => void {
    const { store } = src;
    const readings = () => {
        if (!store.get(src.agentsLoadedAtom)) {
            return;
        }
        // The scope first: an event of another context read before it would bring him for a moment.
        if (src.hiddenKeysAtom != null) {
            hub.scope(store.get(src.hiddenKeysAtom));
        }
        hub.agents(store.get(src.agentsAtom), src.openDoneAtom != null ? store.get(src.openDoneAtom) : undefined);
        hub.syncRows(store.get(src.toHandleAtom).items);
        hub.markReady();
    };
    // The switch comes first: an event read before it would bring him for a moment while he is off.
    const stopPower = src.onAtom != null ? follow(store, src.onAtom, (on) => hub.power(on)) : () => {};
    const extra = extraFeeds(hub, src);
    const stops = [
        stopPower,
        extra.stop,
        follow(store, src.settingsAtom, (settings) => hub.settings(settings)),
        follow(store, src.sidebarOnScreenAtom, (onScreen) => hub.gate({ type: "hidden", hidden: !onScreen })),
        src.sidebarEdgeAtom != null
            ? follow(store, src.sidebarEdgeAtom, (edge) => hub.gate({ type: "edge", edge }))
            : () => {},
        follow(store, src.searchOpenAtom, (focused) => hub.gate({ type: "search", focused })),
        src.inViewAtom != null ? follow(store, src.inViewAtom, (view) => hub.inView(view)) : () => {},
        follow(
            store,
            src.dragAtom,
            (dragging) => hub.gate({ type: dragging ? "dragstart" : "dragend" }),
            (dragging) => dragging
        ),
        follow(
            store,
            src.cardOpenAtom,
            (open) => {
                if (!open) {
                    hub.wake();
                    return;
                }
                hub.panelOpened();
                extra.acknowledge();
            },
            (open) => open
        ),
        store.sub(src.agentsAtom, readings),
        store.sub(src.agentsLoadedAtom, readings),
        store.sub(src.toHandleAtom, readings),
        src.openDoneAtom != null ? store.sub(src.openDoneAtom, readings) : () => {},
        src.hiddenKeysAtom != null ? store.sub(src.hiddenKeysAtom, readings) : () => {},
        src.heardAtAtom != null ? follow(store, src.heardAtAtom, (at) => hub.heardUntil(at)) : () => {},
        src.sharedAtom != null ? store.sub(src.sharedAtom, extra.feedAll) : () => {},
    ];
    readings();
    return () => stops.forEach((stop) => stop());
}
