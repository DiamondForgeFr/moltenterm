// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The workspaces as the rail reads them: wavesrv's list, then each workspace (FR-SHELL-158, #2476). The sidebar, Brokk's
// scope and the switch keys of a page all need them, and a window has one page per view. A page reads them once for
// all its readers, and again only when a workspace changed: not once per reader and per change, each with a call per
// workspace.

import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceService } from "@/app/store/services";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { fireAndForget } from "@/util/util";
import type { WorkspaceRailSource } from "./workspace-rail-model";

type SourcesListener = (sources: WorkspaceRailSource[]) => void;

const listeners = new Set<SourcesListener>();
// What the last read found, and how many changes had been heard when it began: it still holds while none came since.
let last: { epoch: number; sources: WorkspaceRailSource[] } = null;
let epoch = 0;
let listening = false;
let running: Promise<WorkspaceRailSource[]> = null;
let runningEpoch = 0;
let following: Promise<WorkspaceRailSource[]> = null;

// One call for the list and one for each workspace, all at once. A workspace that cannot be read (deleted meanwhile) is
// left out.
async function fetchWorkspaceSources(): Promise<WorkspaceRailSource[]> {
    const list = (await WorkspaceService.ListWorkspaces()) ?? [];
    for (const entry of list) {
        // Wave's switcher does the same: the object atom must exist before the editor writes through it.
        globalStore.get(getWaveObjectAtom(makeORef("workspace", entry.workspaceid)));
    }
    const loaded = await Promise.all(
        list.map((entry) => WorkspaceService.GetWorkspace(entry.workspaceid).catch((): Workspace => null))
    );
    const sources: WorkspaceRailSource[] = [];
    list.forEach((entry, i) => {
        if (loaded[i]?.oid != null) {
            sources.push({ workspace: loaded[i], windowId: entry.windowid });
        }
    });
    return sources;
}

function tell(sources: WorkspaceRailSource[]) {
    for (const listener of [...listeners]) {
        try {
            listener(sources);
        } catch (e) {
            console.log("workspace sources: a reader failed", e);
        }
    }
}

function startRead(): Promise<WorkspaceRailSource[]> {
    if (running == null) {
        const started = epoch;
        runningEpoch = started;
        const read = fetchWorkspaceSources().then((sources) => {
            last = { epoch: started, sources };
            tell(sources);
            return sources;
        });
        running = read.finally(() => {
            running = null;
        });
        return running;
    }
    // Everyone who asks while a read runs shares the one read that follows it, which sees what changed meanwhile.
    following ??= running
        .then(
            () => undefined,
            () => undefined
        )
        .then(() => {
            following = null;
            return startRead();
        });
    return following;
}

function onWorkspaceUpdate() {
    epoch++;
    if (listeners.size === 0) {
        return;
    }
    fireAndForget(async () => {
        await readWorkspaceSources();
    });
}

function listen() {
    if (listening) {
        return;
    }
    try {
        waveEventSubscribeSingle({ eventType: "workspace:update", handler: onWorkspaceUpdate });
        listening = true;
    } catch (e) {
        // The preview server has no event bus: every read then goes to wavesrv.
        console.log("workspace sources: no event bus", e);
    }
}

// The workspaces, as the last read found them while no workspace changed since, or as the read that runs finds them
// when none changed since it began; else read now. fresh asks for a read that begins now, whatever was heard (a change
// that sends no event, such as the name of the workspace on screen).
export function readWorkspaceSources(options?: { fresh?: boolean }): Promise<WorkspaceRailSource[]> {
    listen();
    if (options?.fresh !== true && listening) {
        if (last != null && last.epoch === epoch) {
            return Promise.resolve(last.sources);
        }
        if (running != null && runningEpoch === epoch) {
            return running;
        }
    }
    return startRead();
}

// Always read now, as the rail's own menus did; the read is the one the other readers of the page share.
export function loadWorkspaceSources(): Promise<WorkspaceRailSource[]> {
    return readWorkspaceSources({ fresh: true });
}

// A reader that follows the workspaces: it is told what each read finds, the last one at once, and every time a
// workspace changes. Returns how it stops.
export function subscribeWorkspaceSources(listener: SourcesListener): () => void {
    listeners.add(listener);
    listen();
    if (last != null) {
        listener(last.sources);
    }
    if (last == null || !listening || last.epoch !== epoch) {
        fireAndForget(async () => {
            await readWorkspaceSources();
        });
    }
    return () => {
        listeners.delete(listener);
    };
}

export function resetWorkspaceSourcesForTest() {
    listeners.clear();
    last = null;
    epoch = 0;
    listening = false;
    running = null;
    runningEpoch = 0;
    following = null;
}
