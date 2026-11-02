// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { reopenToast } from "./reopen-model";

describe("the reopen toast (#512)", () => {
    it("says when there is nothing to reopen", () => {
        expect(reopenToast({ reopened: false })).toEqual({ kind: "info", title: "Nothing to reopen" });
        expect(reopenToast(null)).toEqual({ kind: "info", title: "Nothing to reopen" });
    });

    it("names what came back", () => {
        expect(
            reopenToast({ reopened: true, kind: "pane", name: "the browser" }, "", { view: "molten-reviews" })
        ).toEqual({
            kind: "success",
            title: "Reopened “Integration”",
        });
        expect(reopenToast({ reopened: true, kind: "tab", name: "api" }).title).toBe("Reopened the view “api”");
    });

    it("names a default view never renamed by its name, not its key (#1311)", () => {
        expect(reopenToast({ reopened: true, kind: "tab", name: "workspaceViews.names.scoping" }).title).toBe(
            "Reopened the view “Scoping”"
        );
    });

    it("says a terminal got a new shell, in its folder", () => {
        const t = reopenToast(
            { reopened: true, kind: "pane", name: "the terminal", freshshell: true, cwd: "/Users/me/w" },
            "/Users/me",
            { view: "term", "cmd:cwd": "/Users/me/w" }
        );
        expect(t.title).toBe("Reopened “w”");
        expect(t.message).toBe("A new shell started in ~/w: the closed one cannot be brought back.");
        expect(reopenToast({ reopened: true, kind: "pane", name: "the terminal", freshshell: true }).message).toBe(
            "A new shell started: the closed one cannot be brought back."
        );
    });

    it("names an agent panel by its first name, a titled panel by its title, and falls back to Panel", () => {
        const pane = { reopened: true, kind: "pane" as const, name: "the terminal" };
        expect(
            reopenToast(pane, "", { view: "term", "molten:reopenagent": { agent: "x", name: "Olivia", command: "x" } })
                .title
        ).toBe("Reopened “Olivia”");
        expect(reopenToast(pane, "", { view: "molten-reviews", "frame:title": "Thème Coulée" }).title).toBe(
            "Reopened “Thème Coulée”"
        );
        expect(reopenToast(pane, "", { view: "nonexistent" }).title).toBe("Reopened “Panel”");
    });
});
