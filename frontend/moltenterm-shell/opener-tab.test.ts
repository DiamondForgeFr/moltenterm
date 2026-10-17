// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { OpenerTabDeps, showTabFromHere } from "./opener-tab";

function fakeDeps(current: string, setOpener?: OpenerTabDeps["setOpener"]) {
    return {
        currentTabId: () => current,
        setOpener: vi.fn(setOpener ?? (async () => {})),
        activate: vi.fn(),
    };
}

describe("showTabFromHere", () => {
    it("records the current tab as the opener of the tab it shows", () => {
        const deps = fakeDeps("project");
        showTabFromHere("review", deps);
        expect(deps.setOpener).toHaveBeenCalledWith("review", "project");
        expect(deps.activate).toHaveBeenCalledWith("review");
    });

    it("records no opener when the tab shown is the current one", () => {
        const deps = fakeDeps("review");
        showTabFromHere("review", deps);
        expect(deps.setOpener).not.toHaveBeenCalled();
        expect(deps.activate).toHaveBeenCalledWith("review");
    });

    it("still shows the tab when the opener cannot be written", async () => {
        const deps = fakeDeps("project", async () => {
            throw new Error("rpc down");
        });
        showTabFromHere("review", deps);
        expect(deps.activate).toHaveBeenCalledWith("review");
        await Promise.resolve();
    });

    it("does nothing without a tab", () => {
        const deps = fakeDeps("project");
        showTabFromHere("", deps);
        expect(deps.setOpener).not.toHaveBeenCalled();
        expect(deps.activate).not.toHaveBeenCalled();
    });
});
