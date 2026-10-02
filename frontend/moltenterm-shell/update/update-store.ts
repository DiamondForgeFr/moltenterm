// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The gold update in the renderer (#64): checks the delivered gold while the window is visible, announces a newer one
// once (status bar and notification center), and asks emain to install it.

import { ClientModel } from "@/app/store/client-model";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService, WorkspaceService } from "@/app/store/services";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { GoldApplyResult, GoldApplyWhen, GoldCheck, GoldManifest, GoldSwapStatus } from "@/util/moltenterm-gold";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";
import { addMoltentermNotification } from "../notifications-store";
import {
    installedSince,
    shouldOffer,
    summarizeTerminals,
    TerminalSummary,
    UpdateCheckIntervalMs,
    updateLabel,
    UpdateLastBuildMetaKey,
    UpdateNotifiedMetaKey,
    UpdateSkippedMetaKey,
} from "./update-model";

type UpdateElectronApi = ElectronApi & {
    moltentermUpdateCheck: (ownBuildId: number) => Promise<GoldCheck>;
    moltentermUpdateApply: (buildId: number, when: GoldApplyWhen) => Promise<GoldApplyResult>;
    moltentermUpdateLast: () => Promise<GoldSwapStatus>;
};

function updateApi(): UpdateElectronApi {
    return getApi() as UpdateElectronApi;
}

function readBuild() {
    return typeof __MOLTENTERM_BUILD__ === "undefined" ? null : __MOLTENTERM_BUILD__;
}

function clientMetaNumber(key: string): number {
    const value = (globalStore.get(ClientModel.getInstance().clientAtom)?.meta as Record<string, any>)?.[key];
    return typeof value === "number" ? value : 0;
}

function setClientMeta(meta: Record<string, any>) {
    const clientId = ClientModel.getInstance().clientId;
    if (clientId == null) {
        return;
    }
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("client", clientId), meta: meta as MetaType })
    );
}

export class GoldUpdateModel {
    private static instance: GoldUpdateModel = null;

    offerAtom = atom(null) as PrimitiveAtom<GoldManifest>;
    dialogOpenAtom = atom(false) as PrimitiveAtom<boolean>;
    busyAtom = atom(false) as PrimitiveAtom<boolean>;
    errorAtom = atom(null) as PrimitiveAtom<string>;
    pendingOnQuitAtom = atom(false) as PrimitiveAtom<boolean>;
    started = false;

    private constructor() {}

    static getInstance(): GoldUpdateModel {
        if (!GoldUpdateModel.instance) {
            GoldUpdateModel.instance = new GoldUpdateModel();
        }
        return GoldUpdateModel.instance;
    }

    // Only an installed gold updates itself; dev and local builds never look.
    isGold(): boolean {
        const build = readBuild();
        const runtimeChannel = getApi().getEnv("MOLTENTERM_CHANNEL");
        return !getApi().getIsDev() && (runtimeChannel || build?.channel) === "gold" && build?.buildId > 0;
    }

    start(): () => void {
        if (this.started || !this.isGold()) {
            return () => {};
        }
        this.started = true;
        this.announceInstalled();
        this.check();
        const timer = setInterval(() => this.check(), UpdateCheckIntervalMs);
        const onFocus = () => this.check();
        window.addEventListener("focus", onFocus);
        return () => {
            clearInterval(timer);
            window.removeEventListener("focus", onFocus);
            this.started = false;
        };
    }

    // The swap writes its outcome after the new build has stayed open a while: the new build announces itself instead.
    announceInstalled() {
        const own = readBuild().buildId;
        const last = clientMetaNumber(UpdateLastBuildMetaKey);
        if (own <= last) {
            return;
        }
        setClientMeta({ [UpdateLastBuildMetaKey]: own });
        if (!installedSince(own, last)) {
            return;
        }
        addMoltentermNotification({
            source: "moltenterm",
            kind: "success",
            title: `Moltenterm updated (build ${own})`,
            message: "Your configuration and workspaces are as you left them.",
        });
    }

