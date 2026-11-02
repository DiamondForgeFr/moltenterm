// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The screen this window is on and the 360 view's column threshold remembered for each screen (FR-SHELL-066, #1083),
// wired to the main process (emain/moltenterm-screen.ts) and to the client's meta (the same for every tab and window,
// kept across restarts).

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import {
    readScreenThresholds,
    type ScreenInfo,
    ScreenThresholdsMetaKey,
    type ScreenThresholds,
    thresholdFor,
    withoutScreen,
    withThreshold,
} from "./screen-threshold";

type ScreenApi = {
    moltentermGetScreen?: () => ScreenInfo;
    onMoltentermScreen?: (callback: (info: ScreenInfo) => void) => void;
};

function screenApi(): ScreenApi {
    return ((globalThis as any).api ?? {}) as ScreenApi;
}

function validScreen(info: ScreenInfo): ScreenInfo {
    return info?.key && info.widthpx > 0 ? info : null;
}

export class ScreenModel {
    private static instance: ScreenModel = null;

    // The screen the window is on, null until the main process says (or in a preview). Tests may set it to emulate
    // another screen; the next move to another display sets it back.
    screenAtom: PrimitiveAtom<ScreenInfo> = atom(null) as PrimitiveAtom<ScreenInfo>;
    // This window's last write, ahead of the meta's round trip.
    pendingAtom: PrimitiveAtom<ScreenThresholds> = atom(null) as PrimitiveAtom<ScreenThresholds>;
    storedAtom: Atom<ScreenThresholds>;
    thresholdAtom: Atom<number>;

    private constructor() {
        const metaAtom = atom((get) => {
            const clientAtom = ClientModel.getInstance().clientAtom;
            const client = clientAtom == null ? null : get(clientAtom);
            return readScreenThresholds((client?.meta as Record<string, unknown>)?.[ScreenThresholdsMetaKey]);
        });
        this.storedAtom = atom((get) => get(this.pendingAtom) ?? get(metaAtom));
        this.thresholdAtom = atom((get) => thresholdFor(get(this.storedAtom), get(this.screenAtom)));
        const api = screenApi();
        try {
            globalStore.set(this.screenAtom, validScreen(api.moltentermGetScreen?.()));
            api.onMoltentermScreen?.((info) => globalStore.set(this.screenAtom, validScreen(info)));
        } catch (e) {
            console.log("view360: no screen info", e);
        }
    }

    static getInstance(): ScreenModel {
        if (ScreenModel.instance == null) {
            ScreenModel.instance = new ScreenModel();
        }
        return ScreenModel.instance;
    }

    get screen(): ScreenInfo {
        return globalStore.get(this.screenAtom);
    }

    get threshold(): number {
        return globalStore.get(this.thresholdAtom);
    }

    private write(next: ScreenThresholds) {
        const clientId = ClientModel.getInstance().clientId;
        globalStore.set(this.pendingAtom, next);
        if (clientId == null) {
            return;
        }
        fireAndForget(async () => {
            try {
                await RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("client", clientId),
                    meta: { [ScreenThresholdsMetaKey]: Object.keys(next).length ? next : null } as MetaType,
                });
            } finally {
                if (globalStore.get(this.pendingAtom) === next) {
                    globalStore.set(this.pendingAtom, null);
                }
            }
        });
    }

    // The threshold of a screen: the current one by default, or a row of Settings' list.
    setThreshold(columns: number, screen: ScreenInfo = this.screen): void {
        if (screen == null) {
            return;
        }
        this.write(withThreshold(globalStore.get(this.storedAtom), screen, columns));
    }

    forget(key: string): void {
        const stored = globalStore.get(this.storedAtom);
        if (stored[key] == null) {
            return;
        }
        this.write(withoutScreen(stored, key));
    }
}
