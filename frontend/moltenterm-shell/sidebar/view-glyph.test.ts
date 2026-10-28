// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A view pinned everywhere looks the same in every workspace (FR-SHELL-080, TC-SHELL-190, #1270): its top-row glyph
// comes from the pin, never from this workspace's live instance, where an agent may run.

import { describe, expect, it } from "vitest";
import { topGlyph } from "./view-glyph";
import { GlobalPin } from "./view-pins-model";

const terminalPin: GlobalPin = {
    id: "p1",
    name: "Lead",
    rev: 1,
    config: { tree: { pane: 0 }, panes: [{ view: "term", controller: "shell" }] },
};

describe("topGlyph (#1270)", () => {
    it("draws the pin's configuration, whatever runs in this workspace's instance", () => {
        expect(topGlyph(terminalPin)).toEqual(["terminal"]);
    });

    it("draws the pin's chosen icon when it has one", () => {
        expect(topGlyph({ ...terminalPin, icon: "rocket" })).toEqual(["rocket"]);
    });
});
