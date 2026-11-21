// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import { I18nModel } from "../i18n/i18n";
import { moveSection, setSectionHidden, setSectionSpan } from "./companion-arrange-model";
import { CompanionDashboard, CompanionDashboardProps } from "./companion-dashboard";
import { CompanionLayout, CompanionSectionIds, DefaultCompanionLayout } from "./companion-layout";
import { CompanionView } from "./companion-model";

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    const off = atom(false);
    return {
        openLink: vi.fn(),
        getSettingsKeyAtom: () => off,
        getApi: () => ({}),
        createBlockSplitHorizontally: vi.fn(),
    };
});
vi.mock("@/app/store/contextmenu", () => ({
    ContextMenuModel: { getInstance: () => ({ showContextMenu: vi.fn() }) },
}));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn(() => () => {}) }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn(() => new Promise(() => {})) } }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(), SetConfigCommand: vi.fn() } }));
vi.mock("@/app/store/client-model", () => ({ ClientModel: { getInstance: () => ({ clientAtom: null }) } }));
vi.mock("@/app/element/markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("@/layout/index", () => ({ getLayoutModelForStaticTab: () => null }));
vi.mock("@/app/store/tab-model", () => ({ getActiveTabModel: () => null }));

const noop = () => {};
const now = Date.now();

const agentState: AgentStateInfo = {
    blockid: "t1",
    agent: "claude",
    agentname: "Claude Code",
    firstname: "Flore",
    state: "working",
    version: 1,
};

const view: CompanionView = {
    blockid: "t1",
    version: 1,
    status: "live",
    agent: "claude",
    agentname: "Claude Code",
    session: { path: "/s/a.jsonl", linkedby: "hook", title: "Ship the search", started: now - 60_000 },
    topics: [{ text: "Write the tests", last: now - 60_000 }],
    files: [{ path: "/w/src/a.ts", kind: "update", added: 1, removed: 0, edits: 1 }],
    subagents: [{ id: "s1", description: "#41 Fix the total", state: "running", started: now - 60_000 }],
};

function markup(layout: CompanionLayout, extra: Partial<CompanionDashboardProps> = {}): string {
    return renderToStaticMarkup(
        <CompanionDashboard
            view={view}
            target="t1"
            companionId="c1"
            agentState={agentState}
            provider=""
            dir=""
            folder="/w"
            layout={layout}
            onSaveLayout={noop}
            arranging={true}
            onArrange={noop}
            onLeaveArranging={noop}
            arrangeRef={{ current: null }}
            integrationDetails={false}
            persistentIntegration={false}
            onIntegration={noop}
            onHistory={noop}
            onBackToCurrent={noop}
            fixtures={{ milestones: { dir: "/w", state: "none" } }}
            {...extra}
        />
    );
}

// The markup of one block, from its section's mark to the next block.
function block(html: string, id: string): string {
    const start = html.lastIndexOf("<section", html.indexOf(`data-section="${id}"`));
    expect(start).toBeGreaterThan(-1);
    const after = html.indexOf('data-testid="companion-arrange-row"', html.indexOf(`data-section="${id}"`) + 1);
    const next = after < 0 ? -1 : html.lastIndexOf("<section", after);
    return html.slice(start, next < 0 ? undefined : next);
}

function order(html: string): string[] {
    return [...html.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1]);
}

