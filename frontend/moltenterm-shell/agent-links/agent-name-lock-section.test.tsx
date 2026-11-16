// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The first name in an agent's Connections (FR-CONT-014, #2324): Lock for the project the agent is in, Unlock once it is
// locked, a lock beside it; nothing for an agent without a project or a first name.

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { NameLockSection } from "./agent-links-menu";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));
vi.mock("../agent-name-locks-store", () => ({
    lockAgentName: async () => ({ status: "locked" }),
    unlockAgentName: async () => ({ status: "unlocked" }),
}));

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
});

function agent(fields: Partial<AgentStateInfo>): AgentStateInfo {
    return {
        blockid: "blk-1",
        tabid: "tab-a",
        workspaceid: "ws1",
        agent: "claude",
        agentname: "Claude Code",
        state: "idle",
        version: 1,
        ...fields,
    };
}

// A state is taken only when its version is newer than the last one of its block.
let version = 1;

function render(info: AgentStateInfo) {
    version += 1;
    AgentStates.getInstance().apply([{ ...info, version }]);
    const props = { blockId: info.blockid, confirm: null, busy: false } as any;
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <NameLockSection props={props} />
        </Provider>
    );
}

describe("the first name in an agent's Connections (#2324)", () => {
    beforeEach(() => {
        version += 1;
        AgentStates.getInstance().apply([{ blockid: "blk-1", version, cleared: true }]);
    });

    it("offers to lock the name for the project the agent is in", () => {
        const html = render(agent({ firstname: "Flore", project: "/projects/alpha" }));
        expect(html).toContain('data-action="lock"');
        expect(html).toMatch(/data-testid="agent-links-name-lock"[^>]*>Lock for alpha</);
        expect(html).toContain("Lock Flore for alpha so a new agent started there gets it back.");
        expect(html).not.toContain('data-testid="agent-name-lock"');
    });

    it("offers to unlock a locked name, with the lock beside it and the project in the tooltip", () => {
        const html = render(
            agent({ firstname: "Flore", project: "/projects/alpha", namelockedfor: "/projects/alpha" })
        );
        expect(html).toContain('data-action="unlock"');
        expect(html).toMatch(/data-testid="agent-links-name-unlock"[^>]*>Unlock</);
        expect(html).toMatch(/<i [^>]*title="Flore is locked for alpha: a new agent there gets it back\."/);
        expect(html).toContain(
            "Flore is locked for alpha: a new agent started there gets it back, and no agent of another project gets it."
        );
    });

    it("offers to lock again, for this project, a name another project holds", () => {
        const html = render(agent({ firstname: "Flore", project: "/projects/alpha", namelockedfor: "/projects/beta" }));
        expect(html).toContain('data-action="lock"');
        expect(html).toMatch(/Lock for alpha</);
        expect(html).toMatch(/title="Flore is locked for beta: /);
    });

    it("shows nothing for an agent in no project that holds a free name, or without a first name", () => {
        expect(render(agent({ firstname: "Flore" }))).toBe("");
        expect(render(agent({ project: "/projects/alpha" }))).toBe("");
    });
});
