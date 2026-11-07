// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: { workspace: atom({ oid: "wsB" }) },
        getApi: () => ({ switchWorkspace: vi.fn() }),
    };
});
vi.mock("../sessions/sessions-store", async () => {
    const { atom } = await import("jotai");
    const dataAtom = atom(null);
    return { DurableSessions: { getInstance: () => ({ dataAtom }) } };
});
vi.mock("../project/project-tab", () => ({ showProjectTab: vi.fn() }));
vi.mock("./boss-card-actions", () => ({
    homeFolder: () => "/Users/me",
    openSessionsView: vi.fn(),
    startTerminal: vi.fn(),
}));
vi.mock("../downloads/downloads-view", () => ({ DownloadsList: () => <div data-testid="mock-downloads" /> }));
vi.mock("./brokk-usage-tab", () => ({ BrokkUsageTab: () => <div data-testid="mock-usage" /> }));

import { globalStore } from "@/app/store/jotaiStore";
import { DurableSession } from "../sessions/sessions-model";
import { DurableSessions } from "../sessions/sessions-store";
import { AgentsPanel, DownloadsPanel, SessionsPanel, UsagePanel } from "./brokk-rows-panels";
import type { BrokkActions } from "./use-brokk-actions";

const sessionsAtom = DurableSessions.getInstance().dataAtom as any;
const Now = Date.now();

function session(id: string, extra: Partial<DurableSession> = {}): DurableSession {
    return {
        id,
        shortid: id.slice(0, 8),
        connection: "",
        connstate: "connected",
        workspaceorder: 0,
        shown: true,
        canshow: true,
        canend: true,
        workspaceid: "wsA",
        workspacename: "Alpha",
        startedat: Now - 5 * 60 * 1000,
        ...extra,
    };
}

function load(...sessions: DurableSession[]) {
    globalStore.set(sessionsAtom, { sessions, runningagents: sessions.filter((s) => s.agent).length, version: 1 });
}

const Actions: BrokkActions = { busyId: null, problem: "", goToSession: vi.fn(), runTodo: vi.fn(), reconnect: vi.fn() };

function workspaces(): Map<string, Workspace> {
    return new Map<string, Workspace>([
        ["wsA", { oid: "wsA", name: "Alpha", color: "#ff7c0d", meta: {} } as any],
        ["wsB", { oid: "wsB", name: "Beta", color: "#4cc38a", meta: {} } as any],
    ]);
}

const agents = () =>
    renderToStaticMarkup(<AgentsPanel now={Now} workspaces={workspaces()} actions={Actions} onClose={() => {}} />);
const sessions = (onLeave = () => {}) =>
    renderToStaticMarkup(
        <SessionsPanel now={Now} workspaces={workspaces()} actions={Actions} onLeave={onLeave} onClose={() => {}} />
    );

beforeEach(() => {
    globalStore.set(sessionsAtom, null);
});

const Everything = () =>
    load(
        session("zoe", {
            workspaceid: "wsB",
            workspacename: "Beta",
            workspaceorder: 2,
            agent: "claude",
            agentname: "Claude Code",
            firstname: "Zoé",
            agentstate: "waiting",
            modelname: "Opus 5.5",
            context: { ticket: 2024, branch: "feature/2024-x" },
        }),
        session("jo", {
            workspaceid: "wsA",
            workspacename: "Alpha",
            workspaceorder: 1,
            agent: "codex",
            agentname: "Codex",
            firstname: "Jo",
            agentstate: "working",
        }),
        session("zsh", { workspaceid: "wsA", workspacename: "Alpha", workspaceorder: 1, command: "zsh" }),
        session("ci", {
            workspaceid: "wsB",
            workspacename: "Beta",
            workspaceorder: 2,
            connection: "build-ci",
            connstate: "disconnected",
            command: "bash",
        })
    );

