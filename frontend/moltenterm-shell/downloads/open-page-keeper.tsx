// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A download's "Reopen the page" (#1992): the request waits in the view's meta (downloads-origin.ts) and the renderer
// that shows the view opens the address in a browser panel of it, then clears the request. Mounted with the rail of
// every view, beside PaneFocusKeeper, so the page opens in the workspace and the view it came from and never in the
// one the developer was in.

import { atoms, openLink } from "@/app/store/global";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget, NullAtom } from "@/util/util";
import { Atom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { freshOpenPage, OpenPageMetaKey, OpenPageRequest, openPageRequestKey } from "./downloads-origin-model";

// The requests applied or being applied: a request is opened once, whatever re-renders the keeper goes through.
const applied = new Set<string>();

export function OpenPageKeeper() {
    const staticTabId = useAtomValue(atoms.staticTabId);
    const tab = useAtomValue(
        staticTabId == null ? (NullAtom as Atom<Tab>) : getWaveObjectAtom<Tab>(makeORef("tab", staticTabId))
    );
    const request = tab?.meta?.[OpenPageMetaKey] as OpenPageRequest;
    const key = openPageRequestKey(request);
    useEffect(() => {
        if (!key || !staticTabId) {
            return;
        }
        const clear = () =>
            fireAndForget(() =>
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: makeORef("tab", staticTabId),
                    meta: { [OpenPageMetaKey]: null } as MetaType,
                })
            );
        const url = freshOpenPage(tab?.meta, Date.now());
        if (url == null || applied.has(key)) {
            clear();
            return;
        }
        applied.add(key);
        fireAndForget(async () => {
            await openLink(url, true);
            clear();
        });
    }, [key, staticTabId]);
    return null;
}
