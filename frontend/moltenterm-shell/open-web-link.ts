// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The one way MoltenTerm's interface opens an address it read from gh, GitHub or a review (#663): a web page goes
// through openLink (the browser panel or the installed browser, FR-BRW-006); anything else is dropped, never handed to
// another scheme's handler.

import { openLink } from "@/app/store/global";
import { isWebLink, WebLinkRule } from "@/util/moltenterm-web-link";

export async function openWebLink(url: string, rule?: WebLinkRule): Promise<boolean> {
    if (!isWebLink(url, rule)) {
        console.log("molten: not a web page, not opened", typeof url === "string" ? url.slice(0, 200) : url);
        return false;
    }
    await openLink(url);
    return true;
}
