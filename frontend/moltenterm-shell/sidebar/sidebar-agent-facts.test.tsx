// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #1848: the sidebar's agent row says the CLI, model and effort its run reported in its tooltip, a Codex agent's like
// a Claude Code agent's.

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import { AgentsSection } from "./sidebar-agents";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
});

function render(agents: AgentStateInfo[]) {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <AgentsSection agents={agents} activeTabId="tab-a" />
        </Provider>
    );
}

function rowTitle(html: string): string {
    const m = /title="([^"]*)"[^>]*data-testid="sidebar-agent-row"/.exec(html);
    return (m?.[1] ?? "").replace(/&#10;|\n/g, "\n");
}

const Base: AgentStateInfo = { blockid: "b1", tabid: "tab-a", workspaceid: "ws1", state: "idle", version: 1 };

describe("the agent row's tooltip (#1848)", () => {
    it("says a Codex agent's CLI, model and effort", () => {
        const html = render([
            { ...Base, agent: "codex", agentname: "Codex", firstname: "Léa", model: "gpt-5.5", effort: "high" },
        ]);
        expect(rowTitle(html).split("\n").at(-1)).toBe("Codex · gpt-5.5 · high");
    });

    it("says a Claude Code agent's the same way", () => {
        const html = render([
            {
                ...Base,
                agent: "claude",
                agentname: "Claude Code",
                firstname: "Arthur",
                model: "claude-opus-5-5",
                effort: "medium",
            },
        ]);
        expect(rowTitle(html).split("\n").at(-1)).toBe("Claude Code · Opus 5.5 · medium");
    });

    it("says only the CLI when the run reported no model or effort", () => {
        const html = render([{ ...Base, agent: "codex", agentname: "Codex", firstname: "Léa" }]);
        const lines = rowTitle(html).split("\n");
        expect(lines).toHaveLength(3);
        expect(lines[2]).toBe("Codex");
    });
});
