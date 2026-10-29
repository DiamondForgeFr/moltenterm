// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { serverText } from "./server-text";

// #1311: wavesrv sends a tab's name as stored, and a default view never renamed is stored by its key.
describe("serverText with a view's name", () => {
    it("words a var holding a view's key as the view's name", () => {
        const text = {
            code: "keepawake.notice.asktab",
            vars: { tab: "workspaceViews.names.scoping", tool: "caffeinate" },
        };
        const worded = serverText(text, "English");
        expect(worded).toContain("A program in Scoping ran caffeinate.");
        expect(worded).not.toContain("workspaceViews");
    });

    it("leaves any other var as sent", () => {
        const text = { code: "keepawake.notice.asktab", vars: { tab: "api", tool: "caffeinate" } };
        expect(serverText(text, "English")).toContain("A program in api ran caffeinate.");
    });
});
