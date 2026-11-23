// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The choice of the plan usage's rows as it is drawn (#2462): the "Rows shown" switches, the tool of the usage block and
// its count, the full, minimal and attached forms showing the rows chosen, and the settings popover of the arranging mode.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import { I18nModel, t } from "../i18n/i18n";
import { SectionNameKeys, setUsageAttached, setUsageMinimal } from "./companion-arrange-model";
import { SettingsBody } from "./companion-block-settings";
import { CompanionDashboard, CompanionDashboardProps } from "./companion-dashboard";
import { PlanUsageBody, UsageFrame } from "./companion-gauges";
import { CompanionUsageInfo, gaugesView, UsageWindowChoice } from "./companion-gauges-model";
import { CompanionLayout, CompanionSectionId, DefaultCompanionLayout } from "./companion-layout";
import type { CompanionView } from "./companion-model";
import { saidKey, UsageRowsChoice } from "./companion-usage-rows";
import { setUsageRowHidden, withRowChoice } from "./companion-usage-rows-model";

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
const Min = 60 * 1000;
const Hour = 60 * Min;
// Thursday 19 November 2026, 12:00 local.
const now = new Date(2026, 10, 19, 12, 0, 0).getTime();
const monday = new Date(2026, 10, 23, 0, 0, 0).getTime();

const claude: CompanionUsageInfo = {
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
        readat: now - 2 * Min,
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

const kimi: CompanionUsageInfo = {
    blockid: "t1",
    agent: "kimi",
    pageurl: "https://www.kimi.ai/code/console",
    pagename: "Kimi usage",
    hasgauges: true,
    gauges: "enabled",
    sourcename: "Kimi Code managed usage endpoint",
    snapshot: {
        agent: "kimi",
        source: "kimi-oauth",
        readat: now - 2 * Min,
        windows: [
            {
                id: "session",
                label: "Current session",
                usedpercent: 0.15,
                resetsat: now + Hour + 20 * Min,
                windowmins: 300,
            },
            {
                id: "week",
                label: "Week (from the month)",
                usedpercent: 128.6,
                resetsat: monday,
                windowmins: 10080,
                deduced: true,
                days: [-1, -1, 240, 150, 0, 0, 0],
            },
            { id: "month", label: "This month", usedpercent: 30, resetsat: new Date(2026, 11, 1, 1, 0).getTime() },
        ],
    },
};

const labelsOf = (html: string) => [...html.matchAll(/data-testid="usage-week-label">([^<]*)</g)].map((m) => m[1]);
const percentsOf = (html: string) => [...html.matchAll(/data-testid="usage-week-percent">([^<]*)</g)].map((m) => m[1]);
const count = (html: string, mark: string) => html.split(mark).length - 1;

describe("the switches of the rows shown (#2462)", () => {
    const windows = [
        { id: "session", label: "Session" },
        { id: "week", label: "Week" },
        { id: "month", label: "Month" },
    ];
    const choices = (hidden: string[]): UsageWindowChoice[] =>
        windows.map((w) => ({ ...w, shown: !hidden.includes(w.id) }));
    const html = (list: UsageWindowChoice[], separated?: boolean) =>
        renderToStaticMarkup(<UsageRowsChoice choices={list} onSet={noop} separated={separated} />);
    const switchOf = (markup: string, id: string): string => {
        const at = markup.indexOf(`data-testid="companion-usage-row-${id}"`);
        expect(at, id).toBeGreaterThan(-1);
        return markup.slice(markup.lastIndexOf("<button", at), markup.indexOf("</button>", at));
    };

    it("lists every window by its name, with a switch that is on while its row shows", () => {
        const markup = html(choices(["month"]));
        expect(markup).toMatch(/role="group" aria-labelledby="[^"]+"[^>]*data-testid="companion-usage-rows"/);
        expect(markup).toContain(">Rows shown</h4>");
        expect([...markup.matchAll(/role="switch"/g)]).toHaveLength(3);
        expect(switchOf(markup, "session")).toContain('aria-checked="true"');
        expect(switchOf(markup, "week")).toContain('aria-checked="true"');
        expect(switchOf(markup, "month")).toContain('aria-checked="false"');
        expect(switchOf(markup, "month")).toContain(">Month<");
        expect(switchOf(markup, "month")).not.toContain("data-on");
        expect(switchOf(markup, "week")).toContain("data-on");
    });

    it("says how many rows are hidden, and when none is", () => {
        expect(html(choices([]))).toContain(">Every row is shown<");
        expect(html(choices(["month"]))).toContain(">1 row hidden<");
        expect(html(choices(["session", "month"]))).toContain(">2 rows hidden<");
    });

    it("keeps the last row that shows on: its switch is disabled, named and says why", () => {
        const markup = html(choices(["session", "month"]));
        const last = switchOf(markup, "week");
        expect(last).toContain('aria-disabled="true"');
        expect(last).toMatch(/aria-describedby="([^"]+)"/);
        const why = /aria-describedby="([^"]+)"/.exec(last)[1];
        expect(last).toContain(`id="${why}"`);
        expect(last).toContain('data-tip="At least one row stays shown"');
        expect(last).toContain(">At least one row stays shown<");
        // The ones that are off, and any one while several show, are plain switches.
        expect(switchOf(markup, "session")).not.toContain("aria-disabled");
        expect(switchOf(html(choices([])), "week")).not.toContain("aria-disabled");
        expect(switchOf(html(choices(["month"])), "session")).not.toContain("aria-disabled");
        // It is a button that keeps the focus, not a disabled one the keyboard would skip.
        expect(last).not.toMatch(/ disabled(=|>| )/);
    });

    it("waits for the windows, and has no switch to offer without one", () => {
        const markup = html([]);
        expect(markup).toContain('data-testid="companion-usage-rows-none"');
        expect(markup).toContain("The rows appear once the plan&#x27;s usage is read.");
        expect(markup).not.toContain('role="switch"');
    });

    it("sets itself under a hairline after the other options, when asked", () => {
        expect(html(choices([]), true)).toContain("mt-cb-rows mt-cb-rows-separated");
        expect(html(choices([]))).not.toContain("mt-cb-rows-separated");
    });

    it("reads in French", () => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            const markup = html(choices(["session", "month"]));
            expect(markup).toContain(">Lignes affichées</h4>");
            expect(markup).toContain(">2 lignes masquées<");
            expect(markup).toContain("Au moins une ligne reste affichée");
            expect(html(choices(["month"]))).toContain(">1 ligne masquée<");
            expect(html(choices([]))).toContain(">Toutes les lignes sont affichées<");
        } finally {
            i18n.setLanguageSetting("");
        }
    });
});

