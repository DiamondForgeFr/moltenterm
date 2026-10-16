// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Reading what a close would stop (FR-SHELL-061, DS-SHELL-106), for terminals of this tab, of another tab or of the
// whole workspace: the controller status and the runtime info come from wavesrv, the agent states from the copy every
// window holds. A read that fails or is slow never holds a close: past ReadTimeoutMs the agent states decide alone.

import { atoms, getApi, getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { BlockService } from "@/app/store/services";
import { loadAndPinWaveObject, makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom } from "jotai";
import { AgentStateInfo } from "./agent-state-model";
import { AgentStates } from "./agent-state-store";
import { BusyCloseAction, RunningItem, runningOf, RunningSource } from "./busy-close-model";
import { t } from "./i18n/i18n";
import { tabShownName } from "./project/project-model";
import { tabDisplayName } from "./tab-identity";
import { workspaceShownName } from "./workspace-default-name";

export const ConfirmBusyCloseKey = "moltenterm:confirmbusyclose";
export const ReadTimeoutMs = 1500;

function unsavedWorkspaceName(): string {
    return t("rail.unsavedWorkspace");
}

export type ClosingTerminal = { blockId: string; meta?: Record<string, any>; tabId?: string };

export function busyCloseEnabled(): boolean {
    return globalStore.get(getSettingsKeyAtom(ConfirmBusyCloseKey)) !== false;
}

export function isTerminalMeta(meta: Record<string, any>): boolean {
    return meta?.view === "term";
}

function agentStateOf(blockId: string): AgentStateInfo {
    try {
        return globalStore.get(AgentStates.getInstance().dataAtom).states[blockId] ?? null;
    } catch {
        return null;
    }
}

function tabIdOf(block: Block): string {
    const parent = block?.parentoref ?? "";
    return parent.startsWith("tab:") ? parent.slice(4) : "";
}

export function closingTerminalOf(block: Block): ClosingTerminal {
    if (block == null) {
        return null;
    }
    return { blockId: block.oid, meta: block.meta, tabId: tabIdOf(block) };
}

let cachedHomeDir: string = null;

// A synchronous IPC to Electron's main process: read once, never on the path of every close.
function homeDir(): string {
    if (cachedHomeDir == null) {
        try {
            cachedHomeDir = getApi()?.getHomeDir?.() ?? "";
        } catch {
            cachedHomeDir = "";
        }
    }
    return cachedHomeDir;
}

// The name the tab shows (FR-SHELL-056): the user's, else its first panel's title.
async function readTabName(tabId: string): Promise<string> {
    if (!tabId) {
        return "";
    }
    try {
        const tab = await loadAndPinWaveObject<Tab>(makeORef("tab", tabId));
        const firstId = tab?.blockids?.[0];
        const first = firstId ? await loadAndPinWaveObject<Block>(makeORef("block", firstId)) : null;
        return tabDisplayName(tabShownName(tab), first?.meta ?? null, homeDir());
    } catch {
        return "";
    }
}

export function currentWorkspaceName(): string {
    try {
        return workspaceShownName(globalStore.get(atoms.workspace)?.name, t) || unsavedWorkspaceName();
    } catch {
        return unsavedWorkspaceName();
    }
}

function baseSource(t: ClosingTerminal, workspace: string, tab: string): RunningSource {
    const meta = t.meta ?? {};
    return {
        blockId: t.blockId,
        view: meta.view,
        controller: meta.controller,
        cmd: meta.cmd,
        agent: agentStateOf(t.blockId),
        workspace,
        tab,
    };
}

async function readSource(t: ClosingTerminal, workspace: string, tab: string): Promise<RunningSource> {
    const src = baseSource(t, workspace, tab);
    const [status, rtInfo] = await Promise.all([
        BlockService.GetControllerStatus(t.blockId).catch((): BlockControllerRuntimeStatus => null),
        RpcApi.GetRTInfoCommand(TabRpcClient, { oref: makeORef("block", t.blockId) }, { timeout: ReadTimeoutMs }).catch(
            (): ObjRTInfo => null
        ),
    ]);
    src.procStatus = status?.shellprocstatus ?? null;
    src.integration = !!rtInfo?.["shell:integration"];
    src.shellState = rtInfo?.["shell:state"] ?? null;
    src.lastCmd = rtInfo?.["shell:lastcmd"] ?? null;
    return src;
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
    return new Promise<T>((resolve) => {
        const timer = setTimeout(() => resolve(fallback()), ms);
        work.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(fallback());
            }
        );
    });
}

// What the close of these terminals would stop, agents first. workspace: the name to show, the current workspace's by
// default (a pane or a tab of this window).
export async function readRunning(terminals: ClosingTerminal[], workspace?: string): Promise<RunningItem[]> {
    const list = (terminals ?? []).filter((t) => t != null && isTerminalMeta(t.meta));
    if (list.length === 0) {
        return [];
    }
    const workspaceName = workspace ?? currentWorkspaceName();
    const fallback = () => list.map((t) => baseSource(t, workspaceName, ""));
    const sources = await withTimeout(
        Promise.all(list.map((t) => readSource(t, workspaceName, ""))),
        ReadTimeoutMs,
        fallback
    );
    const running = runningOf(sources);
    if (running.length === 0) {
        return running;
    }
    // Tab names only matter once something runs: an idle close does not wait for them.
    const tabOf = new Map(list.map((t) => [t.blockId, t.tabId]));
    const tabIds = [...new Set(running.map((r) => tabOf.get(r.blockId)).filter((id) => !!id))];
    const tabNames = new Map<string, string>();
    await withTimeout(
        Promise.all(tabIds.map(async (id) => tabNames.set(id, await readTabName(id)))),
        ReadTimeoutMs,
        () => null
    );
    return running.map((r) => ({ ...r, tab: tabNames.get(tabOf.get(r.blockId)) ?? "" }));
}

// Every terminal of a workspace, in tab order (the reset of the last workspace closes all of them).
export async function readWorkspaceRunning(workspaceId: string, workspaceName: string): Promise<RunningItem[]> {
    let entries: BlocksListEntry[] = [];
    try {
        entries =
            (await RpcApi.BlocksListCommand(TabRpcClient, { workspaceid: workspaceId }, { timeout: ReadTimeoutMs })) ??
            [];
    } catch {
        entries = [];
    }
    const terminals = entries.map((e) => ({ blockId: e.blockid, meta: e.meta, tabId: e.tabid }));
    return readRunning(terminals, workspaceShownName(workspaceName, t) || unsavedWorkspaceName());
}

export type BusyCloseRequest = {
    action: BusyCloseAction;
    running: RunningItem[];
    // The block or the tab being closed: the dialog goes when it goes (another window closed it, its shell exited).
    blockId?: string;
    tabId?: string;
    tabName?: string;
    // Asked by Electron main (FR-SHELL-062): the app's or the workspace's name, a window close that quits, and the
    // durable sessions a quit keeps.
    name?: string;
    quits?: boolean;
    kept?: RunningItem[];
    answer: (close: boolean) => void;
};

export const BusyCloseRequestAtom = atom(null) as PrimitiveAtom<BusyCloseRequest>;

export function busyDialogOpen(): boolean {
    return globalStore.get(BusyCloseRequestAtom) != null;
}

// Resolves true on Close anyway, false on Cancel, Escape, Enter or when what it closes went meanwhile.
export function askBusyClose(request: Omit<BusyCloseRequest, "answer">): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        globalStore.set(BusyCloseRequestAtom, {
            ...request,
            answer: (close: boolean) => {
                globalStore.set(BusyCloseRequestAtom, null);
                resolve(close);
            },
        });
    });
}
