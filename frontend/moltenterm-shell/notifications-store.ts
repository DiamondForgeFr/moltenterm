// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The notification center's store (FR-SHELL-002, FR-MC-010), shared by every window through the client object's meta
// (see notifications-model.ts).

import { ClientModel } from "@/app/store/client-model";
import { atoms, getApi, getFocusedBlockId } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { activeTabIdAtom } from "@/app/store/tab-model";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom } from "jotai";
import {
    Delivery,
    deliveryOf,
    NotificationPrefs,
    NotificationPrefsMetaKey,
    NotificationSubject,
    parsePrefs,
} from "./notification-rules";
import {
    archiveResolvedUpdate,
    archiveUpdate,
    checkUnread,
    clearArchiveUpdate,
    makeNotificationId,
    MetaUpdate,
    MoltentermNotification,
    MoltentermNotificationInput,
    NotificationAction,
    notificationLocation,
    notificationTabToActivate,
    openCount,
    parseNotifications,
    publishUpdate,
    readAllUpdate,
    readUpdate,
    resolveUpdate,
    unreadCount,
} from "./notifications-model";
import { openMoltentermView } from "./open-view";

// What a named action reports: resolve closes the notification's situation.
export type NotificationGestureResult = { ok: boolean; resolve?: boolean; error?: string };
export type NotificationGesture = (args: Record<string, any>) => Promise<NotificationGestureResult>;

export const UnknownGestureError = "This action is not available in this version.";

// Named actions, registered by the code that owns them; a notification only stores the name, so its button still
// works after a restart once that code has registered again.
const gestures = new Map<string, NotificationGesture>();

export function registerNotificationGesture(name: string, gesture: NotificationGesture): () => void {
    gestures.set(name, gesture);
    return () => {
        if (gestures.get(name) === gesture) {
            gestures.delete(name);
        }
    };
}

type Location = Pick<MoltentermNotification, "workspaceid" | "tabid" | "blockid">;

export class MoltentermNotifications {
    private static instance: MoltentermNotifications = null;

    entriesAtom: Atom<MoltentermNotification[]>;
    unreadCountAtom: Atom<number>;
    openCountAtom: Atom<number>;
    // What each subject may say (FR-MC-019), shared by every window and wavesrv through the client meta.
    prefsAtom: Atom<NotificationPrefs>;
    // "<notification id>:<action id>" of the actions running, and the last failure per notification.
    runningAtom = atom({}) as PrimitiveAtom<Record<string, boolean>>;
    errorsAtom = atom({}) as PrimitiveAtom<Record<string, string>>;

    private constructor() {
        this.entriesAtom = atom((get) => {
            const clientAtom = ClientModel.getInstance().clientAtom;
            return parseNotifications(clientAtom == null ? null : get(clientAtom)?.meta);
        });
        this.unreadCountAtom = atom((get) => unreadCount(get(this.entriesAtom)));
        this.openCountAtom = atom((get) => openCount(get(this.entriesAtom)));
        this.prefsAtom = atom((get) => {
            const clientAtom = ClientModel.getInstance().clientAtom;
            return parsePrefs((clientAtom == null ? null : get(clientAtom)?.meta)?.[NotificationPrefsMetaKey]);
        });
    }

