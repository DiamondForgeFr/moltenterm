// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The 360 carpet's thumbnails (#1814, FR-SHELL-065 AC12, DS-SHELL-152): the channels the renderer keeps them through.
// They live in the application's data folder (moltenterm-carpet-thumb-store.ts), so a panel off-screen, unloaded or
// from before a restart still has its picture. The capture itself stays `capture-screenshot` with a width.

import * as path from "path";
import { getWaveDataDir } from "./emain-platform";
import { CarpetThumbStore } from "./moltenterm-carpet-thumb-store";
import {
    CarpetThumbPutChannel,
    CarpetThumbReadChannel,
    CarpetThumbRemoveChannel,
    parseThumbPut,
    parseThumbReadItems,
    parseThumbRemoveKeys,
    thumbAnswer,
} from "./moltenterm-carpet-thumb-wire";
import { handleAppIpc } from "./moltenterm-privileged-ipc";

const ThumbFolder = "carpet-thumbs";

function logFailure(what: string, e: unknown) {
    console.log(`carpet thumbnails: ${what} failed`, e instanceof Error ? e.message : String(e));
}

export function initMoltentermCarpetThumbs() {
    const store = new CarpetThumbStore(path.join(getWaveDataDir(), ThumbFolder));
    handleAppIpc(CarpetThumbPutChannel, async (_event, req) => {
        const put = parseThumbPut(req);
        if (put == null) {
            return false;
        }
        try {
            return await store.put(put.key, put.tag, put.data, put.width, put.height, put.at);
        } catch (e) {
            logFailure("write", e);
            return false;
        }
    });
    handleAppIpc(CarpetThumbReadChannel, async (_event, items) => {
        try {
            return thumbAnswer(await store.getMany(parseThumbReadItems(items)));
        } catch (e) {
            logFailure("read", e);
            return {};
        }
    });
    handleAppIpc(CarpetThumbRemoveChannel, async (_event, keys) => {
        try {
            return await store.remove(parseThumbRemoveKeys(keys));
        } catch (e) {
            logFailure("remove", e);
            return 0;
        }
    });
}
