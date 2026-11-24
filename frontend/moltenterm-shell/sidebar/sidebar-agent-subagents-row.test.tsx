// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2502 (FR-SHELL-084): the row of a lead whose sub-agents work says so, in the action colour, with a count pill and the
// dominoes, instead of "inactif"; another agent of the same folder shows no sub-agent that is not its own.

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import enLocale from "../i18n/locales/en.json";
import frLocale from "../i18n/locales/fr.json";
import { AgentsSection } from "./sidebar-agents";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

const Css = readFileSync(new URL("./sidebar-agents.css", import.meta.url), "utf8");

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

function rowOf(html: string, blockId: string): string {
    const start = html.indexOf(`data-block-id="${blockId}"`);
    expect(start, blockId).toBeGreaterThanOrEqual(0);
    const next = html.indexOf('data-testid="sidebar-agent"', start + 1);
    return html.slice(start, next < 0 ? undefined : next);
}

const Lead: AgentStateInfo = {
    blockid: "lead",
    tabid: "tab-a",
    workspaceid: "ws1",
    agent: "claude",
    agentname: "Claude Code",
    firstname: "Clara",
    state: "working",
    background: true,
    subagents: 3,
    message: "3 sub-agents at work",
    messagetext: { code: "agentState.subagents", vars: { count: "3" } },
    version: 1,
};
const Neighbour: AgentStateInfo = {
    blockid: "neighbour",
    tabid: "tab-a",
    workspaceid: "ws1",
    agent: "claude",
    agentname: "Claude Code",
    firstname: "Basile",
    state: "idle",
    version: 2,
};

describe("the row of a lead whose sub-agents work (#2502)", () => {
    it("has a count pill with the dominoes and the second line in the action colour, not 'inactif'", () => {
        const row = rowOf(render([Lead, Neighbour]), "lead");
        expect(row).toContain('data-state="working"');
        expect(row).toContain("is-subs");
        expect(row).toContain('data-testid="sidebar-agent-subs-pill"');
        expect(row).toContain('<span aria-hidden="true">3</span><span class="df-domino-loader"');
        expect(row).toContain("sub-agents at work");
        expect(row).not.toContain("mt-sb-agent-dom");
    });

    it("names what the pill counts for assistive technology, in the plural and the singular", () => {
        expect(rowOf(render([Lead]), "lead")).toContain('aria-label="3 sub-agents at work"');
        const one = { ...Lead, subagents: 1, message: "1 sub-agent at work" };
        expect(rowOf(render([one]), "lead")).toContain('aria-label="1 sub-agent at work"');
    });

    it("shows nothing of them on another agent of the folder, which has none of its own", () => {
        const html = render([Lead, Neighbour]);
        const other = rowOf(html, "neighbour");
        expect(other).toContain('data-state="idle"');
        expect(other).not.toContain("is-subs");
        expect(other).not.toContain("sidebar-agent-subs-pill");
        expect(other).not.toContain("mt-sb-agent-dom");
    });

    it("keeps the second line of a lead that works itself, and adds the pill beside the dominoes' place", () => {
        const working = { ...Lead, background: false, message: "fixing #12", messagetext: undefined };
        const row = rowOf(render([working]), "lead");
        expect(row).not.toContain("is-subs");
        expect(row).toContain("fixing #12");
        expect(row).toContain("sidebar-agent-subs-pill");
    });

    it("keeps the lone dominoes for a working agent with no sub-agent", () => {
        const solo = { ...Neighbour, state: "working" as const, message: "reading" };
        const row = rowOf(render([solo]), "neighbour");
        expect(row).toContain("mt-sb-agent-dom");
        expect(row).not.toContain("sidebar-agent-subs-pill");
    });

    it("draws the pill in tokens, and the line in the action colour", () => {
        const pill = Css.slice(Css.indexOf(".mt-sb-agent-subs {"));
        expect(pill.slice(0, pill.indexOf("}"))).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
        const line = Css.slice(Css.indexOf(".mt-sb-arow.is-subs .mt-sb-agent-ss {"));
        expect(line.slice(0, line.indexOf("}"))).toContain("color: var(--mt-accent)");
    });

    it("says it in both languages: the server's message and the pill", () => {
        for (const dict of [enLocale as any, frLocale as any]) {
            for (const key of ["one", "other"]) {
                expect(dict.sidebar.agents.atWork[key]).toBeTypeOf("string");
            }
            expect(dict.server.agentState.subagents).toContain("{count}");
        }
        expect((frLocale as any).server.agentState.subagents).toBe("{count} sous-agents au travail");
        expect((enLocale as any).server.agentState.subagent).toBe("1 sub-agent at work");
    });
});