    check() {
        if (document.visibilityState !== "visible") {
            return;
        }
        fireAndForget(() => this.reportLastSwap());
        fireAndForget(async () => {
            const result = await updateApi().moltentermUpdateCheck(readBuild().buildId);
            const manifest = result?.available ? result.manifest : null;
            const offer = shouldOffer(manifest, clientMetaNumber(UpdateSkippedMetaKey)) ? manifest : null;
            globalStore.set(this.offerAtom, offer);
            if (offer != null && clientMetaNumber(UpdateNotifiedMetaKey) < offer.buildId) {
                setClientMeta({ [UpdateNotifiedMetaKey]: offer.buildId });
                addMoltentermNotification({
                    source: "moltenterm",
                    kind: "info",
                    title: `A new Moltenterm gold is ready (${updateLabel(offer)})`,
                    message: `${offer.notes.length} change(s). Click Update in the status bar.`,
                });
            }
        });
    }

    async reportLastSwap() {
        const status = await updateApi().moltentermUpdateLast();
        if (status == null) {
            return;
        }
        if (status.state === "installed") {
            return;
        }
        if (status.state === "rolledback") {
            setClientMeta({ [UpdateSkippedMetaKey]: status.buildId });
            addMoltentermNotification({
                source: "moltenterm",
                kind: "warning",
                title: `The new gold did not start: Moltenterm went back to the previous one`,
                message: `Build ${status.buildId} will not be offered again; a newer gold will.`,
            });
        } else {
            addMoltentermNotification({
                source: "moltenterm",
                kind: "error",
                title: "The update could not be installed",
                message: status.detail,
            });
        }
    }

    skip(manifest: GoldManifest) {
        setClientMeta({ [UpdateSkippedMetaKey]: manifest.buildId });
        globalStore.set(this.offerAtom, null);
        globalStore.set(this.dialogOpenAtom, false);
    }

    async apply(manifest: GoldManifest, when: GoldApplyWhen) {
        globalStore.set(this.busyAtom, true);
        globalStore.set(this.errorAtom, null);
        try {
            const result = await updateApi().moltentermUpdateApply(manifest.buildId, when);
            if (!result?.ok) {
                globalStore.set(this.errorAtom, result?.error ?? "the update failed");
                return;
            }
            if (when === "quit") {
                globalStore.set(this.pendingOnQuitAtom, true);
                globalStore.set(this.dialogOpenAtom, false);
            }
        } finally {
            globalStore.set(this.busyAtom, false);
        }
    }
}

// Every terminal of every workspace, with whether it runs a command: what a restart would stop.
export async function readTerminals(): Promise<TerminalSummary> {
    const sources = [];
    for (const entry of (await WorkspaceService.ListWorkspaces()) ?? []) {
        const workspace = await WorkspaceService.GetWorkspace(entry.workspaceid);
        const blocks = (await RpcApi.BlocksListCommand(TabRpcClient, { workspaceid: entry.workspaceid })) ?? [];
        for (const block of blocks) {
            if (block.meta?.view !== "term") {
                continue;
            }
            let rtInfo: ObjRTInfo = null;
            try {
                rtInfo = await RpcApi.GetRTInfoCommand(TabRpcClient, { oref: makeORef("block", block.blockid) });
            } catch {
                rtInfo = null;
            }
            let jobId = "";
            try {
                jobId = ((await ObjectService.GetObject(makeORef("block", block.blockid))) as Block)?.jobid ?? "";
            } catch {
                jobId = "";
            }
            const tabIndex = workspace?.tabids?.indexOf(block.tabid) ?? -1;
            sources.push({
                workspace: workspace?.name || "Unsaved workspace",
                tab: tabIndex >= 0 ? `T${tabIndex + 1}` : "",
                shellState: rtInfo?.["shell:state"] ?? "",
                lastCommand: rtInfo?.["shell:lastcmd"] ?? "",
                durable: jobId !== "",
            });
        }
    }
    return summarizeTerminals(sources);
}
