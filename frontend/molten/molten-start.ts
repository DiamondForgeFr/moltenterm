// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Wires the mod host to the running tab. `frontend/wave.ts` calls startMoltenHost once, after the first render,
// through its only Moltenterm patch for the host.

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { MoltentermSafeModeVarName } from "@/util/moltenterm-safemode";
import { base64ToString, fireAndForget } from "@/util/util";
import { addMoltentermNotification } from "../moltenterm-shell/notifications-store";
import { TabActivity, whileShown } from "../moltenterm-shell/tab-activity";
import { isShowing } from "../moltenterm-shell/tab-activity-model";
import { MoltenBudgetCheckMs, modIdForScript } from "./molten-budget";
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

// The blob URL each mod was imported from → the mod id, to attribute long animation frames to mods (FR-PERF-014).
const BlobOwners = new Map<string, string>();

// A blob URL loads the same way from the dev server's http origin and the packaged file:// origin; the mod must be
// a single file, as relative imports cannot resolve from a blob.
async function importModule(source: string, sourceName: string): Promise<any> {
    const blob = new Blob([`${source}\n//# sourceURL=molten-mod://${sourceName}\n`], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    BlobOwners.set(url, sourceName.split("/")[0]);
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
        heapUsedMB: () => {
            const used = (performance as any).memory?.usedJSHeapSize;
            return typeof used === "number" ? used / (1024 * 1024) : null;
        },
    };
}

// Script time of long animation frames, attributed to the mod whose module the script comes from: what a mod runs
// outside the host's own calls (its own window timers, event listeners). Chromium only; silently absent elsewhere.
function observeModLongFrames(host: MoltenHost): void {
    if (typeof PerformanceObserver === "undefined") {
        return;
    }
    if (!(PerformanceObserver.supportedEntryTypes ?? []).includes("long-animation-frame")) {
        return;
    }
    try {
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as any[]) {
                for (const script of entry.scripts ?? []) {
                    const modId = modIdForScript(script.sourceURL, BlobOwners);
                    if (modId == null) {
                        continue;
                    }
                    host.recordLongFrameScript(modId, script.duration, script.startTime + script.duration);
                }
            }
        });
        observer.observe({ type: "long-animation-frame", buffered: false });
    } catch (e) {
        console.log("[molten] long animation frames are not observable", e);
    }
}

// A request from molten must not outwait its RPC timeout (MoltenRpcTimeoutMs, 5 s) because a mod is slow to activate.
const ListWaitMs = 3000;

async function waitLoadedAtMost(host: MoltenHost, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
    });
    try {
        await Promise.race([host.whenLoaded(), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

export function startMoltenHost(): void {
    const host = MoltenHost.getInstance();
    if (host.started) {
        return;
    }
    const env = makeMoltenHostEnv();
    const client = TabRpcClient as any;
    client[`handle_${MoltenModListRpcCommand}`] = async () => {
        await waitLoadedAtMost(host, ListWaitMs);
        return host.listMods();
    };
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
    // partsonly: the mod is trusted already and has gained a Claude Code part, which is asked about alone.
    client[`handle_${MoltenTrustPromptRpcCommand}`] = async (_rh: unknown, req: { id?: string; partsonly?: boolean }) => {
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
            claudeCodePart: m.agents?.["claude-code"],
            partsOnly: !!req?.partsonly,
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
    // A mod that stops or is refused is worth keeping in the notification center; a mod's own messages stay toasts.
    host.notificationListener = (entry) => {
        if (entry.modId != null || (entry.kind !== "error" && entry.kind !== "warning")) {
            return;
        }
        addMoltentermNotification({ source: "mod", title: entry.title, message: entry.message, kind: entry.kind });
    };
    const safeMode = getApi().getEnv(MoltentermSafeModeVarName) === "1";
    mountMoltenNotifications(host, safeMode);
    // Mod code loads once the view shows and its timers are held while it does not (FR-PERF-014).
    const activity = TabActivity.getInstance();
    host.showing = isShowing(activity.state());
    globalStore.sub(activity.stateAtom, () => host.setShowing(isShowing(activity.state())));
    activity.every(whileShown(MoltenBudgetCheckMs), () => host.checkBudgets(), "molten-budget");
    observeModLongFrames(host);
    fireAndForget(() => host.start(env, { safeMode }));
}
