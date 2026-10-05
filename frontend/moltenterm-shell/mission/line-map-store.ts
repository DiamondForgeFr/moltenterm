// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The line map's time window, remembered per project in the client's meta (FR-MC-022).

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useCallback, useState } from "react";
import { lineMapDays, LineMapMetaKey, withLineMapDays } from "./line-map-model";

const NoClient = atom(null) as Atom<Client>;

function clientAtom(): Atom<Client> {
    return ClientModel.getInstance().clientAtom ?? NoClient;
}

// The window to draw and its setter. The choice shows at once; the meta write follows, and a failed write only loses
// the memory of it.
export function useLineMapDays(dir: string, full: boolean): [number, (days: number) => void] {
    const client = useAtomValue(clientAtom());
    const stored = lineMapDays(client?.meta?.[LineMapMetaKey], dir, full);
    const [chosen, setChosen] = useState<number>(null);
    const set = useCallback(
        (days: number) => {
            setChosen(days);
            const clientId = ClientModel.getInstance().clientId;
            if (clientId == null) {
                return;
            }
            const prefs = globalStore.get(clientAtom())?.meta?.[LineMapMetaKey];
            fireAndForget(() =>
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: makeORef("client", clientId),
                    meta: { [LineMapMetaKey]: withLineMapDays(prefs, dir, full, days) } as MetaType,
                })
            );
        },
        [dir, full]
    );
    return [chosen ?? stored, set];
}
