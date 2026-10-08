// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the rail's product groups read (FR-MC-027): the groups from Mission Control's collector, and which products the
// user collapsed, kept in the client meta (this machine, never in a project).

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { GroupsAnswer, MissionGroupsEvent, ProjectGroup } from "./mission/group-model";
import { missionGroups } from "./mission/mission-client";
import { RailCollapsedMetaKey, readCollapsed, withCollapsed } from "./rail-groups";
import { ProjectMetaKey } from "./workspace-project";

const NoClient = atom(null) as Atom<Client>;

function clientAtom(): Atom<Client> {
    return ClientModel.getInstance().clientAtom ?? NoClient;
}

// The collapsed keys as the user last set them, until the client meta says the same: a toggle shows at once, and a
// second toggle made before the first write came back builds on the first.
const collapsedOverrideAtom = atom(null) as PrimitiveAtom<string[]>;

export function setProductCollapsed(key: string, collapsed: boolean): void {
    const clientId = ClientModel.getInstance().clientId;
    if (clientId == null || !key) {
        return;
    }
    const current =
        globalStore.get(collapsedOverrideAtom) ?? globalStore.get(clientAtom())?.meta?.[RailCollapsedMetaKey];
    const next = withCollapsed(current, key, collapsed);
    globalStore.set(collapsedOverrideAtom, next);
    fireAndForget(async () => {
        try {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("client", clientId),
                meta: { [RailCollapsedMetaKey]: next } as MetaType,
            });
        } catch (e) {
            console.log("remembering a collapsed product:", e?.message ?? e);
            if (globalStore.get(collapsedOverrideAtom) === next) {
                globalStore.set(collapsedOverrideAtom, null);
            }
        }
    });
}

function sameKeys(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((key) => b.includes(key));
}

export function useCollapsedProducts(): Set<string> {
    const client = useAtomValue(clientAtom());
    const override = useAtomValue(collapsedOverrideAtom);
    const storedKey = readCollapsed(client?.meta?.[RailCollapsedMetaKey]).join("\n");
    const stored = useMemo(() => (storedKey ? storedKey.split("\n") : []), [storedKey]);
    useEffect(() => {
        if (override != null && sameKeys(override, stored)) {
            globalStore.set(collapsedOverrideAtom, null);
        }
    }, [override, stored]);
    return useMemo(() => new Set(override ?? stored), [override, stored]);
}

// The project link of each workspace, read live: linking or unlinking one changes the groups without any rail event.
export function useWorkspaceLinksKey(ids: string[]): string {
    const idsKey = ids.join(" ");
    const linksAtom = useMemo(
        () =>
            atom((get) =>
                (idsKey ? idsKey.split(" ") : [])
                    .map(
                        (id) =>
                            `${id}=${get(getWaveObjectAtom<Workspace>(makeORef("workspace", id)))?.meta?.[ProjectMetaKey] ?? ""}`
                    )
                    .join("\n")
            ),
        [idsKey]
    );
    return useAtomValue(linksAtom);
}

// The groups, asked again whenever `key` changes (the rail's workspaces, their order or their links) and replaced by
// every model the collector publishes. An answer to a request made before the last published model is dropped.
export function useRailGroups(key: string): ProjectGroup[] {
    const [groups, setGroups] = useState<ProjectGroup[]>([]);
    const heardRef = useRef(0);
    useEffect(
        () =>
            waveEventSubscribeSingle({
                eventType: MissionGroupsEvent as WaveEventName,
                handler: (event) => {
                    heardRef.current++;
                    setGroups((event.data as GroupsAnswer)?.groups ?? []);
                },
            }),
        []
    );
    useEffect(() => {
        let cancelled = false;
        const heard = heardRef.current;
        fireAndForget(async () => {
            try {
                const answer = await missionGroups();
                if (!cancelled && heardRef.current === heard) {
                    setGroups(answer?.groups ?? []);
                }
            } catch (e) {
                console.log("rail product groups:", e?.message ?? e);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [key]);
    return groups;
}
