// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { openPipelineSetupTab, PipelineTabDeps } from "./pipeline-tab-open";

// A fake wavesrv that keeps one tab per project folder, as pkg/wcore/moltenterm_pipelinetab.go does.
function fakeDeps(workspaceId = "ws") {
    const tabs = new Map<string, string>();
    const calls: Record<string, unknown>[] = [];
    const show = vi.fn();
    const deps: PipelineTabDeps = {
        workspaceId: () => workspaceId,
        call: async (data) => {
            calls.push(data);
            const dir = data.dir as string;
            if (tabs.has(dir)) {
                return { tabid: tabs.get(dir) };
            }
            tabs.set(dir, `tab-${tabs.size + 1}`);
            return { tabid: tabs.get(dir), created: true };
        },
        show,
    };
    return { deps, calls, show, tabs };
}

describe("openPipelineSetupTab", () => {
    it("opens one tab per project, and the action again focuses it", async () => {
        const { deps, show, tabs } = fakeDeps();
        expect(await openPipelineSetupTab("/work/app", "App", undefined, deps)).toBe("tab-1");
        expect(await openPipelineSetupTab("/work/app", "App", "understand", deps)).toBe("tab-1");
        expect(await openPipelineSetupTab("/work/other", "Other", undefined, deps)).toBe("tab-2");
        expect(tabs.size).toBe(2);
        expect(show.mock.calls.map((c) => c[0])).toEqual(["tab-1", "tab-1", "tab-2"]);
    });

    it("names the tab after the project and passes the step to open at", async () => {
        const { deps, calls } = fakeDeps();
        await openPipelineSetupTab("/work/app", "", "understand", deps);
        expect(calls[0]).toEqual({
            workspaceid: "ws",
            dir: "/work/app",
            project: "app",
            tabname: "Pipeline · app",
            openat: "understand",
        });
    });

    it("opens nothing without a workspace or a folder", async () => {
        const { deps, calls, show } = fakeDeps("");
        expect(await openPipelineSetupTab("/work/app", "App", undefined, deps)).toBe("");
        expect(await openPipelineSetupTab("", "App", undefined, fakeDeps().deps)).toBe("");
        expect(calls).toEqual([]);
        expect(show).not.toHaveBeenCalled();
    });
});