    setDelivery(subject: NotificationSubject, delivery: Delivery): void {
        this.write({ [NotificationPrefsMetaKey]: { ...globalStore.get(this.prefsAtom), [subject]: delivery } });
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
        if (clientId == null || update == null || Object.keys(update).length === 0) {
            return;
        }
        await RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("client", clientId), meta: update });
    }

    write(update: MetaUpdate): void {
        fireAndForget(() => this.writeNow(update));
    }

    // Without a workspace or a tab, the notification belongs to where it is raised. A subject the user turned off is
    // not stored; a quiet one is stored as read.
    publish(input: MoltentermNotificationInput): void {
        const delivery = deliveryOf(input, globalStore.get(this.prefsAtom));
        if (delivery === "off") {
            return;
        }
        const now = Date.now();
        const full: MoltentermNotificationInput = {
            ...input,
            read: input.read || delivery === "quiet",
            ...notificationLocation(input, globalStore.get(atoms.workspace), globalStore.get(activeTabIdAtom)),
        };
        this.write(publishUpdate(this.entries(), full, now, makeNotificationId(now)));
    }

    resolve(key: string): void {
        this.write(resolveUpdate(this.entries(), key, Date.now()));
    }

    markRead(ids: string[]): void {
        this.write(readUpdate(this.entries(), ids));
    }

    markAllRead(): void {
        this.write(readAllUpdate(this.entries()));
    }

    archive(ids: string[]): void {
        this.write(archiveUpdate(this.entries(), ids, Date.now()));
    }

    // When the panel closes after the user saw it.
    settleSeen(): void {
        const entries = this.entries();
        this.write({ ...readAllUpdate(entries), ...archiveResolvedUpdate(entries, Date.now()) });
    }

    clearArchive(): void {
        this.write(clearArchiveUpdate(this.entries()));
    }

    // Goes to a place: its workspace, then its tab, then its block.
    goTo(location: Location): void {
        const workspace = globalStore.get(atoms.workspace);
        if (location.workspaceid && location.workspaceid !== workspace?.oid) {
            getApi().switchWorkspace(location.workspaceid);
            return;
        }
        const tabId = notificationTabToActivate(location, workspace, globalStore.get(activeTabIdAtom));
        if (tabId != null) {
            getApi().setActiveTab(tabId);
            return;
        }
        if (location.blockid) {
            const layoutModel = getLayoutModelForStaticTab();
            const node = layoutModel?.getNodeByBlockId(location.blockid);
            if (node != null) {
                layoutModel.focusNode(node.id);
            }
        }
    }

    // Goes to where the notification comes from.
    async open(entry: MoltentermNotification): Promise<void> {
        // Switching workspace replaces this view: the read mark must reach wavesrv first.
        await this.writeNow(readUpdate(this.entries(), [entry.id]));
        this.goTo(entry);
    }

    private setRunning(key: string, running: boolean): void {
        const current = { ...globalStore.get(this.runningAtom) };
        if (running) {
            current[key] = true;
        } else {
            delete current[key];
        }
        globalStore.set(this.runningAtom, current);
    }

    private setError(entryId: string, error: string): void {
        const current = { ...globalStore.get(this.errorsAtom) };
        if (error) {
            current[entryId] = error;
        } else {
            delete current[entryId];
        }
        globalStore.set(this.errorsAtom, current);
    }

    // Runs one of a notification's actions; a second click while it runs does nothing.
    async runAction(entry: MoltentermNotification, action: NotificationAction): Promise<void> {
        const runKey = `${entry.id}:${action.id}`;
        if (globalStore.get(this.runningAtom)[runKey]) {
            return;
        }
        this.setError(entry.id, null);
        if (checkUnread(entry)) {
            await this.writeNow(readUpdate(this.entries(), [entry.id]));
        }
        if (action.kind === "open") {
            if (action.view) {
                await openMoltentermView(action.view);
                return;
            }
            this.goTo(action);
            return;
        }
        const gesture = gestures.get(action.gesture);
        if (gesture == null) {
            this.setError(entry.id, UnknownGestureError);
            return;
        }
        this.setRunning(runKey, true);
        try {
            const result = await gesture(action.args ?? {});
            if (!result?.ok) {
                this.setError(entry.id, `The action failed: ${result?.error ?? "unknown error"}`);
                return;
            }
            if (result.resolve && entry.key) {
                this.resolve(entry.key);
            }
        } catch (e) {
            this.setError(entry.id, `The action failed: ${e?.message ?? e}`);
        } finally {
            this.setRunning(runKey, false);
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
            .filter((e) => checkUnread(e) && e.blockid === focused && now - e.time < AutoReadWindowMs)
            .map((e) => e.id);
        if (ids.length > 0) {
            model.markRead(ids);
        }
    });
}

export function addMoltentermNotification(input: MoltentermNotificationInput): void {
    MoltentermNotifications.getInstance().publish(input);
}

export function resolveMoltentermNotification(key: string): void {
    MoltentermNotifications.getInstance().resolve(key);
}
