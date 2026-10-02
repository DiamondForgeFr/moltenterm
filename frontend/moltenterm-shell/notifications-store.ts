// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The notification center's store (FR-SHELL-002), shared by every window through the client object's meta (see
// notifications-model.ts).

import { ClientModel } from "@/app/store/client-model";
import { atoms, getApi, getFocusedBlockId } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { activeTabIdAtom } from "@/app/store/tab-model";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { atom, Atom } from "jotai";
import {
    addUpdate,
    makeNotificationId,
    MetaUpdate,
    MoltentermNotification,
    MoltentermNotificationInput,
    parseNotifications,
    readAllUpdate,
    readUpdate,
} from "./notifications-model";

export class MoltentermNotifications {
    private static instance: MoltentermNotifications = null;

    entriesAtom: Atom<MoltentermNotification[]>;
    unreadCountAtom: Atom<number>;

    private constructor() {
        this.entriesAtom = atom((get) => {
            const clientAtom = ClientModel.getInstance().clientAtom;
            return parseNotifications(clientAtom == null ? null : get(clientAtom)?.meta);
        });
        this.unreadCountAtom = atom((get) => get(this.entriesAtom).filter((e) => !e.read).length);
    }

    static getInstance(): MoltentermNotifications {
        if (!MoltentermNotifications.instance) {
            MoltentermNotifications.instance = new MoltentermNotifications();
        }
        return MoltentermNotifications.instance;
    }

    entries(): MoltentermNotification[] {
        return globalStore.get(this.entriesAtom);
    }

    async writeNow(update: MetaUpdate): Promise<void> {
        const clientId = ClientModel.getInstance().clientId;
        if (clientId == null || Object.keys(update).length === 0) {
            return;
        }
        await RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("client", clientId), meta: update });
    }

    write(update: MetaUpdate): void {
        fireAndForget(() => this.writeNow(update));
    }

    // Without a workspace or a tab, the notification belongs to where it is raised.
    add(input: MoltentermNotificationInput): void {
        const now = Date.now();
        const full: MoltentermNotificationInput = {
            ...input,
            workspaceid: input.workspaceid ?? globalStore.get(atoms.workspace)?.oid,
            tabid: input.tabid ?? globalStore.get(activeTabIdAtom),
        };
        this.write(addUpdate(this.entries(), full, now, makeNotificationId(now)));
    }

    markRead(ids: string[]): void {
        this.write(readUpdate(this.entries(), ids));
    }

    markAllRead(): void {
        this.write(readAllUpdate(this.entries()));
    }

    // Goes to where the notification comes from: its workspace, then its tab, then its block.
    async open(entry: MoltentermNotification): Promise<void> {
        // Switching workspace replaces this view: the read mark must reach wavesrv first.
        await this.writeNow(readUpdate(this.entries(), [entry.id]));
        const workspace = globalStore.get(atoms.workspace);
        if (entry.workspaceid && entry.workspaceid !== workspace?.oid) {
            getApi().switchWorkspace(entry.workspaceid);
            return;
        }
        if (entry.tabid && entry.tabid !== globalStore.get(activeTabIdAtom)) {
            getApi().setActiveTab(entry.tabid);
            return;
        }
        if (entry.blockid) {
            const layoutModel = getLayoutModelForStaticTab();
            const node = layoutModel?.getNodeByBlockId(entry.blockid);
            if (node != null) {
                layoutModel.focusNode(node.id);
            }
        }
    }
}

// wavesrv records agents' signals as unread (pkg/molten/attention): it cannot know what the user looks at. A signal
// from the block the user has in front of them is marked read as soon as it arrives.
export const AutoReadWindowMs = 15000;

export function startNotificationAutoRead(): () => void {
    const model = MoltentermNotifications.getInstance();
    return globalStore.sub(model.entriesAtom, () => {
        if (!document.hasFocus() || document.visibilityState !== "visible") {
            return;
        }
        const focused = getFocusedBlockId();
        if (focused == null) {
            return;
        }
        const now = Date.now();
        const ids = model
            .entries()
            .filter((e) => !e.read && e.blockid === focused && now - e.time < AutoReadWindowMs)
            .map((e) => e.id);
        if (ids.length > 0) {
            model.markRead(ids);
        }
    });
}

export function addMoltentermNotification(input: MoltentermNotificationInput): void {
    MoltentermNotifications.getInstance().add(input);
}
