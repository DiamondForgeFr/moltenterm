// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The renderer's side of the carpet's thumbnail store (#1814, FR-SHELL-065 AC12, DS-SHELL-152): the thumbnails live on
// disk in Electron main (emain/moltenterm-carpet-thumbs.ts), keyed by a carpet column's first panel and valid for one
// tag (the panels and their page addresses). Every call degrades to "nothing stored" where the Electron API is missing
// (the preview server, a test) or fails: a thumbnail is a convenience, never a reason for the carpet to break.

import { getApi } from "@/app/store/global";
import { waveEventSubscribeSingle } from "@/app/store/wps";

// must match StoredCarpetThumb in emain/moltenterm-carpet-thumb-wire.ts
export type StoredCarpetThumb = { url: string; width: number; height: number; at: number };

// must match CarpetThumbPutRequest in emain/moltenterm-carpet-thumb-wire.ts
export type CarpetThumbPutRequest = {
    key: string;
    tag: string;
    url: string;
    width: number;
    height: number;
    at: number;
};

export type CarpetThumbItem = { key: string; tag: string };

export type CarpetThumbBackend = {
    read(items: CarpetThumbItem[]): Promise<Record<string, StoredCarpetThumb>>;
    put(req: CarpetThumbPutRequest): void;
    remove(keys: string[]): void;
};

type CarpetThumbElectronApi = {
    moltentermCarpetThumbPut?: (req: CarpetThumbPutRequest) => Promise<boolean>;
    moltentermCarpetThumbRead?: (items: CarpetThumbItem[]) => Promise<Record<string, StoredCarpetThumb>>;
    moltentermCarpetThumbRemove?: (keys: string[]) => Promise<number>;
};

function thumbApi(): CarpetThumbElectronApi {
    return (getApi() ?? {}) as CarpetThumbElectronApi;
}

export const ElectronThumbBackend: CarpetThumbBackend = {
    async read(items) {
        const read = thumbApi().moltentermCarpetThumbRead;
        if (read == null || items.length === 0) {
            return {};
        }
        try {
            return (await read(items)) ?? {};
        } catch (e) {
            console.log("carpet thumbnails: read failed", e);
            return {};
        }
    },
    put(req) {
        thumbApi()
            .moltentermCarpetThumbPut?.(req)
            ?.catch((e) => console.log("carpet thumbnails: write failed", e));
    },
    remove(keys) {
        if (keys.length === 0) {
            return;
        }
        thumbApi()
            .moltentermCarpetThumbRemove?.(keys)
            ?.catch((e) => console.log("carpet thumbnails: remove failed", e));
    },
};

let cleanupStarted = false;

// A closed panel's thumbnail goes with it, whichever window closed it (the backend's block close event reaches every
// window, and the store ignores a key it does not hold). Started once per window, whether or not a carpet is shown.
export function startCarpetThumbCleanup(backend: CarpetThumbBackend = ElectronThumbBackend): void {
    if (cleanupStarted) {
        return;
    }
    cleanupStarted = true;
    waveEventSubscribeSingle({
        eventType: "blockclose",
        handler: (event) => {
            if (typeof event.data === "string" && event.data !== "") {
                backend.remove([event.data]);
            }
        },
    });
}
