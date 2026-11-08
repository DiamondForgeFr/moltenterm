// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's hub in a window (FR-BOSS-009, #2002): the one BrokkHub of this view, wired to the window's own stores. The
// avatar, the scene and his panel read it; nothing else decides when he comes. It starts with the host that mounts the
// avatar (brokk-hub-host.tsx) and listens only while that host is on screen.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { modalsModel } from "@/app/store/modalmodel";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { AgentStates } from "../agent-state-store";
import { DownloadsModel } from "../downloads/downloads-store";
import { modalIsOpen } from "../modal-open";
import { MoltentermNotifications } from "../notifications-store";
import { sidebarDragAtom } from "../sidebar/sidebar-drag";
import { SidebarModel } from "../sidebar/sidebar-store";
import { TopFieldModel } from "../sidebar/top-field-store";
import { ReleaseUpdateModel } from "../update/release-update-store";
import { GoldUpdateModel } from "../update/update-store";
import { PendingHandoffs } from "./boss-handoffs";
import { BossBubbleModel } from "./boss-store";
import { UsageReadingsAtom } from "./boss-usage";
import { FaceHoverIntent } from "./brokk-avatar-model";
import { SidebarPlace, sidebarPlaceOf } from "./brokk-edge-model";
import { closedDownloadIds } from "./brokk-extra-feeds";
import { BrokkHub } from "./brokk-hub";
import { feedBrokkHub } from "./brokk-hub-feed-store";
import { VisitSettings, visitSettingsOf } from "./brokk-visit-events";
import { EmptyShared, readShared, sharedText, VisitShareKey } from "./brokk-visit-share";
import { brokkWorking } from "./brokk-watch";

function storage(): Storage {
    try {
        return globalThis.localStorage;
    } catch {
        return null;
    }
}

export class BrokkHubModel {
    private static instance: BrokkHubModel = null;

    // The block of Brokk's own session (FR-BOSS-009, AC15), once he has one: the ring around his avatar turns while it
    // works. brokk-session.ts sets it, on the first message and when it finds the session a restart left.
    sessionBlockAtom = atom(null) as PrimitiveAtom<string>;

    ownWorkingAtom: Atom<boolean>;
    settingsAtom: Atom<VisitSettings>;
    // Where the sidebar stands for Brokk (#2070): on screen (docked, or floating over the content), collapsed at the
    // window's edge with his face on it, or nowhere. With the sidebar turned off altogether (the tab bar is back), Brokk
    // hangs from the window's top edge instead.
    sidebarPlaceAtom: Atom<SidebarPlace>;
    sidebarOnScreenAtom: Atom<boolean>;
    sidebarEdgeAtom: Atom<boolean>;
    // The update on offer, a gold's build or a release's version; "" for none (FR-BOSS-009, AC11).
    updateOfferAtom: Atom<string>;
    // The downloads whose notification the developer settled or cleared (FR-BOSS-009, AC16), the same set while it holds.
    closedDownloadsAtom: Atom<ReadonlySet<string>>;
    hub: BrokkHub;
    // The hover of the title-bar face, which opens his group (FR-BOSS-009, AC53 to AC55, #2103): the face and the group
    // both tell it where the pointer is.
    faceHover: FaceHoverIntent;

