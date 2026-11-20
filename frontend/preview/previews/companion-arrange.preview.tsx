// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The agent companion's arrangement (#2395, FR-SHELL-018) on invented data: the arranging mode and a custom layout,
// each in a frame as wide as a wide and as a narrow companion. The frames hold the real session bar, work area,
// arranging mode and sections; the answer, the plan usage and the workspace task are small stand-ins.

import type { AgentStateInfo } from "../../moltenterm-shell/agent-state-model";
import { CompanionArrange } from "../../moltenterm-shell/companion/companion-arrange";
import { FilesSection } from "../../moltenterm-shell/companion/companion-files";
import {
    CompanionLayout,
    DefaultCompanionLayout,
    SectionPlacement,
} from "../../moltenterm-shell/companion/companion-layout";
import { MilestonesView } from "../../moltenterm-shell/companion/companion-milestone-model";
import { CompanionSubagent, CompanionView } from "../../moltenterm-shell/companion/companion-model";
import { RecentTopicsSection } from "../../moltenterm-shell/companion/companion-recap";
import { SectionTitle, SessionSections } from "../../moltenterm-shell/companion/companion-section";
import { SessionBar } from "../../moltenterm-shell/companion/companion-session-ui";
import { CompanionWork } from "../../moltenterm-shell/companion/companion-work";
import { I18nModel } from "../../moltenterm-shell/i18n/i18n";

import "../../moltenterm-shell/molten-button.css";
import "../../moltenterm-shell/moltenterm-shell.css";

const Min = 60 * 1000;
const Now = Date.now();

// ?lang=fr shows the frames in French.
const language = new URLSearchParams(globalThis.location?.search).get("lang");
if (language) {
    I18nModel.getInstance().setLanguageSetting(language);
}

const agentState: AgentStateInfo = {
    blockid: "preview-terminal",
    agent: "claude",
    agentname: "Claude Code",
    state: "working",
    version: 1,
};

const subagents: CompanionSubagent[] = [
    {
        id: "a",
        description: "Build the receipt e-mail",
        branch: "feature/38-receipt-language",
        background: true,
        state: "running",
        started: Now - 4 * Min,
    },
    {
        id: "b",
        description: "#41 fix the checkout total",
        background: true,
        state: "running",
        started: Now - 3 * Min,
    },
    { id: "d", description: "Review the docs", background: true, state: "running", started: Now - 1 * Min },
];

const view: CompanionView = {
    blockid: "preview-terminal",
    version: 1,
    status: "live",
    agent: "claude",
    agentname: "Claude Code",
    session: { path: "/s.jsonl", linkedby: "hook", branch: "develop", title: "Prepare the shop's 2.4 release" },
    todos: [
        { text: "Collect the merged PRs", status: "completed" },
        { text: "Review the docs", status: "in_progress" },
        { text: "Write the release notes", status: "pending" },
    ],
    subagents,
    files: [
        { path: "src/checkout/total.ts", kind: "update", added: 12, removed: 3, edits: 2, at: Now - 2 * Min },
        { path: "docs/releases/2.4.md", kind: "add", added: 40, removed: 0, edits: 1, at: Now - 1 * Min },
    ],
};

const milestones: MilestonesView = {
    dir: "/shop",
    state: "ok",
    milestones: [
        {
            number: 2,
            title: "2.4.0",
            url: "https://github.com/example/shop/milestone/2",
            open: 6,
            closed: 12,
            due: Now + 3 * 24 * 60 * Min,
            remaining: 6,
            loaded: true,
            tickets: [41, 38, 35, 33].map((number) => ({
                number,
                title: `Ticket ${number} title`,
                url: `https://github.com/example/shop/issues/${number}`,
            })),
        },
    ],
};

// An arrangement worth showing: the work band first, the changed files lifted under it, the answer and the workspace
// task side by side, the topics and the plan usage put away.
const Custom: CompanionLayout = [
    { id: "tasks", column: "left" },
    { id: "agents", column: "right" },
    { id: "files", column: "full" },
    { id: "answer", column: "left" },
    { id: "task", column: "right" },
    { id: "permission", column: "full" },
    { id: "topics", column: "full", hidden: true },
    { id: "usage", column: "full", hidden: true },
] satisfies SectionPlacement[];

function Stand({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section data-testid={`companion-${title.toLowerCase().replace(/\s+/g, "-")}`}>
            <SectionTitle>{title}</SectionTitle>
            <div className="px-3 text-12 text-secondary">{children}</div>
        </section>
    );
}

function Sections({ layout }: { layout: CompanionLayout }) {
    const slots = {
        usage: <Stand title="Plan usage">Session 38 % · Week 12 %</Stand>,
        topics: <RecentTopicsSection view={view} now={Now} />,
        answer: <Stand title="Answer">The release notes for 2.4 are drafted; the checkout total now shows once.</Stand>,
        task: <Stand title="Workspace task">Goal: ship 2.4 · Plan 1 / 3 · Next: review the docs</Stand>,
        files: (
            <FilesSection target="preview-terminal" companionId="preview-companion" files={view.files} folder="/shop" />
        ),
    };
    return (
        <SessionSections
            slots={slots}
            layout={layout}
            columns={(band) => (
                <CompanionWork
                    view={view}
                    agentState={agentState}
                    dir=""
                    now={Now}
                    band={band}
                    slots={slots}
                    milestones={milestones}
                />
            )}
        />
    );
}

function Frame({ name, width, children }: { name: string; width: number; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1">
            <div className="text-11 text-muted">{name}</div>
            <div
                className="flex flex-col overflow-hidden rounded-6 border border-border bg-surface-1"
                style={{ width }}
                data-testid={`companion-frame-${name}`}
            >
                <SessionBar view={view} name="Claude Code" onHistory={() => {}} onArrange={() => {}} />
                {children}
            </div>
        </div>
    );
}

export function CompanionArrangePreview() {
    return (
        <div className="flex flex-col gap-6 p-4" data-testid="companion-arrange-preview">
            <Frame name="arrange-wide" width={760}>
                <CompanionArrange layout={Custom} onSave={() => {}} onDone={() => {}} />
            </Frame>
            <Frame name="arrange-narrow" width={360}>
                <CompanionArrange layout={Custom} onSave={() => {}} onDone={() => {}} />
            </Frame>
            <Frame name="custom-wide" width={760}>
                <Sections layout={Custom} />
            </Frame>
            <Frame name="custom-narrow" width={360}>
                <Sections layout={Custom} />
            </Frame>
            <Frame name="default-wide" width={760}>
                <Sections layout={DefaultCompanionLayout} />
            </Frame>
        </div>
    );
}
