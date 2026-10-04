// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The status bar's side of DS-SHELL-010: wavesrv probes the focused pane's tree (at most once a second per tree, off
// the renderer); the bar asks again when the pane's folder changes, when its shell is back at the prompt (a checkout
// just ran), when the project's CI or collector reports, and every few seconds for git run outside the terminal.

import { getBlockComponentModel } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { Atom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { MissionCiEvent, missionGet, MissionRouteId, MissionUpdateEvent } from "./mission/mission-client";
import { keepPaneState, PaneState } from "./status-bar-model";

// must match PaneCommand in pkg/molten/mission/pane.go
export const MissionPaneCommand = "moltenmissionpane";

const PaneRpcTimeoutMs = 15000;
const PanePollMs = 3000;
const PromptWatchRetryMs = 1000;
const PromptWatchMaxTries = 30;
// The linked project's collector stays warm so its pull requests are known without a Mission Control panel open.
const LinkedProjectPollMs = 60000;

// The header, the agent label and the status bar ask about the same folder at the same moments (a prompt, a CI event):
// requests for the same question share one call while it runs, and a plain request takes an answer under a second old.
const SharedAnswerMs = 1000;
const FreshShareMs = 250;
type PaneCall = { promise: Promise<PaneState>; startedAt: number; fresh: boolean; answeredAt: number };
const PaneCalls = new Map<string, PaneCall>();

// worktree: the worktree the terminal is linked to (FR-SHELL-016); the answer says where it stands.
export function paneStatus(dir: string, fresh: boolean, worktree?: string): Promise<PaneState> {
    const key = `${dir}\u0000${worktree ?? ""}`;
    const now = Date.now();
    const last = PaneCalls.get(key);
    if (last != null) {
        const running = last.answeredAt === 0;
        if (
            fresh
                ? last.fresh && running && now - last.startedAt < FreshShareMs
                : running || now - last.answeredAt < SharedAnswerMs
        ) {
            return last.promise;
        }
    }
    const call: PaneCall = { promise: null, startedAt: now, fresh, answeredAt: 0 };
    call.promise = TabRpcClient.wshRpcCall(
        MissionPaneCommand,
        { dir, fresh, worktree: worktree || undefined },
        { route: MissionRouteId, timeout: PaneRpcTimeoutMs }
    );
    call.promise.then(
        () => (call.answeredAt = Date.now()),
        () => PaneCalls.get(key) === call && PaneCalls.delete(key)
    );
    PaneCalls.set(key, call);
    if (PaneCalls.size > 256) {
        PaneCalls.delete(PaneCalls.keys().next().value);
    }
    return call.promise;
}

function shellStatusAtom(blockId: string): Atom<string> {
    const viewModel = getBlockComponentModel(blockId)?.viewModel as {
        termRef?: { current?: { shellIntegrationStatusAtom?: Atom<string> } };
    };
    return viewModel?.termRef?.current?.shellIntegrationStatusAtom ?? null;
}

// Calls onPrompt each time the block's shell is back at its prompt. The terminal may not be built yet when the block
// gets the focus: the watch retries for a while.
function watchPrompt(blockId: string, onPrompt: () => void): () => void {
    let unsubscribe: () => void = null;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> = null;
    const attach = () => {
        const statusAtom = shellStatusAtom(blockId);
        if (statusAtom == null) {
            if (++tries < PromptWatchMaxTries) {
                timer = setTimeout(attach, PromptWatchRetryMs);
            }
            return;
        }
        let last = globalStore.get(statusAtom);
        unsubscribe = globalStore.sub(statusAtom, () => {
            const next = globalStore.get(statusAtom);
            if (next === "ready" && last !== "ready") {
                onPrompt();
            }
            last = next;
        });
    };
    attach();
    return () => {
        clearTimeout(timer);
        unsubscribe?.();
    };
}

export function usePaneStatus(folder: string, blockId: string, worktree?: string): PaneState {
    const [state, setState] = useState<PaneState>(null);
    const folderRef = useRef(folder);
    folderRef.current = folder;
    const worktreeRef = useRef(worktree);
    worktreeRef.current = worktree;
    const ask = useCallback(
        (fresh: boolean) => {
            if (!folder) {
                return;
            }
            fireAndForget(async () => {
                try {
                    const next = await paneStatus(folder, fresh, worktree);
                    // An answer for a folder the pane already left, or for a link it no longer has, would show the wrong
                    // tree.
                    if (next?.dir === folderRef.current && worktree === worktreeRef.current) {
                        setState(next);
                    }
                } catch {
                    // wavesrv restarting or the folder gone: the bar keeps what it showed.
                }
            });
        },
        [folder, worktree]
    );
    useEffect(() => {
        setState((previous) => keepPaneState(previous, folder));
        if (!folder) {
            return;
        }
        ask(true);
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") {
                ask(false);
            }
        }, PanePollMs);
        const onVisible = () => {
            if (document.visibilityState === "visible") {
                ask(true);
            }
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [folder, ask]);
    useEffect(() => {
        if (!blockId) {
            return;
        }
        return watchPrompt(blockId, () => ask(true));
    }, [blockId, ask]);
    const project = state?.project ?? "";
    useEffect(() => {
        if (!project) {
            return;
        }
        const unsubscribeCi = waveEventSubscribeSingle({
            eventType: MissionCiEvent as WaveEventName,
            scope: project,
            handler: (event) => {
                if ((event.data as { status?: string })?.status !== "running") {
                    ask(true);
                }
            },
        });
        const unsubscribeMission = waveEventSubscribeSingle({
            eventType: MissionUpdateEvent as WaveEventName,
            scope: project,
            handler: () => ask(true),
        });
        return () => {
            unsubscribeCi();
            unsubscribeMission();
        };
    }, [project, ask]);
    return state;
}

export function useWarmLinkedProject(dir: string) {
    useEffect(() => {
        if (!dir) {
            return;
        }
        const warm = () => {
            if (document.visibilityState === "visible") {
                missionGet(dir).catch(() => {});
            }
        };
        warm();
        const timer = setInterval(warm, LinkedProjectPollMs);
        return () => clearInterval(timer);
    }, [dir]);
}
