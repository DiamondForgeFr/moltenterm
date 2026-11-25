// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import { I18nModel, t } from "../i18n/i18n";
import {
    moveSection,
    SectionNameKeys,
    setSectionHidden,
    setSectionSpan,
    setSectionUnfolded,
    setUsageAttached,
    setUsageMinimal,
} from "./companion-arrange-model";
import { SettingsBody } from "./companion-block-settings";
import { CompanionDashboard, CompanionDashboardProps } from "./companion-dashboard";
import type { CompanionPrefs } from "./companion-files-model";
import { CompanionUsageInfo, gaugesView } from "./companion-gauges-model";
import { CompanionHero } from "./companion-hero";
import { CompanionLayout, CompanionSectionId, CompanionSectionIds, DefaultCompanionLayout } from "./companion-layout";
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

// The markup of one block of the arranging mode, from its section's mark to the next block's.
function block(html: string, id: string): string {
    const mark = html.indexOf(`data-section="${id}"`);
    expect(mark, `a block ${id}`).toBeGreaterThan(-1);
    const start = html.lastIndexOf("<section", mark);
    const after = html.indexOf('data-section="', mark + 1);
    const next = after < 0 ? -1 : html.lastIndexOf("<section", after);
    return html.slice(start, next < 0 ? undefined : next);
}

// The blocks of the flow, as the flow places them (a block has one data-flow-id, in the order it is drawn).
function flowOrder(html: string): string[] {
    return [...html.matchAll(/data-flow-id="([a-z]+)"/g)].map((m) => m[1]);
}

// A block's content, without what the arranging mode adds to hold it still: the same in both modes.
function body(html: string, id: string): string {
    const start = html.indexOf('class="mt-cb-body"', html.indexOf(`data-flow-id="${id}"`));
    expect(start, `the body of ${id}`).toBeGreaterThan(-1);
    const end = html.indexOf('data-flow-id="', start);
    // The ids React gives the elements depend on where the block stands in the tree, which the ghosts change.
    const slice = html.slice(start, end < 0 ? undefined : html.lastIndexOf("<section", end));
    return slice
        .slice(0, slice.lastIndexOf("</section>"))
        .replace('class="mt-cb-body" inert=""', 'class="mt-cb-body"')
        .replace(/_R_[a-z0-9]+_/g, "_R_");
}

