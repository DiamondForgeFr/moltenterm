// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The agent companion as the main agent's dashboard (#2441, FR-SHELL-018) on invented data, in one frame as wide as the
// companion. The frame holds the real dashboard: hero, flow, blocks and arranging mode.
// ?w=420|760|1200 the width, ?theme=light, ?agents=N more sub-agents, ?agent=waiting|idle, ?arrange=1, ?lang=fr,
// ?usage=minimal|attached the plan usage's form (#2450), ?h=N a frame N px high holding the dashboard in the scroller the
// app gives it (?scroll=end scrolled to the bottom), ?images=1 the messages name pasted images "[Image #N]" (#2455; the
// chips read a small synthetic image drawn here, ?images=none gives them none), ?tip=<test id>[&tipat=N] a popover held
// open on the Nth element of that test id (the screenshots' way of hovering).

import { useEffect, useRef, useState } from "react";
import type { AgentStateInfo } from "../../moltenterm-shell/agent-state-model";
import { setUsageAttached, setUsageMinimal } from "../../moltenterm-shell/companion/companion-arrange-model";
import { CompanionDashboard } from "../../moltenterm-shell/companion/companion-dashboard";
import { CompanionUsageInfo, gaugesView } from "../../moltenterm-shell/companion/companion-gauges-model";
import {
    agentState as leadState,
    panelOn,
    statesOf,
    subagent,
    ThisWorkspace,
    upcomingOf,
} from "../../moltenterm-shell/companion/companion-holds-fixture";
import { CompanionLayout, DefaultCompanionLayout } from "../../moltenterm-shell/companion/companion-layout";
import { MilestonesView } from "../../moltenterm-shell/companion/companion-milestone-model";
import { CompanionSubagent, CompanionView } from "../../moltenterm-shell/companion/companion-model";
import { TaskView } from "../../moltenterm-shell/companion/companion-task-model";
import { CompanionTips } from "../../moltenterm-shell/companion/companion-tips";
import type { CompanionImage } from "../../moltenterm-shell/companion/companion-tips-model";
import { I18nModel, useT } from "../../moltenterm-shell/i18n/i18n";

import "../../moltenterm-shell/molten-button.css";
import "../../moltenterm-shell/moltenterm-shell.css";

const Min = 60 * 1000;
const Hour = 60 * Min;
const Now = Date.now();

const query = new URLSearchParams(globalThis.location?.search);
if (query.get("lang")) {
    I18nModel.getInstance().setLanguageSetting(query.get("lang"));
}
if (query.get("theme") === "light") {
    globalThis.document?.documentElement.classList.add("mt-light", "df-light");
}
const Width = Number(query.get("w")) || 760;
const Extra = Number(query.get("agents")) || 0;
const AgentMode = query.get("agent") ?? "running";
const UsageForm = query.get("usage");
const FrameHeight = Number(query.get("h")) || 0;
const Images = query.get("images");
const HeldTip = query.get("tip");
const HeldTipAt = Number(query.get("tipat")) || 0;

// A small synthetic picture (a drawing of a settings page) for the chips of ?images=1: nothing of anyone's.
function syntheticImage(n: number): Promise<CompanionImage> {
    if (Images === "none") {
        return Promise.reject(new Error("no such image"));
    }
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 400;
    const ctx = canvas.getContext("2d");
    const fill = ctx.createLinearGradient(0, 0, 640, 400);
    fill.addColorStop(0, "#27303f");
    fill.addColorStop(1, "#4a3a5c");
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, 640, 400);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(24, 24, 160, 352);
    for (let i = 0; i < 6; i++) {
        ctx.fillStyle = i === n % 6 ? "rgba(255,170,90,0.85)" : "rgba(255,255,255,0.35)";
        ctx.fillRect(40, 48 + i * 40, 128, 14);
        ctx.fillStyle = "rgba(255,255,255,0.22)";
        ctx.fillRect(216, 48 + i * 40, 280 + ((i * 53) % 120), 14);
    }
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.font = "20px sans-serif";
    ctx.fillText(`Synthetic screenshot #${n}`, 216, 352);
    return Promise.resolve({ mime: "image/png", data: canvas.toDataURL("image/png").split(",")[1] });
}

const imagesOn = Images != null;

function startLayout(): CompanionLayout {
    if (UsageForm === "attached") {
        return setUsageAttached(setUsageMinimal(DefaultCompanionLayout, true), true);
    }
    return setUsageMinimal(DefaultCompanionLayout, UsageForm === "minimal");
}

