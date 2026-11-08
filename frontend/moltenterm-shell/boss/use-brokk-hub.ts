// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the surfaces read of Brokk's hub (FR-BOSS-009, #2002): the answer of the visit model, a slice at a time so that a
// surface is drawn again only for what it shows, the avatar's badge, the handlers that tell the hub what happens in the
// sidebar, and the portrait's props at rest.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useMemo, useSyncExternalStore } from "react";
import { avatarSituation } from "./brokk-avatar-model";
import type { BrokkLiveProps } from "./brokk-live";
import type { HubView } from "./brokk-hub";
import { BrokkHubModel } from "./brokk-hub-store";
import { AvatarBadge, avatarBadgeOf, unmappedRowKeys } from "./brokk-hub-feed";
import { BossBubbleModel } from "./boss-store";
import { useMotionAllowed } from "./use-brokk-live";

export function useHubSelect<T>(select: (view: HubView) => T): T {
    const hub = BrokkHubModel.getInstance().hub;
    return useSyncExternalStore(
        hub.subscribe,
        () => select(hub.getView()),
        () => select(hub.getView())
    );
}

// The badge of the avatar: what the visit model counts, and the rows that are no event of its table.
export function useAvatarBadge(): AvatarBadge {
    const list = useAtomValue(BossBubbleModel.getInstance().toHandleAtom, { store: globalStore });
    const settings = useAtomValue(BrokkHubModel.getInstance().settingsAtom, { store: globalStore });
    const events = useHubSelect((view) => view.badge);
    return useMemo(() => avatarBadgeOf(list.items, events, settings), [list, events, settings]);
}

// What the badge counts, by key: the collapsed sidebar tells a new notification from one it already told (#2070).
export function useAvatarKeys(): string[] {
    const list = useAtomValue(BossBubbleModel.getInstance().toHandleAtom, { store: globalStore });
    const events = useHubSelect((view) => view.badgeKeys);
    return useMemo(() => [...events, ...unmappedRowKeys(list.items)], [list, events]);
}

// The scene is up: the content below the title row makes room for it.
export function useBrokkVisitUp(): boolean {
    return useHubSelect((view) => view.visit != null);
}

// What happens in the sidebar, as the calibration gate reads it (FR-BOSS-009, AC8): the pointer, and any click, scroll or
// keystroke. The search field, a drag and the menus are read from their own stores (brokk-hub-feed-store.ts).
export function useBrokkGateProps() {
    const hub = BrokkHubModel.getInstance().hub;
    return useMemo(
        () => ({
            onPointerEnter: () => hub.gate({ type: "enter" }),
            onPointerLeave: () => hub.gate({ type: "leave" }),
            onPointerDownCapture: () => hub.gate({ type: "act" }),
            onWheelCapture: () => hub.gate({ type: "act" }),
            onKeyDownCapture: () => hub.gate({ type: "act" }),
        }),
        [hub]
    );
}

// His animated portrait at rest: awake and calm, thinking only while his own session works. Nothing plays under reduced
// motion or in a window nobody sees, and while the scene stands in his place.
export function useAvatarLive(ownWorking: boolean, replaced: boolean): BrokkLiveProps {
    const allowed = useMotionAllowed();
    return useMemo(
        () =>
            allowed && !replaced
                ? { situation: avatarSituation(ownWorking), asked: null, rhythm: "calm" as const }
                : null,
        [allowed, replaced, ownWorking]
    );
}
