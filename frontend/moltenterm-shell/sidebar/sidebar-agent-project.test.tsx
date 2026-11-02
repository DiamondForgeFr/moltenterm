// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The project chip on an agent's name line (FR-SHELL-084, #1746): two projects or more, the project the agent's folder
// is in; one project, nothing.

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import { AgentsSection } from "./sidebar-agents";
import type { WorkspaceProjectEntry } from "./workspace-projects";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
});

const Desktop: WorkspaceProjectEntry = { id: "p1", type: "desktop", dir: "/Users/x/notulia-desktop", branch: "" };
const Website: WorkspaceProjectEntry = { id: "p2", type: "website", dir: "/Users/x/notulia-web", branch: "" };

// The terminal's folder lives in its block's meta (cmd:cwd), read through the object store.
function seedFolder(blockId: string, folder: string) {
    globalStore.get(WOS.getWaveObjectAtom(WOS.makeORef("block", blockId)));
    WOS.setObjectValue({ otype: "block", oid: blockId, version: 1, meta: { "cmd:cwd": folder } } as any);
}

function agent(blockid: string, firstname: string): AgentStateInfo {
    return {
        blockid,
        tabid: "tab-a",
        workspaceid: "ws1",
        agent: "claude",
        agentname: "Claude Code",
        firstname,
        state: "idle",
        version: 1,
    };
}

function render(agents: AgentStateInfo[], projects: WorkspaceProjectEntry[]) {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <AgentsSection agents={agents} activeTabId="tab-a" projects={projects} />
        </Provider>
    );
}

describe("the agent's project chip (#1746)", () => {
    it("puts the project after the first name when the workspace holds two projects", () => {
        seedFolder("blk-web", "/Users/x/notulia-web/src");
        const html = render([agent("blk-web", "Suzanne")], [Desktop, Website]);
        expect(html).toContain('data-testid="sidebar-agent-project"');
        expect(html).toMatch(
            /mt-sb-agent-nm">Suzanne<\/span><span[^>]*data-testid="sidebar-agent-project"[^>]*>website</
        );
        expect(html).not.toContain('data-outside="true"');
    });

    it("names the project the agent runs in, not the workspace's first one", () => {
        seedFolder("blk-desk", "/Users/x/notulia-desktop");
        const html = render([agent("blk-desk", "Fanny")], [Desktop, Website]);
        expect(html).toMatch(/data-testid="sidebar-agent-project"[^>]*>desktop</);
        expect(html).not.toMatch(/data-testid="sidebar-agent-project"[^>]*>website</);
    });

    it("keeps the state alone on the second line", () => {
        seedFolder("blk-state", "/Users/x/notulia-web");
        const html = render([agent("blk-state", "Alice")], [Desktop, Website]);
        expect(html).toMatch(/mt-sb-agent-ss">[^<]*<\/span><\/span>/);
        expect(html).not.toMatch(/mt-sb-agent-ss">[^<]*website/);
    });

    it("shows nothing with one project, even for an agent inside it", () => {
        seedFolder("blk-one", "/Users/x/notulia-web");
        const html = render([agent("blk-one", "Alice")], [Website]);
        expect(html).not.toContain("sidebar-agent-project");
        expect(html).toContain('class="mt-sb-agent-nm">Alice<');
    });

    it("shows an agent outside every project by its folder's name, muted", () => {
        seedFolder("blk-out", "/tmp/scratch/merge-run");
        const html = render([agent("blk-out", "Olivia")], [Desktop, Website]);
        expect(html).toMatch(/data-testid="sidebar-agent-project"[^>]*data-outside="true"[^>]*>merge-run</);
        expect(html).toContain("mt-sb-agent-proj is-outside");
    });
});
