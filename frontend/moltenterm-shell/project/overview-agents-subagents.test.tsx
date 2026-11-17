// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The project overview's Right now and the Integration panel say the same of a lead whose sub-agents work (#2294, FR-MC-024,
// FR-REV-022): working in the background, never finished. Synthetic agent states only.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import type { CompanionView } from "../companion/companion-model";

const m = vi.hoisted(() => ({
    states: {} as Record<string, unknown>,
    view: null as unknown,
}));

vi.mock("../agent-state-store", async () => {
    const { atom } = await import("jotai");
    return {
        AgentStates: {
            getInstance: () => ({ dataAtom: atom(() => ({ states: m.states, versions: {} })) }),
        },
    };
});
vi.mock("../companion/companion-follow", () => ({ useCompanionFollow: () => m.view }));
vi.mock("@/app/store/wos", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useWaveObjectValue: () => [null, false],
}));
vi.mock("../pane-status", () => ({ usePaneStatus: () => null }));
vi.mock("../reviews/reviews-batch-client", () => ({ useBatchRun: () => null }));

import { NowCard } from "./overview-cards";
import type { ProjectCardProps } from "./project-context";

const props = {
    project: { dir: "/p", workspace: { oid: "ws1" } },
    pipeline: null,
    runs: [],
    ci: null,
    startBuild: () => {},
    snapshot: null,
    releaseFollow: null,
} as unknown as ProjectCardProps;

function lead(state: AgentStateInfo["state"], more: Partial<AgentStateInfo> = {}): AgentStateInfo {
    return {
        blockid: "lead",
        tabid: "t1",
        workspaceid: "ws1",
        agent: "claude",
        agentname: "Claude Code",
        firstname: "Flore",
        state,
        version: 1,
        ...more,
    };
}

function companion(...subs: Array<Partial<CompanionView["subagents"][number]>>): CompanionView {
    return {
        blockid: "lead",
        status: "ready",
        subagents: subs.map((s, i) => ({
            id: `s${i}`,
            kind: "general-purpose",
            description: `task ${i}`,
            state: "running",
            background: true,
            started: Date.now() - 60_000,
            ...s,
        })),
    } as unknown as CompanionView;
}

const render = () => renderToStaticMarkup(<NowCard {...props} />);

beforeEach(() => {
    m.states = {};
    m.view = null;
});

describe("the project overview's Right now, for a lead with sub-agents (#2294)", () => {
    it("reads a finished lead as working while its background sub-agents work", () => {
        m.states = { lead: lead("done") };
        m.view = companion({}, {});
        const html = render();
        expect(html).toContain('data-testid="project-subagents"');
        expect(html.match(/data-testid="project-subagent"/g)).toHaveLength(2);
        const line = html.slice(
            html.indexOf('data-testid="project-agent"'),
            html.indexOf('data-testid="project-subagents"')
        );
        expect(line).toContain(">working<");
        expect(line).not.toContain(">done<");
        expect(line).toContain("mt-beat-turn");
    });

    it("does the same for an idle lead", () => {
        m.states = { lead: lead("idle") };
        m.view = companion({});
        const line = render().split('data-testid="project-subagents"')[0];
        expect(line).toContain(">working<");
        expect(line).not.toContain(">idle<");
    });

    it("still reads a finished lead as done when no sub-agent works, and keeps a waiting lead waiting", () => {
        m.states = { lead: lead("done") };
        m.view = companion({ state: "done" });
        const done = render();
        expect(done).toContain(">done<");
        expect(done).not.toContain('data-testid="project-subagents"');
        m.states = { lead: lead("waiting") };
        m.view = companion({});
        const waiting = render();
        expect(waiting).toContain(">waiting for you<");
    });

    it("counts the sub-agents folded behind the +N line too", () => {
        m.states = { lead: lead("done") };
        m.view = companion({}, {}, {}, {}, {});
        const html = render();
        expect(html).toContain('data-testid="project-subagents-more"');
        expect(html.slice(0, html.indexOf('data-testid="project-subagents"'))).toContain(">working<");
    });
});
