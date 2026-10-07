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
import { useCallback, useEffect, useState } from "react";
import { LocalBuild, localBuildsOf } from "./line-map-builds";
import { lineMapDays, LineMapMetaKey, LineMapPrefs, withLineMapDays } from "./line-map-model";
import { missionBuilds, useMissionRuns } from "./mission-client";

const NoClient = atom(null) as Atom<Client>;

function clientAtom(): Atom<Client> {
    return ClientModel.getInstance().clientAtom ?? NoClient;
}

// The meta key holds every project's choice and a write replaces it whole: a second choice made before the first
// write came back builds on the first, not on the stale meta.
let unconfirmed: LineMapPrefs = null;

function remember(dir: string, full: boolean, days: number): void {
    const clientId = ClientModel.getInstance().clientId;
    if (clientId == null) {
        return;
    }
    const prefs = withLineMapDays(
        unconfirmed ?? globalStore.get(clientAtom())?.meta?.[LineMapMetaKey],
        dir,
        full,
        days
    );
    unconfirmed = prefs;
    fireAndForget(async () => {
        try {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("client", clientId),
                meta: { [LineMapMetaKey]: prefs } as MetaType,
            });
        } finally {
            if (unconfirmed === prefs) {
                unconfirmed = null;
            }
        }
    });
}

// The window to draw and its setter. The choice shows at once; the meta write follows, and a failed write only loses
// the memory of it.
export function useLineMapDays(dir: string, full: boolean): [number, (days: number) => void] {
    const client = useAtomValue(clientAtom());
    const stored = lineMapDays(client?.meta?.[LineMapMetaKey], dir, full);
    const [chosen, setChosen] = useState<{ dir: string; days: number }>(null);
    const set = useCallback(
        (days: number) => {
            setChosen({ dir, days });
            remember(dir, full, days);
        },
        [dir, full]
    );
    return [chosen?.dir === dir ? chosen.days : stored, set];
}

// The delivered local builds, read from their manifests (the ones the Build local menu reads) again when the project's
// history changes or a run ends: a build delivered ends a run.
export function useLocalBuilds(dir: string, historyKey: string): LocalBuild[] {
    const [builds, setBuilds] = useState<{ dir: string; list: LocalBuild[] }>(null);
    const runsKey = useMissionRuns(dir)
        .map((r) => `${r.id}:${r.state}`)
        .join(",");
    useEffect(() => {
        if (!dir) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            const facts = await missionBuilds(dir, false);
            if (!cancelled) {
                setBuilds({ dir, list: localBuildsOf(facts?.builds) });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [dir, historyKey, runsKey]);
    return builds?.dir === dir ? builds.list : null;
}
