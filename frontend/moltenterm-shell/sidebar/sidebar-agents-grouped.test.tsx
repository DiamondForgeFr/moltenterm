// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The sidebar's agents grouped by project (FR-SHELL-084, #1867): two projects or more, a separator opens each group and
// its rows drop the project chip; one project, the flat list of #1746.

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

function seedFolder(blockId: string, folder: string) {
    globalStore.get(WOS.getWaveObjectAtom(WOS.makeORef("block", blockId)));
    WOS.setObjectValue({ otype: "block", oid: blockId, version: 1, meta: { "cmd:cwd": folder } } as any);
}

function agent(blockid: string, firstname: string, since: number): AgentStateInfo {
    return {
        blockid,
        tabid: "tab-a",
        workspaceid: "ws1",
        agent: "claude",
        agentname: "Claude Code",
        firstname,
        state: "idle",
        since,
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

describe("agents grouped by project (#1867)", () => {
    it("opens a separator per project, most recent first, and the agents outside every project last", () => {
        seedFolder("grp-desk", "/Users/x/notulia-desktop");
        seedFolder("grp-web", "/Users/x/notulia-web/src");
        seedFolder("grp-out", "/tmp/scratch/merge-run");
        const html = render(
            [agent("grp-desk", "Fanny", 10), agent("grp-web", "Suzanne", 90), agent("grp-out", "Olivia", 50)],
            [Desktop, Website]
        );
        const seps = html.match(/data-testid="sidebar-agent-group-name"[^>]*>[^<]*</g) ?? [];
        expect(seps.map((s) => s.replace(/.*>([^<]*)</, "$1"))).toEqual(["website", "desktop", "No project"]);
        const at = (name: string) => html.indexOf(`>${name}</span>`);
        expect(at("Suzanne")).toBeLessThan(at("Fanny"));
        expect(at("Fanny")).toBeLessThan(at("Olivia"));
    });

    it("drops the project chip from the rows of a group", () => {
        seedFolder("grp-chip-desk", "/Users/x/notulia-desktop");
        seedFolder("grp-chip-web", "/Users/x/notulia-web");
        const html = render([agent("grp-chip-desk", "Ana", 1), agent("grp-chip-web", "Ben", 2)], [Desktop, Website]);
        expect(html).toContain('data-testid="sidebar-agent-group-sep"');
        expect(html).not.toContain('data-testid="sidebar-agent-project"');
    });

    it("stays flat with one project: no separator, the chip as before", () => {
        seedFolder("grp-one-a", "/Users/x/notulia-web");
        seedFolder("grp-one-b", "/Users/x/notulia-web/src");
        const html = render([agent("grp-one-a", "Cleo", 1), agent("grp-one-b", "Dan", 2)], [Website]);
        expect(html).not.toContain("sidebar-agent-group-sep");
        expect(html).not.toContain('data-testid="sidebar-agent-project"');
        expect(html).toContain('class="mt-sb-agent-nm">Cleo<');
    });
});