describe("arranging keeps the dashboard as it is (#2467)", () => {
    it("draws the same blocks in the same order as the normal view, with a ghost where a block has nothing to show", () => {
        const normal = markup(DefaultCompanionLayout, { arranging: false });
        const html = markup(DefaultCompanionLayout);
        expect(flowOrder(normal)).toEqual(["agents", "topics", "answer", "files"]);
        expect(flowOrder(html)).toEqual(DefaultCompanionLayout.map((p) => p.id));
        // The blocks that show are the real ones, in the same place of the list.
        expect(flowOrder(html).filter((id) => flowOrder(normal).includes(id))).toEqual(flowOrder(normal));
        for (const id of ["permission", "tasks", "usage", "task"]) {
            expect(block(html, id), id).toContain('data-testid="companion-ghost"');
        }
        for (const id of ["agents", "topics", "answer", "files"]) {
            expect(block(html, id), id).not.toContain('data-testid="companion-ghost"');
        }
    });

    it("keeps the real content of each block, and holds it still under the controls", () => {
        const normal = markup(DefaultCompanionLayout, { arranging: false });
        const html = markup(DefaultCompanionLayout);
        for (const id of ["agents", "topics", "answer", "files"]) {
            expect(body(html, id), id).toBe(body(normal, id));
            expect(block(html, id), id).toMatch(/class="mt-cb-body" inert=""/);
        }
        expect(block(html, "topics")).toContain("Write the tests");
        expect(block(html, "agents")).toContain("Fix the total");
        expect(block(html, "files")).toContain("a.ts");
        // No summary line stands in the place of the content.
        expect(html).not.toContain("companion-arrange-row");
        expect(html).not.toContain("The project&#x27;s open milestones and their tickets");
        // Outside the mode nothing is held and nothing is overlaid.
        expect(normal).not.toContain("inert");
        expect(normal).not.toContain("data-section");
        expect(normal).not.toContain("companion-ghost");
        expect(normal).not.toContain("companion-arrange-handle");
    });

    it("puts the controls on every block's top border in place of its own tools, and nothing in its content", () => {
        const html = markup(DefaultCompanionLayout);
        const n = CompanionSectionIds.length;
        expect(html.match(/data-testid="companion-arrange-handle"/g)).toHaveLength(n);
        expect(html.match(/data-testid="companion-arrange-switch"/g)).toHaveLength(n);
        expect(html.match(/data-testid="companion-arrange-wide"/g)).toHaveLength(n);
        expect(html.match(/data-testid="companion-arrange-settings"/g)).toHaveLength(n);
        const topics = block(html, "topics");
        // The rank is in the handle's name, for the screen reader: no number, Up or Down is drawn (#2459).
        expect(topics).toContain('aria-label="Move Recent topics, position 5 of 8"');
        expect(topics).toContain('aria-label="Full width for Recent topics"');
        expect(topics).toContain('aria-label="Show Recent topics"');
        expect(topics).toContain('aria-label="Settings of Recent topics"');
        expect(topics).not.toContain("companion-arrange-rank");
        // The controls are on the head: nothing of them is in the body, which is held still.
        const content = topics.slice(topics.indexOf('class="mt-cb-body"'));
        expect(content).not.toContain("companion-arrange-");
        // The answer's own tools (the pager, copy) give way; the controls stay the same height whatever they were.
        const answered: CompanionView = {
            ...view,
            answers: [{ index: 1, preview: "" }],
            latest: { index: 1, markdown: "Done." },
        };
        expect(markup(DefaultCompanionLayout, { arranging: false, view: answered })).toContain(
            'data-testid="companion-copy"'
        );
        const arrangedAnswer = block(markup(DefaultCompanionLayout, { view: answered }), "answer");
        expect(arrangedAnswer).toContain("Done.");
        expect(arrangedAnswer).not.toContain('data-testid="companion-copy"');
    });

    it("draws the settings button closed, naming the dialog it opens, and keeps the settings out of the block", () => {
        const html = markup(DefaultCompanionLayout);
        for (const id of CompanionSectionIds) {
            const settings = block(html, id);
            expect(settings).toMatch(
                /aria-haspopup="dialog"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*aria-haspopup="dialog"/
            );
            expect(settings).not.toContain('role="dialog"');
        }
        expect(html).not.toContain("companion-arrange-usage-options");
        expect(html).not.toContain('data-testid="companion-arrange-attach"');
        expect(html).not.toContain('role="radiogroup"');
    });

    it("sets the permission request full width by default, as a compact ghost that says when it shows", () => {
        const html = markup(DefaultCompanionLayout);
        const permission = block(html, "permission");
        expect(permission).toContain('data-span="full"');
        expect(permission).toContain('data-ghost="when"');
        expect(permission).toMatch(
            /data-testid="companion-arrange-wide"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="companion-arrange-wide"/
        );
        expect(permission).toContain("Shown when the agent asks for a permission");
        expect(block(html, "tasks")).toContain("Shown when the project has an open milestone");
        expect(block(html, "usage")).toContain("Shown when the agent gives its usage");
        expect(block(html, "task")).toContain("Shown when the workspace has a task");
        expect(block(html, "files")).toContain('data-span="flow"');
    });

    it("replaces the ghost of the permission request with the request itself, at the same place", () => {
        const asking: CompanionView = {
            ...view,
            pending: [{ id: "p", tool: "Bash", args: '{"command":"ls"}' } as any],
        };
        const html = markup(DefaultCompanionLayout, { view: asking, agentState: { ...agentState, state: "waiting" } });
        expect(flowOrder(html)).toEqual(DefaultCompanionLayout.map((p) => p.id));
        const permission = block(html, "permission");
        expect(permission).not.toContain('data-ghost="when"');
        expect(permission).toContain("Flore wants to run");
        expect(permission).toContain('data-span="full"');
    });

    it("shows an arranged layout: its order and its spans, its hidden blocks as ghosts after the others, each with its eye", () => {
        const arranged = setSectionHidden(
            setSectionSpan(moveSection(DefaultCompanionLayout, 7, 0), "topics", "full"),
            "usage",
            true
        );
        const html = markup(arranged);
        expect(flowOrder(html)).toEqual([
            "files",
            "permission",
            "tasks",
            "agents",
            "topics",
            "answer",
            "task",
            "usage",
        ]);
        expect(block(html, "files")).toContain('aria-label="Move Files changed, position 1 of 7"');
        expect(block(html, "topics")).toContain('data-span="full"');
        const usage = block(html, "usage");
        expect(usage).toContain('data-hidden=""');
        expect(usage).toContain('data-ghost="hidden"');
        expect(usage).toContain("Hidden. The eye puts it back at its rank.");
        expect(usage).toContain('class="fa fa-solid fa-eye-slash"');
        expect(usage).toContain('aria-label="Show Plan usage"');
        // A hidden block holds no rank to carry it from: the eye is all it wears.
        expect(usage).not.toContain("companion-arrange-handle");
        expect(usage).not.toContain("companion-arrange-wide");
        expect(usage).not.toContain("companion-arrange-settings");
        // It is drawn once, as a ghost, and the real block does not show.
        expect(html.match(/data-flow-id="usage"/g)).toHaveLength(1);
    });

    it("offers the way back to the defaults and Done in a slim bar, and names the mode", () => {
        const html = markup(setSectionHidden(DefaultCompanionLayout, "files", true));
        expect(html).toContain('data-testid="companion-arrange-reset"');
        expect(html).toContain('data-testid="companion-arrange-done"');
        expect(html).toContain('aria-label="Arrange the companion"');
        expect(html).toContain("Drag a block to move it");
        expect(html).toContain('aria-live="polite"');
        // The bar is the first thing of the companion, before the main agent's block, and holds no block of its own.
        expect(html.indexOf("mt-cdash-arrbar")).toBeLessThan(html.indexOf('data-testid="companion-session-bar"'));
        expect(
            html.slice(html.indexOf("mt-cdash-arrbar"), html.indexOf('data-testid="companion-session-bar"'))
        ).not.toContain("data-flow-id");
        // The hero's Arrange tool says the mode is on.
        expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="companion-arrange-open"/);
        expect(markup(DefaultCompanionLayout)).toMatch(
            /aria-disabled="true"[^>]*data-testid="companion-arrange-reset"/
        );
        expect(markup(DefaultCompanionLayout, { arranging: false })).not.toContain("companion-arrange-done");
    });

    it("holds the main agent's block still too, its plan included, with its own tools in use", () => {
        const withPlan: CompanionView = {
            ...view,
            todos: [{ text: "Write the tests", status: "in_progress" } as any],
        };
        const html = markup(DefaultCompanionLayout, { view: withPlan });
        const hero = html.slice(
            html.indexOf('data-testid="companion-session-bar"'),
            html.indexOf('data-testid="companion-flow"')
        );
        expect(hero).toMatch(/class="mt-cdash-hero-grid" data-plan="" inert=""/);
        expect(hero).toContain("Plan");
        expect(hero).toContain('data-testid="companion-history-open"');
    });

    it("reads in French", () => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            const html = markup(DefaultCompanionLayout);
            expect(html).toContain("Agent principal");
            expect(html).toContain("Rétablir par défaut");
            expect(html).toContain("Pleine largeur pour");
            expect(html).toContain("Réglages de");
            expect(html).toContain("position 5 sur 8");
            expect(html).toContain("Affiché quand l&#x27;agent demande une autorisation");
            const hidden = markup(setSectionHidden(DefaultCompanionLayout, "files", true));
            expect(hidden).toContain("Masqué. L&#x27;œil le remet à son rang.");
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

// The plan usage in its minimal form and attached to the main agent (#2450), on synthetic readings: a week and the week
// of a model.
describe("the plan usage, minimal and attached (#2450)", () => {
    const Hour = 60 * 60 * 1000;
    const reading: CompanionUsageInfo = {
        blockid: "t1",
        agent: "claude",
        pageurl: "https://claude.ai/settings/usage",
        pagename: "Claude usage",
        hasgauges: true,
        gauges: "enabled",
        sourcename: "Claude Code status line",
        snapshot: {
            agent: "claude",
            source: "claude-statusline",
            readat: now - 2 * 60_000,
            windows: [
                { id: "week", label: "This week", usedpercent: 63, resetsat: now + 4 * 24 * Hour, windowmins: 10080 },
                {
                    id: "model:fable",
                    label: "This week (Fable)",
                    usedpercent: 12,
                    resetsat: now + 4 * 24 * Hour,
                    windowmins: 10080,
                },
            ],
        },
    };
    const withUsage: CompanionView = {
        ...view,
        usage: { pageurl: reading.pageurl, pagename: reading.pagename } as CompanionView["usage"],
    };
    const shown = (layout: CompanionLayout, extra: Partial<CompanionDashboardProps> = {}) =>
        markup(layout, {
            arranging: false,
            view: withUsage,
            fixtures: { milestones: { dir: "/w", state: "none" }, usage: gaugesView(reading, now) },
            ...extra,
        });
    const minimalLayout = setUsageMinimal(DefaultCompanionLayout, true);
    const attachedLayout = setUsageAttached(minimalLayout, true);

    // A block of the flow, up to the next one; the hero, up to the flow.
    const flowBlock = (html: string, id: string): string => {
        const at = html.indexOf(`data-flow-id="${id}"`);
        expect(at, `a block ${id}`).toBeGreaterThan(-1);
        const start = html.lastIndexOf("<section", at);
        const next = html.indexOf("data-flow-id=", at + 1);
        return html.slice(start, next < 0 ? undefined : html.lastIndexOf("<section", next));
    };
    const heroOf = (html: string): string => {
        const at = html.indexOf('data-testid="companion-session-bar"');
        expect(at).toBeGreaterThan(-1);
        return html.slice(html.lastIndexOf("<section", at), html.indexOf('data-testid="companion-flow"'));
    };
    const flowIds = (html: string) => [...html.matchAll(/data-flow-id="([a-z]+)"/g)].map((m) => m[1]);
    const count = (html: string, mark: string) => html.split(mark).length - 1;
    const labelsOf = (html: string) => [...html.matchAll(/data-testid="usage-week-label">([^<]*)</g)].map((m) => m[1]);
    const percentsOf = (html: string) =>
        [...html.matchAll(/data-testid="usage-week-percent">([^<]*)</g)].map((m) => m[1]);
    // What the full block adds to the rows: the legend, the paragraph and the rest (#2458: the day letters and the
    // figures are the rows' own, so the minimal form and the form attached to the main agent keep them).
    const Extras = [
        'data-testid="usage-week-legend"',
        'data-testid="companion-plan-usage-explain"',
        "Experimental",
        'class="mt-cb-foot"',
    ];
    // What the rows have in every form.
    const Days = ['data-testid="usage-week-day"', 'data-testid="usage-week-share"'];

    it("stays the full block, standing on its own, by default", () => {
        const html = shown(DefaultCompanionLayout);
        expect(flowIds(html)).toEqual(["agents", "usage", "topics", "answer", "files"]);
        const usage = flowBlock(html, "usage");
        expect(usage).toContain('data-form="full"');
        expect(count(usage, 'data-testid="usage-week-day"')).toBe(7);
        expect(count(usage, 'data-testid="usage-week-share"')).toBe(14);
        for (const extra of Extras) {
            expect(usage, extra).toContain(extra);
        }
        // Its link to the usage page is its foot, and the main agent's block does not repeat it.
        expect(usage).toMatch(/class="mt-cb-foot"[^]*data-testid="companion-usage"/);
        expect(heroOf(html)).not.toContain('data-testid="companion-usage"');
        expect(heroOf(html)).not.toContain('data-testid="companion-hero-usage"');
    });

    it("draws the minimal form as its window rows with their days: a label, the letters, a strip, the figures and a percentage", () => {
        const html = shown(minimalLayout);
        expect(flowIds(html)).toEqual(["agents", "usage", "topics", "answer", "files"]);
        const usage = flowBlock(html, "usage");
        expect(usage).toContain('data-form="minimal"');
        expect(labelsOf(usage)).toEqual(["Consumption", "Fable"]);
        expect(percentsOf(usage)).toEqual(["63 %", "12 %"]);
        expect(count(usage, 'data-testid="usage-week-row"')).toBe(2);
        expect(count(usage, 'data-testid="usage-week-block"')).toBe(14);
        // The day letters over the strips (today's in bold) and the figure of each day under the blocks (#2458).
        expect(count(usage, 'data-testid="usage-week-day"')).toBe(7);
        expect(count(usage, 'data-testid="usage-week-share"')).toBe(14);
        // Today's mark, on the letter and on each strip, and the reset day's ring stay.
        expect(count(usage, 'data-today="true"')).toBe(3);
        expect(count(usage, 'data-reset="true"')).toBe(2);
        // The reset is a small icon on each row, never a line under it.
        expect(count(usage, 'data-testid="usage-week-reset"')).toBe(2);
        expect(usage).not.toContain("usage-week-note");
        for (const extra of Extras) {
            expect(usage, extra).not.toContain(extra);
        }
        expect(usage).not.toContain('data-testid="companion-plan-usage-credits"');
        expect(usage).not.toContain(">Hide<");
    });

    it("draws the same days in the full, the minimal and the attached forms, so the rows read alike", () => {
        const forms = [
            flowBlock(shown(DefaultCompanionLayout), "usage"),
            flowBlock(shown(minimalLayout), "usage"),
            heroOf(shown(attachedLayout)),
        ];
        for (const form of forms) {
            for (const day of Days) {
                expect(form, day).toContain(day);
            }
            expect(count(form, 'data-testid="usage-week-reset"')).toBe(2);
            expect(count(form, 'data-testid="usage-week-share"')).toBe(14);
            expect(form).not.toContain("usage-week-note");
        }
    });

    it("gives the reset and the figure of each day in the row's tooltip and accessible name", () => {
        const usage = flowBlock(shown(minimalLayout), "usage");
        expect(usage).toMatch(
            /aria-label="This week, 63 %, resets [A-Za-z]+, per day: (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+ %(, (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+ %){6}, [0-9.]+ d (late|ahead)"/
        );
        expect(usage).toMatch(/aria-label="This week \(Fable\), 12 %, resets [A-Za-z]+, per day: /);
        const title = /data-tip="(This week: 63 % used[^"]*)"/.exec(usage)?.[1] ?? "";
        expect(title).toContain("Resets ");
        expect(title).toMatch(/Per day: (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+ %(, (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+ %){6}/);
        expect(title).toContain("From the Claude Code status line");
        // The full block draws the figures, so its rows' accessible names do not repeat them; its tooltip keeps them,
        // since a narrow grid hides the figures (#2451).
        const full = flowBlock(shown(DefaultCompanionLayout), "usage");
        expect(full).not.toContain("per day:");
        expect(full).toMatch(/data-tip="This week: 63 % used[^"]*Per day: /);
    });

    it("keeps the usage page, the refresh and the full block one click away from the minimal form", () => {
        const usage = flowBlock(shown(minimalLayout), "usage");
        expect(usage).toContain('aria-label="Open Claude usage"');
        expect(usage).toContain('aria-label="Refresh plan usage"');
        expect(usage).toMatch(
            /aria-label="Plan usage details"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*aria-label="Plan usage details"/
        );
        // Rows alone while it is folded; the full block is what unfolds, so the model limits are among its extras.
        expect(usage).not.toContain("companion-plan-usage-experimental");
    });

    it("leaves the flow when attached, and is the last row of the main agent's block", () => {
        const html = shown(attachedLayout);
        expect(flowIds(html)).toEqual(["agents", "topics", "answer", "files"]);
        expect(html).not.toContain('data-testid="companion-usage-block"');
        const hero = heroOf(html);
        expect(hero).toContain('data-testid="companion-hero-usage"');
        expect(hero).toContain('class="mt-cdash-hero-usage"');
        const row = hero.slice(hero.indexOf('data-testid="companion-hero-usage"'));
        expect(labelsOf(row)).toEqual(["Consumption", "Fable"]);
        expect(percentsOf(row)).toEqual(["63 %", "12 %"]);
        expect(count(row, 'data-testid="usage-week-block"')).toBe(14);
        // The rows keep their days here too (#2458).
        expect(count(row, 'data-testid="usage-week-day"')).toBe(7);
        expect(count(row, 'data-testid="usage-week-share"')).toBe(14);
        for (const extra of Extras) {
            expect(hero, extra).not.toContain(extra);
        }
        // Under its meta line (when it started, how the session is linked, its branch), and nothing after it.
        expect(hero.indexOf('data-testid="companion-link"')).toBeGreaterThan(-1);
        expect(hero.indexOf('data-testid="companion-link"')).toBeLessThan(hero.indexOf("companion-hero-usage"));
        expect(hero.slice(hero.indexOf("companion-hero-usage"))).not.toContain("mt-cdash-id");
    });

    it("keeps the usage page and the refresh among the main agent's tools when attached", () => {
        const hero = heroOf(shown(attachedLayout));
        const tools = hero.slice(hero.indexOf('data-side="tools"'), hero.indexOf('data-testid="companion-hero-usage"'));
        expect(tools).toContain('aria-label="Open Claude usage"');
        expect(tools).toContain('data-testid="companion-usage"');
        expect(tools).toContain('aria-label="Refresh plan usage"');
        expect(tools).toContain('aria-label="Plan usage details"');
        // "Hide" turns the gauges off: it stays on the block, never among the main agent's tools.
        expect(tools).not.toContain(">Hide<");
        // The history and Arrange stay where they were.
        expect(tools).toContain('data-testid="companion-history-open"');
        expect(tools).toContain('data-testid="companion-arrange-open"');
    });

    it("keeps the usage page reachable whatever its form: one link, never two", () => {
        for (const layout of [DefaultCompanionLayout, minimalLayout, attachedLayout]) {
            const html = shown(layout);
            expect(count(html, 'data-testid="companion-usage"'), JSON.stringify(layout[3])).toBe(1);
        }
        const hidden = shown(setSectionHidden(attachedLayout, "usage", true));
        // A hidden usage draws nowhere, as the hero keeps the link it always kept.
        expect(count(hidden, 'data-testid="companion-usage"')).toBe(1);
        expect(heroOf(hidden)).toContain('data-testid="companion-usage"');
        expect(heroOf(hidden)).not.toContain('data-testid="companion-hero-usage"');
        expect(flowIds(hidden)).not.toContain("usage");
    });

    it("returns to its saved rank and size when detached", () => {
        const arranged = moveSection(minimalLayout, 3, 0);
        const attached = setUsageAttached(arranged, true);
        expect(flowIds(shown(attached))).toEqual(["agents", "topics", "answer", "files"]);
        const detached = shown(setUsageAttached(attached, false));
        expect(flowIds(detached)).toEqual(["usage", "agents", "topics", "answer", "files"]);
        expect(flowBlock(detached, "usage")).toContain('data-form="minimal"');
        expect(heroOf(detached)).not.toContain('data-testid="companion-hero-usage"');
    });

    it("draws the note of another provider in the main agent's block when attached", () => {
        const html = shown(attachedLayout, { provider: "other-lab" });
        const hero = heroOf(html);
        expect(hero).toContain('data-testid="companion-hero-usage"');
        expect(hero).toContain('data-state="provider"');
        expect(hero).toContain("No plan usage for other-lab");
        // The hero carries the inset and the hairline: the note has neither of its own.
        const row = hero.slice(hero.indexOf('data-testid="companion-hero-usage"'));
        expect(row).not.toContain("border-b");
        expect(row).not.toContain("px-(--mt-companion-inset)");
    });

    it("draws nothing for a usage that has nothing to show, attached or not", () => {
        const none = shown(attachedLayout, {
            fixtures: { milestones: { dir: "/w", state: "none" }, usage: { kind: "hidden" } },
        });
        expect(heroOf(none)).not.toContain('data-testid="companion-hero-usage"');
        expect(flowIds(none)).toEqual(["agents", "topics", "answer", "files"]);
        const off = shown(attachedLayout, {
            fixtures: { milestones: { dir: "/w", state: "none" }, usage: { kind: "off" } },
        });
        // The states that are no reading keep their way to turn the gauges on, in the main agent's block.
        expect(heroOf(off)).toContain('data-testid="companion-plan-usage-show"');
        expect(heroOf(off)).toContain('data-state="off"');
    });

    // The settings popover's content, as the gear opens it.
    const settingsOf = (id: CompanionSectionId, layout: CompanionLayout, prefs: CompanionPrefs = {}) =>
        renderToStaticMarkup(
            <SettingsBody
                id={id}
                name={t(SectionNameKeys[id])}
                placement={layout.find((p) => p.id === id)}
                prefs={prefs}
                onChange={noop}
                onClose={noop}
            />
        );

    it("offers the usage's two choices in its settings, with names and states", () => {
        const html = settingsOf("usage", DefaultCompanionLayout);
        expect(html).toContain('<h3 class="mt-cb-settings-title">Plan usage</h3>');
        expect(html).toMatch(/role="switch" aria-checked="true"[^>]*data-testid="companion-setting-shown"/);
        expect(html).toMatch(/role="switch" aria-checked="false"[^>]*data-testid="companion-setting-wide"/);
        expect(html).toContain('role="radiogroup" aria-label="Form of Plan usage"');
        expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Full</);
        expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>Minimal</);
        expect(html).toMatch(/role="switch" aria-checked="false"[^>]*data-testid="companion-setting-attached"/);
        expect(html).toContain(">Attach to the main agent<");
        expect(html).not.toContain("<fieldset disabled");
    });

    it("draws the arranged usage as it will be, and says in its settings what it is", () => {
        const minimal = block(shown(minimalLayout, { arranging: true }), "usage");
        expect(minimal).toContain('data-form="minimal"');
        expect(labelsOf(minimal)).toEqual(["Consumption", "Fable"]);
        expect(settingsOf("usage", minimalLayout)).toMatch(/role="radio" aria-checked="true"[^>]*>Minimal</);
        const settings = settingsOf("usage", attachedLayout);
        expect(settings).toMatch(/role="switch" aria-checked="true"[^>]*data-testid="companion-setting-attached"/);
        // The size is for the block standing on its own: it waits, and is kept for the day the block is detached.
        expect(settings).toContain("<fieldset disabled");
        expect(settings).toMatch(/role="radio" aria-checked="true"[^>]*>Minimal</);
    });

    it("gives every other block Show, Full width and Keep it unfolded, and the options it already had", () => {
        const wide = (html: string, on: boolean) =>
            expect(html).toMatch(
                new RegExp(`role="switch" aria-checked="${on}"[^>]*data-testid="companion-setting-wide"`)
            );
        for (const id of CompanionSectionIds) {
            const html = settingsOf(id, DefaultCompanionLayout);
            expect(html, id).toContain('data-testid="companion-setting-shown"');
            wide(html, id === "permission");
            // A block taller than 500 px is capped until it is unfolded (#2477), which the bar at its foot does too.
            expect(html, id).toContain(">Keep it unfolded<");
            expect(html, id).toMatch(/role="switch" aria-checked="false"[^>]*data-testid="companion-setting-unfolded"/);
            expect(settingsOf(id, setSectionUnfolded(DefaultCompanionLayout, id, true)), id).toMatch(
                /role="switch" aria-checked="true"[^>]*data-testid="companion-setting-unfolded"/
            );
            expect(html.includes("companion-setting-minimal"), id).toBe(id === "usage");
            expect(html.includes("companion-setting-attached"), id).toBe(id === "usage");
        }
        const tasks = settingsOf("tasks", DefaultCompanionLayout, { reviewopen: true, takenopen: false });
        expect(tasks).toContain(">Open the group Taken by others<");
        expect(tasks).toContain(">Open the group To review<");
        expect(tasks).toContain(">Open the group In progress, nobody on it<");
        expect(tasks).toMatch(/role="switch" aria-checked="true"[^>]*data-testid="companion-setting-reviewopen"/);
        expect(tasks).toMatch(/role="switch" aria-checked="false"[^>]*data-testid="companion-setting-takenopen"/);
        const files = settingsOf("files", DefaultCompanionLayout, { filesopen: true });
        expect(files).toContain(">List every changed file<");
        expect(files).toMatch(/role="switch" aria-checked="true"[^>]*data-testid="companion-setting-filesopen"/);
        for (const id of ["agents", "topics", "answer", "task", "permission"] as const) {
            expect(settingsOf(id, DefaultCompanionLayout).match(/role="switch"/g), id).toHaveLength(3);
        }
    });

    it("shows a hidden block's settings with Show off", () => {
        const html = settingsOf("topics", setSectionHidden(DefaultCompanionLayout, "topics", true));
        expect(html).toMatch(/role="switch" aria-checked="false"[^>]*data-testid="companion-setting-shown"/);
    });

    it("hosts a drop zone at the bottom of the main agent's block only while the usage block is carried", () => {
        const hero = (zone: { active: boolean; over: boolean; attached: boolean } | null) =>
            renderToStaticMarkup(
                <CompanionHero
                    view={view}
                    agentState={agentState}
                    provider=""
                    arranging={true}
                    onArrange={noop}
                    onLeaveArranging={noop}
                    integrationDetails={false}
                    persistentIntegration={false}
                    onIntegration={noop}
                    onHistory={noop}
                    onBackToCurrent={noop}
                    attachZone={zone == null ? null : { ref: { current: null }, ...zone }}
                />
            );
        expect(hero(null)).not.toContain("companion-attach-zone");
        expect(hero({ active: false, over: false, attached: false })).not.toContain("companion-attach-zone");
        const carried = hero({ active: true, over: false, attached: false });
        expect(carried).toContain('data-testid="companion-attach-zone"');
        expect(carried).toContain("Drop the plan usage here to attach it to the main agent");
        expect(carried).not.toContain("data-over");
        expect(hero({ active: true, over: true, attached: false })).toMatch(
            /data-over=""[^>]*data-testid="companion-attach-zone"/
        );
        const attached = hero({ active: true, over: false, attached: true });
        expect(attached).toContain("data-attached");
        expect(attached).toContain("Drag it out into the list to detach it");
        // The zone is the last thing of the block, under the identity (and under the attached usage's rows).
        expect(carried.indexOf('data-testid="companion-link"')).toBeLessThan(carried.indexOf("companion-attach-zone"));
    });

    it("draws no drop zone in the dashboard before a block is carried, attached or not", () => {
        for (const layout of [DefaultCompanionLayout, attachedLayout]) {
            expect(shown(layout, { arranging: true })).not.toContain("companion-attach-zone");
            expect(shown(layout, { arranging: false })).not.toContain("companion-attach-zone");
        }
    });

    it("keeps the attached usage in the main agent's block while arranging, once, with its rows and a handle to detach it", () => {
        const normal = shown(attachedLayout);
        const html = shown(attachedLayout, { arranging: true });
        const hero = heroOf(html);
        const row = hero.slice(hero.indexOf('data-testid="companion-hero-usage"'));
        // The same rows, once: it is not drawn again as a block of the flow.
        expect(labelsOf(row)).toEqual(["Consumption", "Fable"]);
        expect(labelsOf(html)).toEqual(["Consumption", "Fable"]);
        expect(flowIds(html)).not.toContain("usage");
        expect(html).not.toContain('data-testid="companion-usage-block"');
        // Held still, under its own controls: the handle that detaches it, the eye and the gear.
        expect(row).toMatch(/class="mt-cdash-hero-usage-body" inert=""/);
        expect(row).toContain('data-testid="companion-attached-controls"');
        expect(row).toContain('aria-label="Detach Plan usage from the main agent"');
        expect(row).toContain('data-testid="companion-arrange-detach"');
        expect(row).toContain('aria-label="Show Plan usage"');
        expect(row).toContain('aria-label="Settings of Plan usage"');
        // It has no rank, so it has neither a handle to move it nor a full width to set.
        expect(row).not.toContain("companion-arrange-handle");
        expect(row).not.toContain("companion-arrange-wide");
        // Nothing of it is overlaid outside the mode.
        expect(heroOf(normal)).not.toContain("companion-attached-controls");
        expect(heroOf(normal)).not.toContain("inert");
    });

    it("says when an attached usage with no reading shows, and draws nothing of it outside the mode", () => {
        const none = shown(attachedLayout, {
            arranging: true,
            fixtures: { milestones: { dir: "/w", state: "none" }, usage: { kind: "hidden" } },
        });
        const hero = heroOf(none);
        expect(hero).toContain('data-testid="companion-hero-usage"');
        expect(hero).toContain("Shown when the agent gives its usage");
        expect(hero).toContain('data-testid="companion-arrange-detach"');
        // Outside the mode it draws nothing.
        expect(
            heroOf(
                shown(attachedLayout, {
                    fixtures: { milestones: { dir: "/w", state: "none" }, usage: { kind: "hidden" } },
                })
            )
        ).not.toContain("companion-hero-usage");
    });

    it("shows a hidden usage as a ghost with an eye, attached or not", () => {
        const html = shown(setSectionHidden(attachedLayout, "usage", true), { arranging: true });
        expect(heroOf(html)).not.toContain('data-testid="companion-hero-usage"');
        const usage = block(html, "usage");
        expect(usage).toContain('data-ghost="hidden"');
        expect(usage).toContain('aria-label="Show Plan usage"');
        expect(flowIds(html)[flowIds(html).length - 1]).toBe("usage");
    });

    it("reads in French", () => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            const arranging = heroOf(shown(attachedLayout, { arranging: true }));
            expect(arranging).toContain("Détacher Utilisation de l&#x27;abonnement de l&#x27;agent principal");
            const settings = settingsOf("usage", attachedLayout);
            expect(settings).toContain("Rattacher à l&#x27;agent principal");
            expect(settings).toContain("Forme d&#x27;Utilisation");
            expect(settings).toContain(">Minimale<");
            expect(settings).toContain(">Afficher dans le tableau de bord<");
            const minimal = flowBlock(shown(minimalLayout), "usage");
            expect(minimal).toContain("par jour :");
            expect(minimal).toContain("Par jour :");
        } finally {
            i18n.setLanguageSetting("");
        }
    });
});