describe("the rows tool of the usage block (#2462)", () => {
    const body = { onShow: noop, onHide: noop, onRefresh: noop };
    const frame: UsageFrame = ({ tools, body: content }) => (
        <div>
            <div data-testid="tools">{tools}</div>
            {content}
        </div>
    );
    const framed = (
        info: CompanionUsageInfo,
        form: "full" | "minimal" | "attached",
        hidden: string[],
        withTool = true
    ) =>
        renderToStaticMarkup(
            <PlanUsageBody
                view={withRowChoice(gaugesView(info, now), hidden)}
                rows={{ hidden, ...(withTool ? { onSet: noop } : {}) }}
                {...body}
                frame={frame}
                form={form}
            />
        );

    it("is offered in every form, closed, naming the dialog it opens", () => {
        for (const form of ["full", "minimal", "attached"] as const) {
            const html = framed(kimi, form, []);
            expect(count(html, 'data-testid="companion-usage-rows-tool"'), form).toBe(1);
            const tool = html.slice(html.lastIndexOf("<button", html.indexOf("companion-usage-rows-tool")));
            expect(tool, form).toContain('aria-label="Choose the rows shown"');
            expect(tool, form).toContain('aria-haspopup="dialog"');
            expect(tool, form).toContain('aria-expanded="false"');
            expect(html, form).not.toContain('role="dialog"');
            expect(html, form).not.toContain("companion-usage-rows-count");
        }
    });

    it("stands among the tools while only the rows are drawn, and on the line of the source in the full block", () => {
        const toolsOf = (html: string) => html.slice(0, html.indexOf("</div>"));
        for (const form of ["minimal", "attached"] as const) {
            expect(toolsOf(framed(kimi, form, [])), form).toContain("companion-usage-rows-tool");
        }
        const full = framed(kimi, "full", []);
        // The tools chip of the full block keeps room for the age, the refresh and Hide.
        expect(toolsOf(full)).not.toContain("companion-usage-rows-tool");
        expect(toolsOf(full)).toContain("companion-plan-usage-refresh");
        expect(full.indexOf("companion-usage-rows-tool")).toBeGreaterThan(full.indexOf("Experimental"));
        expect(full.indexOf("companion-usage-rows-tool")).toBeLessThan(full.indexOf("usage-week-legend"));
    });

    it("carries the number of rows hidden, in its name and beside its icon", () => {
        const html = framed(kimi, "minimal", ["session", "month"]);
        expect(html).toContain('aria-label="Choose the rows shown (2 rows hidden)"');
        expect(html).toMatch(/data-testid="companion-usage-rows-count">2</);
        const one = framed(claude, "full", ["model:fable"]);
        expect(one).toContain('aria-label="Choose the rows shown (1 row hidden)"');
        expect(one).toMatch(/data-testid="companion-usage-rows-count">1</);
    });

    it("is offered only where the block can set a row, and where there is a choice to make", () => {
        expect(framed(kimi, "full", [], false)).not.toContain("companion-usage-rows-tool");
        const single: CompanionUsageInfo = {
            ...claude,
            snapshot: { ...claude.snapshot, windows: claude.snapshot.windows.slice(0, 1) },
        };
        expect(framed(single, "full", [])).not.toContain("companion-usage-rows-tool");
    });

    it("draws only the rows chosen in the full, minimal and attached forms: Kimi's week alone", () => {
        for (const form of ["full", "minimal", "attached"] as const) {
            const html = framed(kimi, form, ["session", "month"]);
            expect(labelsOf(html), form).toEqual(["Consumption"]);
            expect(percentsOf(html), form).toEqual(["129 %"]);
            // The week keeps its seven days, its count to the month's reset and its reset icon.
            expect(count(html, 'data-testid="usage-week-block"'), form).toBe(7);
            expect(html, form).toContain("from the month");
            expect(html, form).toContain('data-testid="usage-week-reset"');
        }
    });

    it("draws Claude's week without Fable's, and every row when nothing is hidden", () => {
        for (const form of ["full", "minimal", "attached"] as const) {
            expect(labelsOf(framed(claude, form, ["model:fable"])), form).toEqual(["Consumption"]);
            expect(labelsOf(framed(claude, form, [])), form).toEqual(["Consumption", "Fable"]);
        }
    });

    it("keeps the deduced week, with its count, when the month row is hidden, and the month's reset when the week is", () => {
        const noMonth = framed(kimi, "minimal", ["month"]);
        expect(labelsOf(noMonth)).toEqual(["Consumption"]);
        expect(noMonth).toMatch(/data-testid="usage-week-chip"[^>]*>\d+ d</);
        const noWeek = framed(kimi, "minimal", ["week"]);
        expect(labelsOf(noWeek)).toEqual(["Month"]);
        // With the week that counted to it hidden, the month's bar says its own reset again, not only in its tooltip.
        expect(noWeek).toContain(">Tue 1 Dec, 01:00<");
        expect(framed(kimi, "minimal", [])).not.toContain(">Tue 1 Dec, 01:00<");
    });

    it("shows every row of a choice that would hide them all", () => {
        expect(labelsOf(framed(claude, "full", ["week", "model:fable"]))).toEqual(["Consumption", "Fable"]);
    });

    it("draws the session's ring in every form while its window shows, and none once it is hidden (#2473)", () => {
        for (const form of ["full", "minimal", "attached"] as const) {
            const shown = framed(kimi, form, []);
            expect(count(shown, 'data-testid="usage-week-session"'), form).toBe(1);
            expect(shown, form).not.toContain('data-window="session"');
            const hidden = framed(kimi, form, ["session"]);
            expect(hidden, form).not.toContain('data-testid="usage-week-session"');
            expect(hidden, form).not.toContain('data-window="session"');
            // The other windows keep their rows, hidden or not.
            expect(labelsOf(hidden), form).toEqual(["Consumption", "Month"]);
            expect(labelsOf(shown), form).toEqual(["Consumption", "Month"]);
        }
    });

    it("keeps the day letters and the ring alone when the session is the only window shown (#2473)", () => {
        const html = framed(kimi, "minimal", ["week", "month"]);
        expect(labelsOf(html)).toEqual([]);
        expect(count(html, 'data-testid="usage-week-session"')).toBe(1);
        expect(count(html, 'data-testid="usage-week-day"')).toBe(7);
        expect(html).not.toContain('data-testid="usage-week-row"');
    });

    it("names the session's entry for what it draws, and says so when it changes", () => {
        const html = renderToStaticMarkup(
            <UsageRowsChoice
                choices={[
                    { id: "session", label: "Session (ring on today)", shown: true },
                    { id: "week", label: "Consumption", shown: true },
                ]}
                onSet={noop}
            />
        );
        expect(html).toContain("Session (ring on today)");
        expect(saidKey("session", true)).toBe("companion.gauges.rows.ringHidden");
        expect(saidKey("session", false)).toBe("companion.gauges.rows.ringShown");
        expect(saidKey("week", true)).toBe("companion.gauges.rows.nowHidden");
        expect(saidKey("week", false)).toBe("companion.gauges.rows.nowShown");
    });

    it("keeps the extras of the full block, and nothing of them in the other forms", () => {
        expect(framed(kimi, "full", ["session"])).toContain('data-testid="companion-plan-usage-explain"');
        expect(framed(kimi, "minimal", ["session"])).not.toContain('data-testid="companion-plan-usage-explain"');
    });
});

