// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where an option's scopes read and write (DS-SHELL-086): This panel in the block's meta, All <kind>s in the
// settings (the add-config path). Writing null clears a key in both, so Reset restores what the wider scope holds.

import { atoms, getBlockMetaKeyAtom, globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { PanelScopeId, ScopeBinding } from "./panel-types";

export function writeBlockMeta(blockId: string, meta: MetaType): Promise<void> {
    return RpcApi.SetMetaCommand(TabRpcClient, { oref: WOS.makeORef("block", blockId), meta });
}

export function writeSettings(settings: Record<string, unknown>): Promise<void> {
    return RpcApi.SetConfigCommand(TabRpcClient, settings as SettingsType);
}

export function readBlockMeta(blockId: string, key: string): unknown {
    return globalStore.get(getBlockMetaKeyAtom(blockId, key as keyof MetaType));
}

export function readSettings(key: string): unknown {
    return (globalStore.get(atoms.settingsAtom) as Record<string, unknown>)?.[key];
}

function same(a: unknown, b: unknown): boolean {
    return a === b;
}

// One meta key of the panel.
export function metaBinding<T>(blockId: string, key: string): ScopeBinding<T> {
    return {
        scope: "panel",
        get: () => {
            const v = readBlockMeta(blockId, key);
            return v == null ? undefined : (v as T);
        },
        set: (value) => writeBlockMeta(blockId, { [key]: value } as MetaType),
        clear: () => writeBlockMeta(blockId, { [key]: null } as MetaType),
    };
}

// One settings key; a value equal to the built-in default counts as unset (nothing to reset).
export function settingsBinding<T>(key: string, builtinDefault: T, scope: PanelScopeId = "kind"): ScopeBinding<T> {
    return {
        scope,
        get: () => {
            const v = readSettings(key);
            return v == null || same(v, builtinDefault) ? undefined : (v as T);
        },
        set: (value) => writeSettings({ [key]: value }),
        clear: () => writeSettings({ [key]: null }),
    };
}

// Several keys behind one value (a terminal's cursor is a style and a blink): read() returns undefined when none is
// set, write() maps a value to the keys.
export function compositeBinding<T>(
    scope: PanelScopeId,
    keys: string[],
    read: (values: unknown[]) => T | undefined,
    write: (value: T) => Record<string, unknown>,
    target: { blockId?: string }
): ScopeBinding<T> {
    const values = () => keys.map((k) => (target.blockId ? readBlockMeta(target.blockId, k) : readSettings(k)));
    const put = (data: Record<string, unknown>) =>
        target.blockId ? writeBlockMeta(target.blockId, data as MetaType) : writeSettings(data);
    return {
        scope,
        get: () => read(values()),
        set: (value) => put(write(value)),
        clear: () => put(Object.fromEntries(keys.map((k) => [k, null]))),
    };
}
