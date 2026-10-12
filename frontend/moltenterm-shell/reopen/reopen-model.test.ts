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
        expect(reopenToast({ reopened: true, kind: "pane", name: "the browser" })).toEqual({
            kind: "success",
            title: "Reopened the browser",
        });
        expect(reopenToast({ reopened: true, kind: "tab", name: "api" }).title).toBe("Reopened the tab “api”");
    });

    it("says a terminal got a new shell, in its folder", () => {
        const t = reopenToast(
            { reopened: true, kind: "pane", name: "the terminal", freshshell: true, cwd: "/Users/me/w" },
            "/Users/me"
        );
        expect(t.title).toBe("Reopened the terminal");
        expect(t.message).toBe("A new shell started in ~/w: the closed one cannot be brought back.");
        expect(reopenToast({ reopened: true, kind: "pane", name: "the terminal", freshshell: true }).message).toBe(
            "A new shell started: the closed one cannot be brought back."
        );
    });
});
