// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The renderer's side of FR-SHELL-062 (DS-SHELL-109): Electron main asks what a window close, a quit, a workspace
// delete or a switch away from an unsaved workspace would stop (emain/moltenterm-busy-close.ts). This renderer acks at
// once, reads what runs with FR-SHELL-061's reader (through wavesrv, so every workspace), and shows the same dialog
// when something runs. Its answer replaces Electron's own confirmation; "off" and "none" leave that confirmation to
// decide as before.

import { getApi } from "@/app/store/global";
import { ObjectService, WorkspaceService } from "@/app/store/services";
import { makeORef } from "@/app/store/wos";
import { fireAndForget } from "@/util/util";
import { BusyCloseAction, RunningItem, splitQuitRunning } from "./busy-close-model";
import { askBusyClose, busyCloseEnabled, ReadTimeoutMs, readWorkspaceRunning } from "./busy-close-store";

export type MainBusyAsk = {
    requestid: string;
    kind: string;
    stopworkspaceids: string[];
    quit: boolean;
    name?: string;
};

export type MainBusyReply = { requestid: string; phase: string; outcome?: string };

const MainKinds = new Set<string>(["window", "quit", "delete", "switch"]);

export type MainBusyDeps = {
    reply: (reply: MainBusyReply) => void;
    enabled: () => boolean;
    // Another close dialog of this window is open: one dialog at a time, the one already open decides.
    dialogOpen: () => boolean;
    workspaceIds: () => Promise<string[]>;
    readWorkspace: (workspaceId: string) => Promise<RunningItem[]>;
    durableOf: (blockIds: string[]) => Promise<Set<string>>;
    ask: (request: {
        action: BusyCloseAction;
        running: RunningItem[];
        kept: RunningItem[];
        name?: string;
        quits?: boolean;
    }) => Promise<boolean>;
};

async function readAll(ids: string[], deps: MainBusyDeps): Promise<RunningItem[]> {
    const lists = await Promise.all(ids.map((id) => deps.readWorkspace(id).catch((): RunningItem[] => [])));
    return lists.flat();
}

// A read or a dialog that fails answers "error": Electron's confirmation decides, as for a renderer that never answered.
export async function answerMainAsk(request: MainBusyAsk, deps: MainBusyDeps): Promise<void> {
    if (request?.requestid == null) {
        return;
    }
    deps.reply({ requestid: request.requestid, phase: "ack" });
    try {
        await decideMainAsk(request, deps);
    } catch (e) {
        console.log("[#490] what the action stops could not be read", e);
        deps.reply({ requestid: request.requestid, phase: "result", outcome: "error" });
    }
}

async function decideMainAsk(request: MainBusyAsk, deps: MainBusyDeps): Promise<void> {
    const finish = (outcome: string) => deps.reply({ requestid: request.requestid, phase: "result", outcome });
    if (!MainKinds.has(request.kind) || !deps.enabled()) {
        finish("off");
        return;
    }
    if (deps.dialogOpen()) {
        finish("cancel");
        return;
    }
    const stopIds = [...new Set(request.stopworkspaceids ?? [])];
    const stopping = await readAll(stopIds, deps);
    let running = stopping;
    let kept: RunningItem[] = [];
    if (request.quit) {
        const otherIds = (await deps.workspaceIds().catch((): string[] => [])).filter((id) => !stopIds.includes(id));
        const others = await readAll(otherIds, deps);
        const durable = others.length > 0 ? await deps.durableOf(others.map((r) => r.blockId)) : new Set<string>();
        ({ running, kept } = splitQuitRunning(stopping, others, durable));
    }
    if (running.length === 0) {
        finish("none");
        return;
    }
    if (deps.dialogOpen()) {
        finish("cancel");
        return;
    }
    deps.reply({ requestid: request.requestid, phase: "asking" });
    const close = await deps.ask({
        action: request.kind as BusyCloseAction,
        running,
        kept,
        name: request.name,
        quits: request.kind === "window" && request.quit,
    });
    finish(close ? "close" : "cancel");
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
        const timer = setTimeout(() => resolve(fallback), ms);
        work.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(fallback);
            }
        );
    });
}

// Durable sessions (#72) have a job; a read that fails counts them as stopping, which asks rather than loses work.
async function durableOf(blockIds: string[]): Promise<Set<string>> {
    const read = ObjectService.GetObjects(blockIds.map((id) => makeORef("block", id))).then(
        (objs) => new Set(((objs ?? []) as Block[]).filter((b) => !!b?.jobid).map((b) => b.oid))
    );
    return withTimeout(read, ReadTimeoutMs, new Set<string>());
}

async function workspaceIds(): Promise<string[]> {
    return ((await WorkspaceService.ListWorkspaces()) ?? []).map((e) => e.workspaceid);
}

async function readWorkspace(workspaceId: string): Promise<RunningItem[]> {
    const ws = await WorkspaceService.GetWorkspace(workspaceId).catch((): Workspace => null);
    if (ws == null) {
        return [];
    }
    return readWorkspaceRunning(workspaceId, ws.name);
}

type MainBusyApi = {
    onMoltentermBusyAsk?: (callback: (request: MainBusyAsk) => void) => void;
    moltentermBusyReply?: (reply: MainBusyReply) => void;
};

let listening = false;

export function listenMainBusyAsks(dialogOpen: () => boolean): void {
    if (listening) {
        return;
    }
    const api = getApi() as unknown as MainBusyApi;
    if (api?.onMoltentermBusyAsk == null || api.moltentermBusyReply == null) {
        return;
    }
    listening = true;
    const deps: MainBusyDeps = {
        reply: (reply) => api.moltentermBusyReply(reply),
        enabled: busyCloseEnabled,
        dialogOpen,
        workspaceIds,
        readWorkspace,
        durableOf,
        ask: (req) => askBusyClose(req),
    };
    api.onMoltentermBusyAsk((request) => fireAndForget(() => answerMainAsk(request, deps)));
}
