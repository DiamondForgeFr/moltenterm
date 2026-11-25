// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The addresses the lookalike warning compares a destination with that only the window knows (#2482, FR-BRW-024):
// the developer's bookmarks, kept in the client (one record each, at one place or several, #2531), and the pages pinned
// in the sidebar, kept in the client (a row per context) and in the workspace's own pinned views. The window sends them to
// Electron main, which reduces them to registrable domains and compares each main-frame navigation there. Nothing is sent
// anywhere else.

import { ClientModel } from "@/app/store/client-model";
import { atoms, getApi, globalStore, WOS } from "@/app/store/global";
import { atom } from "jotai";
import { readAllContextPins } from "../sidebar/context-pins-model";
import { PinConfigMetaKey, readPinConfig } from "../sidebar/view-pins-model";
import { BookmarksMetaKey } from "./bookmarks";
import { MoltentermBrowserView } from "./browser-model";

const PushDelayMs = 500;

// Every bookmark address of the app, each once however many places it is at.
export function bookmarkAddresses(clientMeta: Record<string, any>): string[] {
    const records = clientMeta?.[BookmarksMetaKey]?.records;
    const out: string[] = [];
    for (const record of Array.isArray(records) ? records : []) {
        if (typeof record?.url === "string") {
            out.push(record.url);
        }
    }
    return out;
}

// The address of each web page a pinned view holds, in the pins of every context (#2526) and the workspace's own.
export function pinnedAddresses(clientMeta: Record<string, any>, tabMetas: Record<string, any>[]): string[] {
    const configs = [
        ...readAllContextPins(clientMeta).map((pin) => pin.config),
        ...(tabMetas ?? []).map((meta) => readPinConfig(meta?.[PinConfigMetaKey])),
    ];
    const out: string[] = [];
    for (const config of configs) {
        for (const pane of config?.panes ?? []) {
            if (pane?.view === MoltentermBrowserView && typeof pane.url === "string") {
                out.push(pane.url);
            }
        }
    }
    return out;
}

export type KnownAddresses = { bookmarks: string[]; pinned: string[] };

export function knownAddresses(clientMeta: Record<string, any>, tabMetas: Record<string, any>[]): KnownAddresses {
    return { bookmarks: bookmarkAddresses(clientMeta), pinned: pinnedAddresses(clientMeta, tabMetas) };
}

type LookalikeKnownApi = { moltentermLookalikeKnown?: (bookmarks: string[], pinned: string[]) => void };

let started = false;

// Once per window: sends the known addresses now and each time they change, a moment after the last change.
export function startLookalikeKnownSync(): void {
    if (started) {
        return;
    }
    started = true;
    const knownAtom = atom((get) => {
        const workspace = get(atoms.workspace);
        const clientAtom = ClientModel.getInstance().clientAtom;
        const tabMetas = (workspace?.tabids ?? []).map(
            (id) => get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", id)))?.meta as Record<string, any>
        );
        return knownAddresses(clientAtom == null ? null : get(clientAtom)?.meta, tabMetas);
    });
    let sent = "";
    let timer: ReturnType<typeof setTimeout> = null;
    const push = () => {
        timer = null;
        const known = globalStore.get(knownAtom);
        const text = JSON.stringify(known);
        if (text === sent) {
            return;
        }
        sent = text;
        (getApi() as LookalikeKnownApi).moltentermLookalikeKnown?.(known.bookmarks, known.pinned);
    };
    globalStore.sub(knownAtom, () => {
        if (timer == null) {
            timer = setTimeout(push, PushDelayMs);
        }
    });
    push();
}
