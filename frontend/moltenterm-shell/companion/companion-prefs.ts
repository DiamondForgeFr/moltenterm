// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The companion's remembered choices (#555), in the client's meta like the line map's window: the same for every
// companion, kept across restarts. A choice shows at once; a failed write only loses the memory of it.

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useState } from "react";
import { CompanionPrefs, CompanionPrefsMetaKey, readCompanionPrefs } from "./companion-files-model";

const NoClient = atom(null) as Atom<Client>;

function clientAtom(): Atom<Client> {
    return ClientModel.getInstance().clientAtom ?? NoClient;
}

// A second choice made before the first write came back builds on the first, not on the stale meta.
let unconfirmed: CompanionPrefs = null;

function rememberCompanionPref(key: keyof CompanionPrefs, value: boolean): void {
    const clientId = ClientModel.getInstance().clientId;
    if (clientId == null) {
        return;
    }
    const prefs = {
        ...readCompanionPrefs(unconfirmed ?? globalStore.get(clientAtom())?.meta?.[CompanionPrefsMetaKey]),
        [key]: value,
    };
    unconfirmed = prefs;
    fireAndForget(async () => {
        try {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("client", clientId),
                meta: { [CompanionPrefsMetaKey]: prefs } as MetaType,
            });
        } finally {
            if (unconfirmed === prefs) {
                unconfirmed = null;
            }
        }
    });
}

export function useCompanionPref(key: keyof CompanionPrefs): [boolean, (value: boolean) => void] {
    const client = useAtomValue(clientAtom());
    const stored = readCompanionPrefs(client?.meta?.[CompanionPrefsMetaKey])[key] === true;
    const [chosen, setChosen] = useState<boolean>(null);
    const set = (value: boolean) => {
        setChosen(value);
        rememberCompanionPref(key, value);
    };
    return [chosen ?? stored, set];
}
