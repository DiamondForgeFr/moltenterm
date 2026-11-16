// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The lock beside a first name locked for a project (FR-CONT-014, #2324), on an agent's row of the sidebar: its tooltip
// says for which project, and a free name shows no lock.

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

function agent(blockid: string, firstname: string, lockedFor?: string): AgentStateInfo {
    return {
        blockid,
        tabid: "tab-a",
        workspaceid: "ws1",
        agent: "claude",
        agentname: "Claude Code",
        firstname,
        namelockedfor: lockedFor,
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

describe("the lock on a locked first name in the agents list (#2324)", () => {
    it("puts a lock after the name, its tooltip naming the project", () => {
        const html = render([agent("blk-1", "Flore", "/Users/x/notulia-web")], [Website]);
        expect(html).toMatch(
            /mt-sb-agent-nm">Flore<\/span><i [^>]*title="Flore is locked for notulia-web: a new agent there gets it back\."[^>]*data-testid="agent-name-lock"/
        );
    });

    it("keeps the lock before the project chip when the workspace holds several projects", () => {
        seedFolder("blk-2", "/Users/x/notulia-web/src");
        const html = render([agent("blk-2", "Flore", "/Users/x/notulia-web")], [Desktop, Website]);
        expect(html.indexOf('data-testid="agent-name-lock"')).toBeGreaterThan(html.indexOf(">Flore</span>"));
        expect(html.indexOf('data-testid="agent-name-lock"')).toBeLessThan(
            html.indexOf('data-testid="sidebar-agent-project"')
        );
    });

    it("shows no lock on a name that is not locked", () => {
        const html = render([agent("blk-3", "Rose")], [Desktop, Website]);
        expect(html).not.toContain('data-testid="agent-name-lock"');
        expect(html).toContain("mt-sb-agent-nm");
    });
});
