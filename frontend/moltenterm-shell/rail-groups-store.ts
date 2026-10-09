// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the rail's product groups read (FR-MC-027): the groups from Mission Control's collector, and the local groups
// kept in the client meta (this machine, never in a project).

import { ClientModel } from "@/app/store/client-model";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { fireAndForget } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { GroupsAnswer, MissionGroupsEvent, ProjectGroup } from "./mission/group-model";
import { missionGroups } from "./mission/mission-client";
import { LocalRailGroup, RailGroupsMetaKey, readLocalGroups } from "./rail-local-groups";
import { ProjectMetaKey } from "./workspace-project";

const NoClient = atom(null) as Atom<Client>;
const RailGroupsAttempts = 3;

function clientAtom(): Atom<Client> {
    return ClientModel.getInstance().clientAtom ?? NoClient;
}

// The local rail groups (FR-MC-032) as wavesrv stored them, read live from the client meta: every window sees a change
// at once. effectiveLocalGroups gives the ones the rail draws.
export function useStoredLocalGroups(): LocalRailGroup[] {
    const client = useAtomValue(clientAtom());
    const key = JSON.stringify(client?.meta?.[RailGroupsMetaKey] ?? null);
    return useMemo(() => readLocalGroups(JSON.parse(key)), [key]);
}

// The project link of each workspace, read live: linking or unlinking one changes the groups without any rail event.
// Sorted: a move alone changes no group (the collector publishes the new member order itself).
export function useWorkspaceLinksKey(ids: string[]): string {
    const idsKey = [...ids].sort().join(" ");
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
// every model the collector publishes. A model published while a request travels may have been resolved before the
// change that made the request, so the request is made again rather than its answer dropped or trusted.
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
        fireAndForget(async () => {
            for (let attempt = 0; attempt < RailGroupsAttempts && !cancelled; attempt++) {
                const heard = heardRef.current;
                try {
                    const answer = await missionGroups();
                    if (cancelled) {
                        return;
                    }
                    setGroups(answer?.groups ?? []);
                    if (heardRef.current === heard) {
                        return;
                    }
                } catch (e) {
                    console.log("rail product groups:", e?.message ?? e);
                    return;
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [key]);
    return groups;
}