    private constructor() {
        const agents = AgentStates.getInstance();
        const sidebar = SidebarModel.getInstance();
        const gold = GoldUpdateModel.getInstance();
        const release = ReleaseUpdateModel.getInstance();
        this.updateOfferAtom = atom((get) => {
            const goldOffer = get(gold.offerAtom);
            if (goldOffer != null) {
                return `gold:${goldOffer.buildId}`;
            }
            const releaseOffer = get(release.offerAtom);
            return releaseOffer != null ? `release:${releaseOffer.version}` : "";
        });
        let closedDownloads: ReadonlySet<string> = new Set();
        this.closedDownloadsAtom = atom((get) => {
            const next = closedDownloadIds(get(MoltentermNotifications.getInstance().entriesAtom));
            if (next.size === closedDownloads.size && [...next].every((id) => closedDownloads.has(id))) {
                return closedDownloads;
            }
            closedDownloads = next;
            return next;
        });
        // His session is in no list of agents (FR-BOSS-009, AC26): its state is kept apart, and only his face shows it.
        this.ownWorkingAtom = atom((get) => brokkWorking(get(agents.ownDataAtom), get(this.sessionBlockAtom)));
        this.settingsAtom = atom((get) => visitSettingsOf((key) => get(getSettingsKeyAtom(key as keyof SettingsType))));
        this.sidebarPlaceAtom = atom((get) =>
            sidebarPlaceOf(
                get(sidebar.enabledAtom),
                get(sidebar.hiddenAtom),
                get(sidebar.peekAtom),
                get(BossBubbleModel.getInstance().showAtom)
            )
        );
        this.sidebarOnScreenAtom = atom((get) => get(this.sidebarPlaceAtom) === "screen");
        this.sidebarEdgeAtom = atom((get) => get(this.sidebarPlaceAtom) === "edge");
        this.hub = new BrokkHub({
            now: () => Date.now(),
            setTimer: (run, ms) => setTimeout(run, ms),
            clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
            overlayOpen: () =>
                ContextMenuModel.getInstance().session != null ||
                modalIsOpen() ||
                modalsModel.hasOpenModals() ||
                globalStore.get(BossBubbleModel.getInstance().cardOpenAtom),
            openPanel: () => BossBubbleModel.getInstance().openCard(),
            readShared: () => readShared(storage()?.getItem(VisitShareKey), Date.now()),
            writeShared: (shared) => {
                try {
                    storage()?.setItem(VisitShareKey, sharedText(shared));
                } catch {
                    // A full or missing storage only means this view's marks stay in this view.
                }
            },
        });
        const boss = BossBubbleModel.getInstance();
        this.faceHover = new FaceHoverIntent({
            isOpen: () => globalStore.get(boss.cardOpenAtom),
            isPinned: () => globalStore.get(boss.cardPinnedAtom),
            canOpen: () =>
                ContextMenuModel.getInstance().session == null &&
                !modalIsOpen() &&
                !modalsModel.hasOpenModals() &&
                globalStore.get(sidebarDragAtom) == null,
            open: () => {
                this.hub.panelOpened();
                boss.openCard(undefined, { pinned: false });
            },
            close: () => boss.closeCard({ restoreFocus: false }),
            setTimer: (run, ms) => setTimeout(run, ms),
            clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
        });
    }

    static getInstance(): BrokkHubModel {
        if (BrokkHubModel.instance == null) {
            BrokkHubModel.instance = new BrokkHubModel();
        }
        return BrokkHubModel.instance;
    }

    // Listens to what feeds the hub, and to the other views through the storage. Returns the stop.
    start(): () => void {
        const agents = AgentStates.getInstance();
        const handoffs = PendingHandoffs.getInstance();
        const boss = BossBubbleModel.getInstance();
        const loadedAtom = atom((get) => get(agents.loadedAtom) && get(handoffs.loadedAtom));
        const stopFeeds = feedBrokkHub(this.hub, {
            store: globalStore,
            agentsAtom: agents.dataAtom,
            agentsLoadedAtom: loadedAtom,
            toHandleAtom: boss.toHandleAtom,
            settingsAtom: this.settingsAtom,
            sidebarOnScreenAtom: this.sidebarOnScreenAtom,
            sidebarEdgeAtom: this.sidebarEdgeAtom,
            searchOpenAtom: TopFieldModel.getInstance().openAtom,
            dragAtom: atom((get) => get(sidebarDragAtom) != null),
            cardOpenAtom: boss.cardOpenAtom,
            downloadsAtom: DownloadsModel.getInstance().itemsAtom,
            closedDownloadsAtom: this.closedDownloadsAtom,
            updateOfferAtom: this.updateOfferAtom,
            usageAtom: UsageReadingsAtom,
        });
        const onStorage = (e: StorageEvent) => {
            if (e.key === VisitShareKey) {
                this.hub.sharedChanged(e.newValue == null ? EmptyShared : readShared(e.newValue, Date.now()));
            }
        };
        window.addEventListener("storage", onStorage);
        return () => {
            window.removeEventListener("storage", onStorage);
            stopFeeds();
        };
    }
}