describe("the choice in the dashboard (#2462)", () => {
    const agentState: AgentStateInfo = {
        blockid: "t1",
        agent: "claude",
        agentname: "Claude Code",
        firstname: "Flore",
        state: "working",
        version: 1,
    };
    const view = (info: CompanionUsageInfo): CompanionView => ({
        blockid: "t1",
        version: 1,
        status: "live",
        agent: info.agent,
        agentname: info.agent === "kimi" ? "Kimi Code" : "Claude Code",
        usage: { pageurl: info.pageurl, pagename: info.pagename } as CompanionView["usage"],
        session: { path: "/s/a.jsonl", linkedby: "hook", title: "Ship the search", started: now - 60_000 },
        topics: [{ text: "Write the tests", last: now - 60_000 }],
    });
    const markup = (info: CompanionUsageInfo, layout: CompanionLayout, extra: Partial<CompanionDashboardProps> = {}) =>
        renderToStaticMarkup(
            <CompanionDashboard
                view={view(info)}
                target="t1"
                companionId="c1"
                agentState={agentState}
                provider=""
                dir=""
                folder="/w"
                layout={layout}
                onSaveLayout={noop}
                arranging={false}
                onArrange={noop}
                onLeaveArranging={noop}
                arrangeRef={{ current: null }}
                integrationDetails={false}
                persistentIntegration={false}
                onIntegration={noop}
                onHistory={noop}
                onBackToCurrent={noop}
                fixtures={{ milestones: { dir: "/w", state: "none" }, usage: gaugesView(info, now) }}
                {...extra}
            />
        );
    const hide = (layout: CompanionLayout, provider: string, ids: string[], reported: string[]) =>
        ids.reduce((l, id) => setUsageRowHidden(l, provider, id, true, reported), layout);
    const heroOf = (html: string): string => {
        const at = html.indexOf('data-testid="companion-session-bar"');
        return html.slice(html.lastIndexOf("<section", at), html.indexOf('data-testid="companion-flow"'));
    };
    const flowBlock = (html: string, id: string): string => {
        const at = html.indexOf(`data-flow-id="${id}"`);
        expect(at, `a block ${id}`).toBeGreaterThan(-1);
        const next = html.indexOf("data-flow-id=", at + 1);
        return html.slice(html.lastIndexOf("<section", at), next < 0 ? undefined : html.lastIndexOf("<section", next));
    };

    it("shows the rows of the provider's choice in the usage block, full and minimal", () => {
        const layout = hide(DefaultCompanionLayout, "kimi", ["session", "month"], ["session", "week", "month"]);
        expect(labelsOf(flowBlock(markup(kimi, layout), "usage"))).toEqual(["Consumption"]);
        expect(labelsOf(flowBlock(markup(kimi, setUsageMinimal(layout, true)), "usage"))).toEqual(["Consumption"]);
        expect(flowBlock(markup(kimi, layout), "usage")).toContain('data-testid="companion-usage-rows-tool"');
    });

    it("shows them in the usage attached to the main agent, whose tools carry the rows tool", () => {
        const layout = setUsageAttached(
            hide(DefaultCompanionLayout, "claude", ["model:fable"], ["week", "model:fable"]),
            true
        );
        const hero = heroOf(markup(claude, layout));
        const row = hero.slice(hero.indexOf('data-testid="companion-hero-usage"'));
        expect(labelsOf(row)).toEqual(["Consumption"]);
        const tools = hero.slice(hero.indexOf('data-side="tools"'), hero.indexOf('data-testid="companion-hero-usage"'));
        expect(tools).toContain('data-testid="companion-usage-rows-tool"');
        expect(tools).toContain('aria-label="Choose the rows shown (1 row hidden)"');
    });

    it("applies the choice of the provider whose plan it is, and no other", () => {
        const layout = hide(DefaultCompanionLayout, "kimi", ["session", "month"], ["session", "week", "month"]);
        expect(labelsOf(flowBlock(markup(claude, layout), "usage"))).toEqual(["Consumption", "Fable"]);
        expect(flowBlock(markup(claude, layout), "usage")).not.toContain("companion-usage-rows-count");
    });

    it("shows every row for a layout saved before the choice", () => {
        expect(labelsOf(flowBlock(markup(kimi, DefaultCompanionLayout), "usage"))).toEqual(["Consumption", "Month"]);
        expect(flowBlock(markup(kimi, DefaultCompanionLayout), "usage")).toContain('data-testid="usage-week-session"');
    });

    it("keeps the usage page one click away, whatever rows show", () => {
        const layout = hide(DefaultCompanionLayout, "kimi", ["session", "month"], ["session", "week", "month"]);
        expect(count(markup(kimi, layout), 'data-testid="companion-usage"')).toBe(1);
        expect(markup(kimi, layout)).toContain(">Open the usage page<");
    });

    it("draws the rows chosen in the usage while arranging, held still, the choice being in the block's settings", () => {
        const layout = hide(DefaultCompanionLayout, "kimi", ["session", "month"], ["session", "week", "month"]);
        const html = markup(kimi, layout, { arranging: true });
        const usage = flowBlock(html, "usage");
        expect(labelsOf(usage)).toEqual(["Consumption"]);
        // The block's own tools give way to the arranging controls (#2467); the rows tool of the full form is in its
        // content, which is held still.
        expect(usage.indexOf("companion-usage-rows-tool")).toBeGreaterThan(usage.indexOf('class="mt-cb-body"'));
        expect(usage).toContain('data-testid="companion-arrange-settings"');
        expect(usage).toContain('data-testid="companion-arrange-handle"');
        expect(usage).toMatch(/class="mt-cb-body" inert=""/);
    });

    const settingsOf = (
        id: CompanionSectionId,
        layout: CompanionLayout,
        choices?: UsageWindowChoice[],
        onSet: (id: string, hide: boolean) => void = noop
    ) =>
        renderToStaticMarkup(
            <SettingsBody
                id={id}
                name={t(SectionNameKeys[id])}
                placement={layout.find((p) => p.id === id)}
                prefs={{}}
                onChange={noop}
                onClose={noop}
                rows={choices ? { choices, onSet } : undefined}
            />
        );
    const windows: UsageWindowChoice[] = [
        { id: "session", label: "Session", shown: false },
        { id: "week", label: "Week", shown: true },
        { id: "month", label: "Month", shown: false },
    ];

    it("lists the rows in the usage block's settings, under its other options", () => {
        const html = settingsOf("usage", DefaultCompanionLayout, windows);
        expect(html).toContain('data-testid="companion-usage-rows"');
        expect(html.indexOf('data-testid="companion-setting-attached"')).toBeLessThan(
            html.indexOf('data-testid="companion-usage-rows"')
        );
        expect(html).toContain("mt-cb-rows-separated");
        expect(html).toContain(">Rows shown</h4>");
        expect(html).toMatch(/aria-checked="false"[^>]*data-testid="companion-usage-row-session"/);
        expect(html).toMatch(/aria-checked="true"[^>]*data-testid="companion-usage-row-week"/);
        expect(html).toContain(">2 rows hidden<");
    });

    it("lists no rows in the settings of any other block, nor before the usage is read", () => {
        for (const id of ["tasks", "agents", "topics", "answer", "task", "files", "permission"] as const) {
            expect(settingsOf(id, DefaultCompanionLayout, windows), id).not.toContain("companion-usage-rows");
        }
        expect(settingsOf("usage", DefaultCompanionLayout)).not.toContain("companion-usage-rows");
        expect(settingsOf("usage", DefaultCompanionLayout, [])).toContain("companion-usage-rows-none");
    });
});