describe("the Agents panel (FR-BOSS-009, AC19)", () => {
    it("shows the loading state until the sessions are read", () => {
        expect(agents()).toContain('data-testid="boss-card-loading"');
    });

    it("says in one line when no agent runs", () => {
        load(session("zsh", { command: "zsh" }));
        const html = agents();
        expect(html).toContain('data-testid="brokk-agents-empty"');
        expect(html).toContain("No agent is running.");
    });

    it("lists the agents only, grouped by workspace, the current one first", () => {
        Everything();
        const html = agents();
        expect(html.match(/data-testid="brokk-agent-row"/g)).toHaveLength(2);
        expect(html).not.toContain('data-testid="brokk-session-row"');
        expect(html.indexOf('data-group="wsB"')).toBeLessThan(html.indexOf('data-group="wsA"'));
        expect(html).toContain("This workspace");
    });

    it("gives each row its first name, agent, model, ticket, branch, state and Aller à", () => {
        Everything();
        const html = agents();
        expect(html).toMatch(/data-testid="boss-card-name">Zoé<span[^>]*> · Claude Code<\/span>/);
        expect(html).toContain("Opus 5.5");
        expect(html).toMatch(/data-testid="boss-card-project">#2024</);
        expect(html).toContain("feature/2024-x");
        expect(html).toMatch(/data-state="waiting"/);
        expect(html).toContain('aria-label="Go to Zoé"');
    });

    const rowOf = (html: string, id: string) => {
        const start = html.indexOf(`data-session="${id}"`);
        return html.slice(start, html.indexOf("</li>", start));
    };

    it("shows the suite's dominoes, not a bare arc, for an agent that works, in the slot of the other state dots", () => {
        Everything();
        const html = agents();
        const working = rowOf(html, "jo");
        expect(working).toMatch(/data-testid="brokk-agent-mark"[^>]*><span class="df-domino-loader mt-brokk-dom"/);
        expect(working.match(/<span><\/span>/g)).toHaveLength(8);
        expect(working).not.toContain("border-2");
        expect(working).not.toContain("rounded-full");
        const waiting = rowOf(html, "zoe");
        expect(waiting).toMatch(
            /data-testid="brokk-agent-mark"[^>]*><span class="inline-block h-2 w-2 [^"]*rounded-full/
        );
        expect(waiting).not.toContain("df-domino-loader");
    });

    it("keeps the dominoes in the 16 by 8 px slot at half size, so that the state words line up", () => {
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        const slot = /\.mt-brokk-sd \{([^}]*)\}/.exec(css)?.[1] ?? "";
        expect(slot).toMatch(/width: 16px/);
        expect(slot).toMatch(/height: 8px/);
        const dom = /\.mt-brokk-dom \{([^}]*)\}/.exec(css)?.[1] ?? "";
        expect(dom).toMatch(/zoom: 0\.5/);
        expect(dom).toMatch(/color: var\(--mt-state-running\)/);
    });

    it("counts the agents next to its title and names the workspace of each group", () => {
        Everything();
        const html = agents();
        expect(html).toMatch(/data-testid="brokk-panel-count-agents"[^>]*>2</);
        expect(html).toContain('data-testid="workspace-name">Beta<');
        expect(html).toContain('data-testid="workspace-name">Alpha<');
    });
});

describe("the Sessions panel (FR-BOSS-009, AC19)", () => {
    it("lists the terminals and the SSH sessions, never an agent", () => {
        Everything();
        const html = sessions();
        expect(html.match(/data-testid="brokk-session-row"/g)).toHaveLength(2);
        expect(html).not.toContain('data-testid="brokk-agent-row"');
    });

    it("shows the host and the state of an SSH session, and Reconnecter when its connection is lost", () => {
        Everything();
        const html = sessions();
        expect(html).toContain('data-testid="boss-card-host"');
        expect(html).toContain("build-ci");
        expect(html.match(/data-testid="brokk-session-reconnect"/g)).toHaveLength(1);
        expect(html).toContain(">Reconnect<");
    });

    it("offers Aller à on every row and keeps the foot's Open the Sessions view", () => {
        Everything();
        const html = sessions();
        expect(html.match(/data-testid="boss-card-go"/g)).toHaveLength(2);
        expect(html).toContain('data-testid="boss-card-open-sessions"');
        expect(html).toContain("Open the Sessions view");
    });

    it("keeps New terminal in the empty state", () => {
        load(session("jo", { agent: "codex", firstname: "Jo" }));
        const html = sessions();
        expect(html).toContain('data-testid="boss-card-empty"');
        expect(html).toContain('data-testid="boss-card-new-terminal"');
        expect(html).toContain("No terminal or SSH session is running.");
    });

    it("shows a session no pane shows as such, with Show it instead of Aller à", () => {
        load(session("lost", { shown: false, canshow: true, command: "top" }));
        const html = sessions();
        expect(html).toContain("Not in a pane");
        expect(html).toContain(">Show it<");
    });

    it("explains a disabled Aller à with its reason, as the Sessions view does", () => {
        load(session("gone", { canshow: false, reason: "panegone", command: "vim" }));
        expect(sessions()).toMatch(/disabled=""[^>]*title="[^"]+"|title="[^"]+"[^>]*disabled=""/);
    });
});

describe("the Téléchargements and Usage panels (FR-BOSS-009, AC19 and AC20; FR-MC-019)", () => {
    it("hosts the downloads section of #1992 as it is, with its count", () => {
        const html = renderToStaticMarkup(<DownloadsPanel count={3} onLeave={() => {}} onClose={() => {}} />);
        expect(html).toContain('data-testid="mock-downloads"');
        expect(html).toMatch(/data-testid="brokk-panel-count-downloads"[^>]*>3</);
        expect(html).toContain(">Downloads<");
        expect(readFileSync(join(__dirname, "brokk-rows-panels.tsx"), "utf8")).toContain(
            "<DownloadsList onLeave={onLeave} />"
        );
    });

    it("hosts the former Usage tab: every window of every provider", () => {
        const html = renderToStaticMarkup(<UsagePanel onClose={() => {}} />);
        expect(html).toContain('data-testid="mock-usage"');
        expect(html).toContain(">Usage<");
    });
});
