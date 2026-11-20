// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's remembered choices (#555), in the client's meta like the line map's window: the same for every
// companion, kept across restarts. A choice shows at once; a failed write only loses the memory of it.

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useState } from "react";
import { CompanionPrefs, CompanionPrefsMetaKey, readCompanionPrefs } from "./companion-files-model";
import {
    CompanionLayout,
    DefaultCompanionLayout,
    isDefaultLayout,
    normalizeLayout,
    sameLayout,
} from "./companion-layout";

const NoClient = atom(null) as Atom<Client>;

function clientAtom(): Atom<Client> {
    return ClientModel.getInstance().clientAtom ?? NoClient;
}

// A second choice made before the first write came back builds on the first, not on the stale meta.
let unconfirmed: CompanionPrefs = null;

function rememberCompanionPrefs(patch: CompanionPrefs, onWritten?: () => void): void {
    const clientId = ClientModel.getInstance().clientId;
    if (clientId == null) {
        return;
    }
    const prefs = {
        ...readCompanionPrefs(unconfirmed ?? globalStore.get(clientAtom())?.meta?.[CompanionPrefsMetaKey]),
        ...patch,
    };
    unconfirmed = prefs;
    fireAndForget(async () => {
        try {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("client", clientId),
                meta: { [CompanionPrefsMetaKey]: prefs } as MetaType,
            });
            onWritten?.();
        } finally {
            if (unconfirmed === prefs) {
                unconfirmed = null;
            }
        }
    });
}

export function useCompanionPref(
    key: "filesopen" | "usagedetails" | "summariesasked"
): [boolean, (value: boolean) => void] {
    const client = useAtomValue(clientAtom());
    const stored = readCompanionPrefs(client?.meta?.[CompanionPrefsMetaKey])[key] === true;
    const [chosen, setChosen] = useState<boolean>(null);
    const set = (value: boolean) => {
        setChosen(value);
        rememberCompanionPrefs({ [key]: value });
    };
    return [chosen ?? stored, set];
}

// The layout just saved, shown until the client's meta carries it (and kept when the write failed, like the other
// choices): every companion of the window reads it, so an arrangement shows in all of them at once.
const SavedLayout = atom<CompanionLayout>(null) as PrimitiveAtom<CompanionLayout>;

function currentLayout(): CompanionLayout {
    const meta = globalStore.get(clientAtom())?.meta?.[CompanionPrefsMetaKey];
    return globalStore.get(SavedLayout) ?? readCompanionPrefs(meta).layout ?? DefaultCompanionLayout;
}

// The developer's arrangement of the sections (#2395), the default one while none is stored.
export function useCompanionLayout(): CompanionLayout {
    const client = useAtomValue(clientAtom());
    const saved = useAtomValue(SavedLayout);
    return saved ?? readCompanionPrefs(client?.meta?.[CompanionPrefsMetaKey]).layout ?? DefaultCompanionLayout;
}

// Nothing is written for a layout that is the one in force, and the default layout is stored as no layout at all.
export function saveCompanionLayout(layout: CompanionLayout): void {
    const next = normalizeLayout(layout);
    if (sameLayout(next, currentLayout())) {
        return;
    }
    globalStore.set(SavedLayout, next);
    rememberCompanionPrefs({ layout: isDefaultLayout(next) ? undefined : next }, () => {
        if (globalStore.get(SavedLayout) === next) {
            globalStore.set(SavedLayout, null);
        }
    });
}
