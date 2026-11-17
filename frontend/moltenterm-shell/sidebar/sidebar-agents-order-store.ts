// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The developer's order of the sidebar's agents (FR-SHELL-084, #2296): read from the workspace's meta, written back
// there with one meta write, so it survives a restart. A page shows its own write at once, until the workspace's meta
// changes from what it was then (another window's newer write, or this write coming back from wavesrv).

import { globalStore } from "@/app/store/jotaiStore";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { AgentOrderMetaKey, moveBy, moveWithin, readAgentOrder, savedAfterMove } from "./sidebar-agents-order";

type Pending = { value: string[]; base: string };

const NoOrder: Atom<string[]> = atom([] as string[]);

function stamp(v: unknown): string {
    return JSON.stringify(v ?? null);
}

function workspaceAtom(workspaceId: string): Atom<Workspace> {
    return getWaveObjectAtom<Workspace>(makeORef("workspace", workspaceId));
}

function savedMeta(workspaceId: string): unknown {
    return globalStore.get(workspaceAtom(workspaceId))?.meta?.[AgentOrderMetaKey];
}

export class AgentOrderModel {
    private static instance: AgentOrderModel = null;

    pendingAtom = atom({}) as PrimitiveAtom<Record<string, Pending>>;
    orderAtoms = new Map<string, Atom<string[]>>();

    private constructor() {}

    static getInstance(): AgentOrderModel {
        if (!AgentOrderModel.instance) {
            AgentOrderModel.instance = new AgentOrderModel();
        }
        return AgentOrderModel.instance;
    }

    static resetInstance(): void {
        AgentOrderModel.instance = null;
    }

    orderAtom(workspaceId: string): Atom<string[]> {
        if (!workspaceId) {
            return NoOrder;
        }
        let rtn = this.orderAtoms.get(workspaceId);
        if (rtn == null) {
            const workspace = workspaceAtom(workspaceId);
            let last: string[] = [];
            rtn = atom((get) => {
                const meta = get(workspace)?.meta?.[AgentOrderMetaKey];
                const pending = get(this.pendingAtom)[workspaceId];
                const next = pending != null && pending.base === stamp(meta) ? pending.value : readAgentOrder(meta);
                // The same array while the order holds, so the list does not re-sort on every workspace change.
                if (stamp(next) !== stamp(last)) {
                    last = next;
                }
                return last;
            });
            this.orderAtoms.set(workspaceId, rtn);
        }
        return rtn;
    }

    // dragged lands before or after target, both in `group` (the ids of one project group as shown); a move across
    // groups is refused. True when the order changed.
    moveTo(
        workspaceId: string,
        shown: string[],
        group: string[],
        dragged: string,
        target: string,
        after: boolean
    ): boolean {
        return this.apply(workspaceId, moveWithin(shown, group, dragged, target, after));
    }

    moveStep(workspaceId: string, shown: string[], group: string[], id: string, delta: -1 | 1): boolean {
        return this.apply(workspaceId, moveBy(shown, group, id, delta));
    }

    private apply(workspaceId: string, shown: string[]): boolean {
        if (!workspaceId || shown == null) {
            return false;
        }
        const next = savedAfterMove(shown, globalStore.get(this.orderAtom(workspaceId)));
        globalStore.set(this.pendingAtom, {
            ...globalStore.get(this.pendingAtom),
            [workspaceId]: { value: next, base: stamp(savedMeta(workspaceId)) },
        });
        this.save(workspaceId, next);
        return true;
    }

    // An async function: a write that throws (no backend) fails as a promise, whose failure is only logged; the page
    // keeps the order it shows.
    save(workspaceId: string, order: string[]): void {
        const write = async () => {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("workspace", workspaceId),
                meta: { [AgentOrderMetaKey]: order } as MetaType,
            });
        };
        write().catch((e) => console.log("agent order: could not save on the workspace", e));
    }
}
