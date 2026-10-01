// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Wires the mod host to the running tab. `frontend/wave.ts` calls startMoltenHost once, after the first render,
// through its only Moltenterm patch for the host.

import { getApi } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { base64ToString, fireAndForget } from "@/util/util";
import { MoltenDirEntry, MoltenHost, MoltenHostEnv } from "./molten-host";
import { mountMoltenNotifications } from "./molten-notifications";

// The RPC command `molten mod list` sends to this tab (cmd/wsh/cmd/wshcmd-molten.go). The tab client dispatches
// incoming commands on `handle_<command>`, so the handler is added here and pkg/wshrpc stays untouched.
export const MoltenModListRpcCommand = "moltenmodlist";

async function listDir(path: string): Promise<MoltenDirEntry[]> {
    const info = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path } });
    if (info == null || info.notfound || !info.isdir) {
        return [];
    }
    const entries = await RpcApi.FileListCommand(TabRpcClient, { path });
    return (entries ?? []).map((entry) => ({ name: entry.name, isDir: !!entry.isdir }));
}

async function readTextFile(path: string): Promise<string> {
    const file = await RpcApi.FileReadCommand(TabRpcClient, { info: { path } });
    if (file?.info == null || file.info.notfound || file.info.isdir) {
        return null;
    }
    return file.data64 ? base64ToString(file.data64) : "";
}

// A blob URL loads the same way from the dev server's http origin and the packaged file:// origin; the mod must be
// a single file, as relative imports cannot resolve from a blob.
async function importModule(source: string, sourceName: string): Promise<any> {
    const blob = new Blob([`${source}\n//# sourceURL=molten-mod://${sourceName}\n`], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
        return await import(/* @vite-ignore */ url);
    } finally {
        URL.revokeObjectURL(url);
    }
}

function makeMoltenHostEnv(): MoltenHostEnv {
    const configDir = getApi().getConfigDir();
    return {
        modsDir: `${configDir}/mods`,
        listDir,
        readTextFile,
        importModule,
        writeClipboard: (text: string) => navigator.clipboard.writeText(text),
    };
}

export function startMoltenHost(): void {
    const host = MoltenHost.getInstance();
    if (host.started) {
        return;
    }
    (TabRpcClient as any)[`handle_${MoltenModListRpcCommand}`] = () => host.listMods();
    mountMoltenNotifications(host);
    fireAndForget(() => host.start(makeMoltenHostEnv()));
}
