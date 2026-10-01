// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Wires the mod host to the running tab. `frontend/wave.ts` calls startMoltenHost once, after the first render,
// through its only Moltenterm patch for the host.

import { getApi } from "@/app/store/global";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { MoltentermSafeModeVarName } from "@/util/moltenterm-safemode";
import { base64ToString, fireAndForget } from "@/util/util";
import { MoltenBuiltinMods } from "./molten-builtins";
import { MoltenDirEntry, MoltenHost, MoltenHostEnv, MoltenRunRequest } from "./molten-host";
import { MoltenManifestFileName, parseMoltenManifest } from "./molten-manifest";
import { mountMoltenNotifications } from "./molten-notifications";
import { MoltenTrustModel } from "./molten-trust";
import { validateMoltenMod } from "./molten-validate";

// The RPC commands `molten` sends to this tab (cmd/wsh/cmd/wshcmd-molten.go). The tab client dispatches incoming
// commands on `handle_<command>`, so the handlers are added here and pkg/wshrpc stays untouched.
export const MoltenModListRpcCommand = "moltenmodlist";
export const MoltenModValidateRpcCommand = "moltenmodvalidate";
export const MoltenRunRpcCommand = "moltenrun";
export const MoltenTrustPromptRpcCommand = "moltentrustprompt";

// Published by `molten mod enable|disable|remove` with `{ids}`. It is not declared in pkg/wps, so that Wave's event
// list stays unpatched; the broker routes any event name.
export const MoltenModsChangedEvent = "molten:modschanged";

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
        stateFile: `${configDir}/molten/mods.json`,
        trustFile: `${getApi().getDataDir()}/molten/trust.json`,
        listDir,
        readTextFile,
        importModule,
        writeClipboard: (text: string) => navigator.clipboard.writeText(text),
        builtins: MoltenBuiltinMods,
    };
}

export function startMoltenHost(): void {
    const host = MoltenHost.getInstance();
    if (host.started) {
        return;
    }
    const env = makeMoltenHostEnv();
    const client = TabRpcClient as any;
    client[`handle_${MoltenModListRpcCommand}`] = () => host.listMods();
    client[`handle_${MoltenRunRpcCommand}`] = (_rh: unknown, req: MoltenRunRequest) => host.runCommand(req);
    client[`handle_${MoltenModValidateRpcCommand}`] = async (_rh: unknown, req: { ids?: string[] }) => {
        let ids = req?.ids ?? [];
        if (ids.length === 0) {
            ids = (await env.listDir(env.modsDir))
                .filter((entry) => entry.isDir && !entry.name.startsWith("."))
                .map((entry) => entry.name)
                .sort();
        }
        const results = [];
        for (const id of ids) {
            results.push(await validateMoltenMod(env.modsDir, id, env.readTextFile));
        }
        return { results };
    };
    client[`handle_${MoltenTrustPromptRpcCommand}`] = async (_rh: unknown, req: { id?: string }) => {
        const id = req?.id ?? "";
        const path = `${env.modsDir}/${id}`;
        const manifestText = await env.readTextFile(`${path}/${MoltenManifestFileName}`);
        if (manifestText == null) {
            throw new Error(`no ${MoltenManifestFileName} in ${path}`);
        }
        const parsed = parseMoltenManifest(id, manifestText);
        if (parsed.ok === false) {
            throw new Error(parsed.error);
        }
        const m = parsed.manifest;
        const answer = await MoltenTrustModel.getInstance().ask({
            id: m.id,
            name: m.name,
            version: m.version,
            description: m.description,
            capabilities: m.capabilities,
            path,
        });
        return { answer };
    };
    waveEventSubscribeSingle({
        eventType: MoltenModsChangedEvent as WaveEventName,
        handler: (event) => {
            const ids = (event.data as { ids?: string[] })?.ids;
            fireAndForget(() => host.reload(Array.isArray(ids) && ids.length > 0 ? ids : null));
        },
    });
    const safeMode = getApi().getEnv(MoltentermSafeModeVarName) === "1";
    mountMoltenNotifications(host, safeMode);
    fireAndForget(() => host.start(env, { safeMode }));
}
