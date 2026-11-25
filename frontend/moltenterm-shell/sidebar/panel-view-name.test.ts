// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The name of a view made from a panel (FR-SHELL-080, #2548): the app's own, so the new view reads as any other of the
// list: a web page by its site, a terminal by its kind and folder, a panel the app cannot name by "View".

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

import { initGlobalAtoms } from "@/app/store/global-atoms";
import * as WOS from "@/app/store/wos";
import { panelViewName } from "./panel-view-store";

function block(oid: string, meta: Record<string, any>) {
    WOS.updateWaveObject({
        updatetype: "update",
        otype: "block",
        oid,
        obj: { otype: "block", oid, version: 1, meta } as unknown as WaveObj,
    });
}

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
    block("b-page", { view: "molten-browser", url: "https://docs.example.com/guides/start" });
    block("b-term", { view: "term", controller: "shell", "cmd:cwd": "/work/site/api" });
    block("b-files", { view: "preview", file: "/work/site/readme.md" });
    block("b-unknown", { view: "a-view-nobody-names" });
});

describe("the name of a view made from a panel", () => {
    it("is a web page's site, as the list names such a view", () => {
        expect(panelViewName("b-page")).toBe("docs.example.com");
    });

    it("is a terminal's kind and folder", () => {
        expect(panelViewName("b-term")).toBe("Terminal · api");
    });

    it("is a file panel's kind and file", () => {
        expect(panelViewName("b-files")).toContain("readme.md");
    });

    it("is View when the app has no name for the panel, or no such panel", () => {
        expect(panelViewName("b-unknown")).toBe("View");
        expect(panelViewName("b-gone")).toBe("View");
    });
});
