// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The developer's switches of Features in test (FR-BOSS-011, #2254), kept in the client's meta: in this computer's
// database, so they are never synced, and written only by a window (the metaguard refuses a terminal's write to a
// molten:* key of the client). Every window reads them from the client object, so a switch applies at once everywhere;
// wavesrv reads the same key at each call (pkg/molten/featuresintest).

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, Atom, useAtomValue } from "jotai";
import { useMemo } from "react";
import { FeaturesMetaKey, FeaturesNarrowing, NoNarrowing, readNarrowing } from "./gated-features";

const NoClient = atom(null) as Atom<Client>;

function clientAtom(): Atom<Client> {
    return ClientModel.getInstance().clientAtom ?? NoClient;
}

// Before the client is known (a test, the preview server) nothing is narrowed: the channel's own answer stays.
export function currentNarrowing(): FeaturesNarrowing {
    return readNarrowing(globalStore.get(clientAtom())?.meta?.[FeaturesMetaKey]);
}

// The same object while the switches are the same, so what depends on it (the palette's entries) is not rebuilt each
// time another part of the client's meta changes.
export function useNarrowing(): FeaturesNarrowing {
    const raw = useAtomValue(clientAtom())?.meta?.[FeaturesMetaKey];
    const key = JSON.stringify(raw ?? null);
    return useMemo(() => (raw == null ? NoNarrowing : readNarrowing(raw)), [key]);
}

// A second switch turned before the first write came back builds on the first, not on the stale meta.
let unconfirmed: FeaturesNarrowing = null;

export function narrowingToChange(): FeaturesNarrowing {
    return unconfirmed ?? currentNarrowing();
}

export async function writeNarrowing(next: FeaturesNarrowing): Promise<void> {
    const clientId = ClientModel.getInstance().clientId;
    if (clientId == null) {
        return;
    }
    unconfirmed = next;
    try {
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: makeORef("client", clientId),
            meta: { [FeaturesMetaKey]: next } as MetaType,
        });
    } finally {
        if (unconfirmed === next) {
            unconfirmed = null;
        }
    }
}
