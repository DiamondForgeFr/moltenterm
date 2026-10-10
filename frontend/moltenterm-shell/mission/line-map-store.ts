// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The line map's time window, remembered per project in the client's meta (FR-MC-022).

import { ClientModel } from "@/app/store/client-model";
import { getBlockMetaKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { LineMapDaysMetaKey } from "../widget-options";
import { LocalBuild, localBuildsOf } from "./line-map-builds";
import { FullLineMapDayChoices, lineMapDays, LineMapMetaKey, LineMapPrefs, withLineMapDays } from "./line-map-model";
import { missionBuilds, useMissionRuns } from "./mission-client";

const NoClient = atom(null) as Atom<Client>;
const NoPanelDays = atom(null) as Atom<unknown>;

function clientAtom(): Atom<Client> {
    return ClientModel.getInstance().clientAtom ?? NoClient;
}

// The meta key holds every project's choice and a write replaces it whole: a second choice made before the first
// write came back builds on the first, not on the stale meta.
let unconfirmed: LineMapPrefs = null;

// The project's window that the command panel names This project (FR-SHELL-049); undefined when none was chosen.
export function rememberedLineMapDays(dir: string, full: boolean): number {
    const prefs = (unconfirmed ?? globalStore.get(clientAtom())?.meta?.[LineMapMetaKey]) as LineMapPrefs;
    const entry = dir && prefs != null && typeof prefs === "object" ? prefs[dir] : null;
    const value = full ? entry?.fulldays : entry?.days;
    return value == null ? undefined : lineMapDays(prefs, dir, full);
}

// Also what This project sets and resets in the command panel (FR-SHELL-049): no days forgets the choice.
export function rememberLineMapDays(dir: string, full: boolean, days: number): void {
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

// The full map's This panel window (FR-SHELL-049), when the panel's command panel set one it may draw.
export function panelLineMapDays(value: unknown): number {
    return typeof value === "number" && FullLineMapDayChoices.includes(value) ? value : null;
}

// The window to draw and its setter. The choice shows at once; the meta write follows, and a failed write only loses
// the memory of it. A panel that holds its own window (This panel) keeps a new choice for itself.
export function useLineMapDays(dir: string, full: boolean, blockId?: string): [number, (days: number) => void] {
    const client = useAtomValue(clientAtom());
    const panelValue = useAtomValue(
        blockId ? getBlockMetaKeyAtom(blockId, LineMapDaysMetaKey as keyof MetaType) : NoPanelDays
    );
    const panelDays = full ? panelLineMapDays(panelValue) : null;
    const stored = panelDays ?? lineMapDays(client?.meta?.[LineMapMetaKey], dir, full);
    const [chosen, setChosen] = useState<{ dir: string; days: number; panel: number }>(null);
    const set = useCallback(
        (days: number) => {
            setChosen({ dir, days, panel: panelDays });
            if (panelDays != null) {
                fireAndForget(() =>
                    RpcApi.SetMetaCommand(TabRpcClient, {
                        oref: makeORef("block", blockId),
                        meta: { [LineMapDaysMetaKey]: days } as MetaType,
                    })
                );
                return;
            }
            rememberLineMapDays(dir, full, days);
        },
        [dir, full, blockId, panelDays]
    );
    // A window set or reset from the command panel wins over the last click.
    const current = chosen?.dir === dir && chosen.panel === panelDays ? chosen.days : stored;
    return [current, set];
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
