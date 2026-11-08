// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Which page Wave's `wsh web get` (the webselector command) may read (#1961). It runs a selector in the page's main
// world and returns its HTML, with no site approval: that stays Wave's behaviour for a Wave web block, but the browser
// panel's tabs (marked data-browsertab) are read by agents only through the browser tools, behind the user's per-site
// approval (FR-BRW-009).

function quotedAttr(value: string): string {
    return (
        "'" +
        String(value ?? "")
            .replace(/\\/g, "\\\\")
            .replace(/'/g, "\\'") +
        "'"
    );
}

export function webBlockWebviewSelector(blockId: string): string {
    return `div[data-blockid=${quotedAttr(blockId)}] webview:not([data-browsertab])`;
}
