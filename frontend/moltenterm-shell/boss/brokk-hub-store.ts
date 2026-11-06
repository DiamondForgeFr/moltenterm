// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's hub in a window (FR-BOSS-009, #2002): the one BrokkHub of this view, wired to the window's own stores. The
// avatar, the scene and his panel read it; nothing else decides when he comes. It starts with the host that mounts the
// avatar (brokk-hub-host.tsx) and listens only while that host is on screen.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { modalsModel } from "@/app/store/modalmodel";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { AgentStates } from "../agent-state-store";
import { modalIsOpen } from "../modal-open";
import { SidebarModel } from "../sidebar/sidebar-store";
import { sidebarDragAtom } from "../sidebar/sidebar-drag";
import { TopFieldModel } from "../sidebar/top-field-store";
import { PendingHandoffs } from "./boss-handoffs";
import { BossBubbleModel } from "./boss-store";
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

    // The block of Brokk's own session, once he has one (his Forge workshop, FR-BOSS-004): the ring around his avatar
    // turns while it works. Nothing sets it until that workshop ships.
    sessionBlockAtom = atom(null) as PrimitiveAtom<string>;

    ownWorkingAtom: Atom<boolean>;
    settingsAtom: Atom<VisitSettings>;
    // The sidebar is on screen: docked, or floating over the content. With the sidebar turned off altogether (the tab bar
    // is back), or hidden, Brokk hangs from the window's top edge instead.
    sidebarOnScreenAtom: Atom<boolean>;
    hub: BrokkHub;

    private constructor() {
        const agents = AgentStates.getInstance();
        const sidebar = SidebarModel.getInstance();
        this.ownWorkingAtom = atom((get) => brokkWorking(get(agents.dataAtom), get(this.sessionBlockAtom)));
        this.settingsAtom = atom((get) =>
            visitSettingsOf((key) => get(getSettingsKeyAtom(key as keyof SettingsType)))
        );
        this.sidebarOnScreenAtom = atom(
            (get) => get(sidebar.enabledAtom) && (!get(sidebar.hiddenAtom) || get(sidebar.peekAtom))
        );
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
            searchOpenAtom: TopFieldModel.getInstance().openAtom,
            dragAtom: atom((get) => get(sidebarDragAtom) != null),
            cardOpenAtom: boss.cardOpenAtom,
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