const Names = ["Jade", "Noah", "Lou", "Ines", "Arthur", "Lena", "Sacha", "Mael", "Rose", "Hugo"];
const Tasks = [
    "Read the labels in English again",
    "Time the filter over 400 options",
    "Fix the order of imported sections",
    "Add the search's keyboard shortcuts",
    "Check the contrast in the light theme",
    "Write the search's documentation",
    "Clean the old settings up",
    "Test the import of a broken file",
    "Translate the options' descriptions",
    "Profile the page's first render",
];

const subagents: CompanionSubagent[] = [
    {
        id: "olivia",
        description: "#815 Wire the filter into the page",
        kind: "general-purpose",
        model: "claude-sonnet-4-5",
        effort: "medium",
        branch: "feature/815-settings-filter",
        state: "running",
        started: Now - 9 * Min,
    },
    {
        id: "malo",
        description: "Find the labels without a translation",
        kind: "Explore",
        model: "claude-haiku-4-5",
        effort: "low",
        background: true,
        state: "running",
        started: Now - 2 * Min,
    },
    { id: "ines", description: "Read the settings page", state: "done", started: Now - 30 * Min, ended: Now - 8 * Min },
    ...Array.from({ length: Extra }, (_, i): CompanionSubagent => {
        const linked = i % 2 === 0;
        return {
            id: `extra-${i}`,
            description: `${linked ? `#${850 + i} ` : ""}${Tasks[i % Tasks.length]}`,
            kind: i % 3 === 0 ? "Explore" : "general-purpose",
            model: i % 2 ? "claude-haiku-4-5" : "claude-sonnet-4-5",
            effort: i % 2 ? "low" : "medium",
            branch: linked ? `feature/${850 + i}-${Names[i % Names.length].toLowerCase()}` : undefined,
            background: i % 3 === 0,
            state: "running",
            started: Now - (i + 1) * Min,
        };
    }),
];

const ticket = (number: number, title: string) => ({
    number,
    title,
    url: `https://github.com/example/lantern/issues/${number}`,
});

const milestones: MilestonesView = {
    dir: "/work/lantern",
    state: "ok",
    milestones: [
        {
            number: 4,
            title: "1.4.0",
            url: "https://github.com/example/lantern/milestone/4",
            open: 12 + Math.ceil(Extra / 2),
            closed: 34,
            due: Now - 2 * 24 * Hour,
            remaining: 12 + Math.ceil(Extra / 2),
            loaded: true,
            tickets: [
                ticket(812, "Search the settings"),
                ticket(815, "The filter folds the sections without a match"),
                ...Array.from({ length: Math.ceil(Extra / 2) }, (_, i) => ticket(850 + 2 * i, Tasks[(2 * i) % 10])),
                ticket(821, "The search shortcut puts the cursor in the field"),
                ticket(824, "Imported settings keep their order"),
                ticket(827, "An unknown setting shows read-only"),
                ticket(829, "The search ignores accents"),
                ticket(830, "A deep link opens one option"),
                ticket(833, "Recent options come first"),
                ticket(818, "Export the settings to a file"),
            ],
        },
        { number: 5, title: "1.5.0", open: 8, closed: 0, remaining: 8, tickets: [] },
    ],
};

const usage: CompanionUsageInfo = {
    blockid: "preview-terminal",
    agent: "claude",
    pageurl: "https://claude.ai/settings/usage",
    pagename: "Claude usage",
    hasgauges: true,
    gauges: "enabled",
    sourcename: "Claude Code status line",
    snapshot: {
        agent: "claude",
        source: "claude-statusline",
        readat: Now - 2 * Min,
        windows: [
            { id: "session", label: "Current session", usedpercent: 35, resetsat: Now + 3 * Hour, windowmins: 300 },
            { id: "week", label: "This week", usedpercent: 63, resetsat: Now + 4 * 24 * Hour, windowmins: 10080 },
            { id: "opus", label: "Opus this week", usedpercent: 12, resetsat: Now + 4 * 24 * Hour, windowmins: 10080 },
        ],
    },
};

const task: TaskView = {
    workspaceid: "ws-preview",
    path: "/work/lantern/.molten/task.md",
    exists: true,
    updated: Now - 40 * Min,
    versions: 2,
    redactions: 0,
    transcript: { agent: "claude", session: "s0", path: "/work/sessions/s0.jsonl" },
    sections: [
        {
            name: "Goal",
            owner: "auto",
            text: "Ship the settings search (#812) before the 1.4.0 freeze, without breaking the settings import.",
        },
        { name: "Plan and progress", owner: "auto", text: "- [x] a\n- [x] b\n- [x] c\n- [ ] d\n- [ ] e" },
        { name: "Next steps", owner: "auto", text: "- Write the filter's tests" },
        { name: "Last transcript", owner: "auto", text: "- Agent: Claude Code" },
    ],
} as TaskView;

