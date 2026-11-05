// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { webBlockWebviewSelector } from "./moltenterm-webselector-policy";

describe("webselector lookup (#1961)", () => {
    it("finds a Wave web block's page and never a browser panel tab", () => {
        const selector = webBlockWebviewSelector("4f1c");
        expect(selector).toBe("div[data-blockid='4f1c'] webview:not([data-browsertab])");
    });

    it("keeps a block id with quotes inside its attribute value", () => {
        expect(webBlockWebviewSelector("a'] webview, webview[x='")).toBe(
            "div[data-blockid='a\\'] webview, webview[x=\\''] webview:not([data-browsertab])"
        );
    });
});
