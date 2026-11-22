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
    it("folds every block to its label and one line, in the layout's order, with its handle and its three buttons", () => {
        const html = markup(DefaultCompanionLayout);
        expect(order(html)).toEqual(DefaultCompanionLayout.map((p) => p.id));
        const n = CompanionSectionIds.length;
        expect(html.match(/data-testid="companion-arrange-handle"/g)).toHaveLength(n);
        expect(html.match(/data-testid="companion-arrange-switch"/g)).toHaveLength(n);
        expect(html.match(/data-testid="companion-arrange-wide"/g)).toHaveLength(n);
        expect(html.match(/data-testid="companion-arrange-settings"/g)).toHaveLength(n);
        const tasks = block(html, "tasks");
        // The rank is in the handle's name, for the screen reader: no number, Up or Down is drawn (#2459).
        expect(tasks).toContain('aria-label="Move Tasks, position 2 of 8"');
        expect(tasks).toContain('aria-label="Full width for Tasks"');
        expect(tasks).toContain('aria-label="Show Tasks"');
        expect(tasks).toContain('aria-label="Settings of Tasks"');
        expect(tasks).not.toContain("companion-arrange-rank");
        expect(tasks).not.toContain("Move Tasks up");
        expect(tasks).not.toContain("Move Tasks down");
        expect(tasks).toContain("The project&#x27;s open milestones and their tickets");
        // Nothing but the summary while arranging: no milestone, no list.
        expect(html).not.toContain('data-testid="companion-milestone"');
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
        expect(block(html, "files")).toContain('aria-label="Move Files changed, position 1 of 8"');
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
            expect(html).toContain("Réglages de");
            expect(html).toContain("position 2 sur 8");
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
    // What the full block adds to the rows: the day letters, the figures, the legend, the paragraph and the rest.
    const Extras = [
        'data-testid="usage-week-day"',
        'data-testid="usage-week-share"',
        'data-testid="usage-week-legend"',
        'data-testid="usage-week-note"',
        'data-testid="companion-plan-usage-explain"',
        "Experimental",
        'class="mt-cb-foot"',
    ];

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

    it("draws the minimal form as its window rows alone: a label, a strip and a percentage each", () => {
        const html = shown(minimalLayout);
        expect(flowIds(html)).toEqual(["agents", "usage", "topics", "answer", "files"]);
        const usage = flowBlock(html, "usage");
        expect(usage).toContain('data-form="minimal"');
        expect(labelsOf(usage)).toEqual(["Week", "Week (Fable)"]);
        expect(percentsOf(usage)).toEqual(["63 %", "12 %"]);
        expect(count(usage, 'data-testid="usage-week-row"')).toBe(2);
        expect(count(usage, 'data-testid="usage-week-block"')).toBe(14);
        // Today's mark and the reset day's ring stay on the strip.
        expect(count(usage, 'data-today="true"')).toBe(2);
        expect(count(usage, 'data-reset="true"')).toBe(2);
        for (const extra of Extras) {
            expect(usage, extra).not.toContain(extra);
        }
        expect(usage).not.toContain('data-testid="companion-plan-usage-credits"');
        expect(usage).not.toContain(">Hide<");
    });

    it("gives the reset and the figure of each day in the row's tooltip and accessible name", () => {
        const usage = flowBlock(shown(minimalLayout), "usage");
        expect(usage).toMatch(
            /aria-label="This week, 63 %, resets [A-Za-z]+, per day: (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+ %(, (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+ %){6}"/
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
        expect(labelsOf(row)).toEqual(["Week", "Week (Fable)"]);
        expect(percentsOf(row)).toEqual(["63 %", "12 %"]);
        expect(count(row, 'data-testid="usage-week-block"')).toBe(14);
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

    it("says in the block's summary line, and in its settings, what the arranged usage is", () => {
        const minimal = block(shown(minimalLayout, { arranging: true }), "usage");
        expect(minimal).toContain("The plan&#x27;s usage, the rows only");
        expect(settingsOf("usage", minimalLayout)).toMatch(/role="radio" aria-checked="true"[^>]*>Minimal</);
        const attached = block(shown(attachedLayout, { arranging: true }), "usage");
        expect(attached).toContain("Attached to the main agent, the rows only");
        const settings = settingsOf("usage", attachedLayout);
        expect(settings).toMatch(/role="switch" aria-checked="true"[^>]*data-testid="companion-setting-attached"/);
        // The size is for the block standing on its own: it waits, and is kept for the day the block is detached.
        expect(settings).toContain("<fieldset disabled");
        expect(settings).toMatch(/role="radio" aria-checked="true"[^>]*>Minimal</);
    });

    it("gives every other block Show and Full width, and the options it already had, none new", () => {
        const wide = (html: string, on: boolean) =>
            expect(html).toMatch(
                new RegExp(`role="switch" aria-checked="${on}"[^>]*data-testid="companion-setting-wide"`)
            );
        for (const id of CompanionSectionIds) {
            const html = settingsOf(id, DefaultCompanionLayout);
            expect(html, id).toContain('data-testid="companion-setting-shown"');
            wide(html, id === "permission");
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
            expect(settingsOf(id, DefaultCompanionLayout).match(/role="switch"/g), id).toHaveLength(2);
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

    it("folds every block to a line while arranging, the attached usage included", () => {
        const html = shown(attachedLayout, { arranging: true });
        expect(html).not.toContain('data-testid="companion-hero-usage"');
        expect(html).not.toContain('data-testid="usage-week"');
        expect(order(html)).toEqual(attachedLayout.map((p) => p.id));
        expect(block(html, "usage")).toContain('data-section="usage"');
    });

    it("reads in French", () => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            const arranging = block(shown(attachedLayout, { arranging: true }), "usage");
            expect(arranging).toContain("Rattaché à l&#x27;agent principal, les lignes seules");
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