// Another lead of the workspace, whose sub-agent holds #818: the milestone's "Taken by others" group.
const bastien = leadState("bastien", "claude", "Claude Code", "Bastien");
const holds = {
    upcoming: upcomingOf([panelOn(bastien, "develop"), subagent(bastien, 818)]),
    states: statesOf(bastien),
};

const agentState: AgentStateInfo = {
    blockid: "preview-terminal",
    agent: "claude",
    agentname: "Claude Code",
    firstname: "Heloise",
    workspaceid: ThisWorkspace,
    state: AgentMode === "waiting" ? "waiting" : AgentMode === "idle" ? "idle" : "working",
    model: "claude-opus-4-5",
    modelname: "Opus",
    effort: "high",
    version: 1,
};

const view: CompanionView = {
    blockid: "preview-terminal",
    version: 1,
    status: "live",
    agent: "claude",
    agentname: "Claude Code",
    usage: { pageurl: "https://claude.ai/settings/usage", pagename: "Claude usage" } as CompanionView["usage"],
    session: {
        path: "/work/sessions/s1.jsonl",
        linkedby: "hook",
        branch: "feature/812-settings-search",
        started: Now - 52 * Min,
        lastprompt: Now - 12 * Min,
        title: "Redo the settings page: each option says what it changes, a search filters the options as you type, and the translations follow in both languages.",
    },
    earlier: [{ path: "/work/sessions/s0.jsonl" }, { path: "/work/sessions/sa.jsonl" }] as CompanionView["earlier"],
    todos: [
        { text: "Read the current settings page", status: "completed", at: Now - 45 * Min },
        { text: "Write requirement FR-SET-021", status: "completed", at: Now - 32 * Min },
        { text: "Build the search index", status: "completed", at: Now - 19 * Min },
        { text: "Write the search filter's tests", status: "in_progress", at: Now - 6 * Min },
        { text: "#815 Wire the filter into the page", status: "in_progress", at: Now - 9 * Min },
        { text: "Translate the new labels", status: "pending" },
        { text: "Review and open the pull request", status: "pending" },
    ],
    todosAt: Now - Min,
    subagents,
    pending:
        AgentMode === "waiting"
            ? [
                  {
                      id: "p1",
                      tool: "Bash",
                      args: '{"command":"npm run test -- src/settings/__tests__/search-index.test.ts --reporter=verbose"}',
                  },
              ]
            : undefined,
    topics: [
        {
            text: "Write the filter's tests: case, accents, synonyms, and a hidden option that never shows.",
            files: 4,
            last: Now - 3 * Min,
        },
        {
            text: "Build the index from the labels and the descriptions, in both languages.",
            files: 3,
            last: Now - 22 * Min,
        },
        { text: "Write the search requirement before coding.", files: 1, last: Now - 34 * Min },
        { text: "Redo the settings page: each option says what it changes…", last: Now - 40 * Min },
        { text: "Show me the settings without a description.", last: Now - 55 * Min },
        { text: "List the 1.4.0 tickets that touch the settings.", last: Now - 62 * Min },
    ],
    answers: [
        { index: 1, preview: "" },
        { index: 2, preview: "" },
        { index: 3, preview: "" },
    ],
    latest: {
        index: 3,
        markdown:
            "I built the settings' search index (`search-index.ts`): each option is indexed by its label, its description and its keywords, in both languages.\n\nThe tests cover case, accents and synonyms. The filter still has to be wired into the page.\n\n**What changes for you**\n\n- The search field filters the options as you type.\n- A section without a match folds, its title stays visible.\n- The shortcut puts the cursor in the field.\n- A hidden option never shows in the results.\n\nNext: Olivia wires the filter (#815) while I write the last tests. I will show you the page once both are green.",
    },
    files: [
        { path: "/work/lantern/src/settings/settings-page.tsx", kind: "update", added: 84, removed: 31, edits: 3 },
        { path: "/work/lantern/src/settings/search-index.ts", kind: "add", added: 142, removed: 0, edits: 2 },
        {
            path: "/work/lantern/src/settings/__tests__/search-index.test.ts",
            kind: "add",
            added: 96,
            removed: 0,
            edits: 1,
        },
        { path: "/work/lantern/locales/fr.json", kind: "update", added: 12, removed: 2, edits: 1 },
        { path: "/work/lantern/locales/en.json", kind: "update", added: 12, removed: 2, edits: 1 },
        { path: "/work/lantern/docs/settings.md", kind: "update", added: 18, removed: 4, edits: 1 },
        { path: "/work/lantern/src/settings/legacy-filter.ts", kind: "delete", added: 0, removed: 57, edits: 1 },
        { path: "/tmp/lantern-fixture/seed.json", kind: "add", added: 40, removed: 0, edits: 1 },
        {
            path: "/private/tmp/agent-501/-work-lantern/1f0c2a9e-4b7d-4c1e-9a52-7d3e8f60b1c4/scratchpad/ticket-usage-slim.md",
            kind: "add",
            added: 31,
            removed: 0,
            edits: 1,
        },
        {
            path: "/home/dev/.agent/projects/-work-lantern-settings/memory/settings-search-decisions.md",
            kind: "update",
            added: 6,
            removed: 2,
            edits: 1,
        },
    ],
};