describe("arranging the dashboard in place (#2395, #2441)", () => {
    it("folds every block to its label and one line, in the layout's order, with its rank and its tools", () => {
        const html = markup(DefaultCompanionLayout);
        expect(order(html)).toEqual(DefaultCompanionLayout.map((p) => p.id));
        const n = CompanionSectionIds.length;
        expect(html.match(/data-testid="companion-arrange-handle"/g)).toHaveLength(n);
        expect(html.match(/data-testid="companion-arrange-switch"/g)).toHaveLength(n);
        expect(html.match(/data-testid="companion-arrange-wide"/g)).toHaveLength(n);
        const tasks = block(html, "tasks");
        expect(tasks).toContain('data-testid="companion-arrange-rank">2 / 8<');
        expect(tasks).toContain('aria-label="Move Tasks"');
        expect(tasks).toContain('aria-label="Move Tasks up"');
        expect(tasks).toContain('aria-label="Move Tasks down"');
        expect(tasks).toContain('aria-label="Full width for Tasks"');
        expect(tasks).toContain('aria-label="Show Tasks"');
        expect(tasks).toContain("The project&#x27;s open milestones and their tickets");
        // Nothing but the summary while arranging: no milestone, no list.
        expect(html).not.toContain('data-testid="companion-milestone"');
    });

    it("sets the permission request full width by default, and says when it shows", () => {
        const html = markup(DefaultCompanionLayout);
        const permission = block(html, "permission");
        expect(permission).toContain('data-span="full"');
        expect(permission).toMatch(
            /data-testid="companion-arrange-wide"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="companion-arrange-wide"/
        );
        expect(permission).toContain("data-absent");
        expect(permission).toContain("Shows when the agent asks for a permission");
        expect(block(html, "files")).toContain('data-span="flow"');
    });

    it("shows an arranged layout: its order, its spans, its hidden blocks at half strength with their chip", () => {
        const arranged = setSectionHidden(
            setSectionSpan(moveSection(DefaultCompanionLayout, 7, 0), "topics", "full"),
            "usage",
            true
        );
        const html = markup(arranged);
        expect(order(html)[0]).toBe("files");
        expect(block(html, "files")).toContain('data-testid="companion-arrange-rank">1 / 8<');
        expect(block(html, "topics")).toContain('data-span="full"');
        const usage = block(html, "usage");
        expect(usage).toContain('data-hidden=""');
        expect(usage).toContain(">Hidden<");
        expect(usage).toContain('class="fa fa-solid fa-eye-slash"');
    });

    it("offers the way back to the defaults and Done, and names the mode", () => {
        const html = markup(setSectionHidden(DefaultCompanionLayout, "files", true));
        expect(html).toContain('data-testid="companion-arrange-reset"');
        expect(html).toContain('data-testid="companion-arrange-done"');
        expect(html).toContain("Arrange the companion");
        expect(html).toContain('aria-live="polite"');
        // The hero's Arrange tool says the mode is on.
        expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="companion-arrange-open"/);
        expect(markup(DefaultCompanionLayout)).toMatch(
            /aria-disabled="true"[^>]*data-testid="companion-arrange-reset"/
        );
    });

    it("reads in French", () => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            const html = markup(DefaultCompanionLayout);
            expect(html).toContain("Agent principal");
            expect(html).toContain("Revenir à l");
            expect(html).toContain("Pleine largeur pour");
        } finally {
            i18n.setLanguageSetting("");
        }
    });
});

describe("the dashboard (#2441)", () => {
    it("draws the hero, then every block that has something to show, in the layout's order", () => {
        const html = markup(DefaultCompanionLayout, { arranging: false });
        expect(html).toContain("Main agent");
        expect(html).toContain("fa-sparkles");
        expect(html).toContain('data-testid="companion-flow"');
        const ids = [...html.matchAll(/data-flow-id="([a-z]+)"/g)].map((m) => m[1]);
        // No permission is asked and the milestone is not read: those take no place; the task is still loading.
        expect(ids).toEqual(["agents", "topics", "answer", "files"]);
    });

    it("draws the permission request in the waiting tone when the agent asks one", () => {
        const asking: CompanionView = {
            ...view,
            pending: [{ id: "p", tool: "Bash", args: '{"command":"ls"}' } as any],
        };
        const html = markup(DefaultCompanionLayout, {
            arranging: false,
            view: asking,
            agentState: { ...agentState, state: "waiting" },
        });
        expect(html).toMatch(/data-flow-id="permission" data-tone="waiting"/);
        expect(html).toContain("Flore wants to run");
        expect(html).toContain('data-agent="waiting"');
    });

    it("leaves a hidden block out of the flow", () => {
        const html = markup(setSectionHidden(DefaultCompanionLayout, "topics", true), { arranging: false });
        expect(html).not.toContain('data-flow-id="topics"');
    });
});
