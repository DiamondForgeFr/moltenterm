// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A web page this tab's interface opened by itself (a navigation or a window.open of the interface, FR-BRW-007, #2176)
// comes back from Electron main (emain/moltenterm-external-links.ts) and opens like any interface link: openLink, the
// browser panel of this tab through the per-site routing, or the system when web:openlinksinternally is off.

import { getApi, openLink } from "@/app/store/global";
import { fireAndForget } from "@/util/util";

// MoltenTerm's own preload function (emain/preload.ts), typed here so custom.d.ts stays Wave's.
type MoltentermOpenLinkApi = {
    onMoltentermOpenLink?: (callback: (url: string) => void) => void;
};

let listening = false;

export function listenOpenLink(): void {
    if (listening) {
        return;
    }
    listening = true;
    (getApi() as unknown as MoltentermOpenLinkApi)?.onMoltentermOpenLink?.((url) => {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
            return;
        }
        fireAndForget(() => openLink(url));
    });
}