// ?images=1: the messages the companion shows name pasted images.
function withImages(v: CompanionView): CompanionView {
    return {
        ...v,
        session: {
            ...v.session,
            title: "Redo the settings page like [Image #1]: each option says what it changes, and a search filters them as you type.",
        },
        topics: v.topics.map((topic, i) =>
            i === 0
                ? {
                      ...topic,
                      text: "Write the filter's tests, then compare the page with [Image #2] and [Image #3].",
                      at: Now - 3 * Min,
                  }
                : topic
        ),
        latest: {
            ...v.latest,
            at: Now - Min,
            markdown: v.latest.markdown.replace("I built", "As in [Image #2], I built"),
        },
    };
}

const shownView = imagesOn ? withImages(view) : view;

export function CompanionDashboardPreview() {
    const [layout, setLayout] = useState<CompanionLayout>(startLayout);
    const [arranging, setArranging] = useState(query.get("arrange") === "1");
    const arrangeRef = useRef<HTMLButtonElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const none = () => {};
    // The usage reads its words when the language is loaded.
    useT();
    // The blocks are placed after the first paint: the bottom is looked for until it stops moving.
    useEffect(() => {
        const scroller = scrollRef.current;
        if (scroller == null || query.get("scroll") !== "end") {
            return;
        }
        const timer = setInterval(() => {
            scroller.scrollTop = scroller.scrollHeight;
        }, 100);
        return () => clearInterval(timer);
    }, []);
    // ?tip=<test id>: the pointer rests on the element once the blocks are placed, as a screenshot needs it.
    useEffect(() => {
        if (!HeldTip) {
            return;
        }
        let tries = 0;
        const timer = setInterval(() => {
            const element = document.querySelectorAll(`[data-testid="${HeldTip}"]`)[HeldTipAt];
            if (element != null) {
                element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
                clearInterval(timer);
            } else if (++tries > 100) {
                clearInterval(timer);
            }
        }, 150);
        return () => clearInterval(timer);
    }, []);
    return (
        <div className="p-4" data-testid="companion-dashboard-preview">
            <div
                className="flex flex-col overflow-hidden rounded-6 border border-border"
                style={{ width: Width, height: FrameHeight > 0 ? FrameHeight : undefined }}
                data-testid="companion-frame"
            >
                <div
                    ref={scrollRef}
                    className={
                        FrameHeight > 0
                            ? "flex h-full min-h-0 w-full flex-col overflow-y-auto"
                            : "flex min-h-0 w-full flex-col"
                    }
                    data-testid="companion-scroll"
                >
                    <CompanionTips target="preview-terminal" session="s1" loadImage={syntheticImage}>
                        <CompanionDashboard
                            view={shownView}
                            target="preview-terminal"
                            companionId="preview-companion"
                            agentState={agentState}
                            provider=""
                            dir=""
                            folder="/work/lantern"
                            layout={layout}
                            onSaveLayout={setLayout}
                            arranging={arranging}
                            onArrange={() => setArranging(true)}
                            onLeaveArranging={() => setArranging(false)}
                            arrangeRef={arrangeRef}
                            integrationDetails={true}
                            persistentIntegration={false}
                            onIntegration={none}
                            onHistory={none}
                            onBackToCurrent={none}
                            fixtures={{ milestones, holds, usage: gaugesView(usage, Now), task }}
                        />
                    </CompanionTips>
                </div>
            </div>
        </div>
    );
}
