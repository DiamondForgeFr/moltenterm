// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The provider marks (#2542, FR-BOSS-009 AC113) on invented data, drawn by the real components: Brokk's usage grid with
// a Claude Code, a Codex and a Kimi Code row, the agent rows of the launcher and the Library's agent cards.
// ?theme=light shows them on the light theme, ?lang=fr in French.

import { I18nModel } from "../../moltenterm-shell/i18n/i18n";
import { AgentCard } from "../../moltenterm-shell/library/agents-section";
import { PaletteRow } from "../../moltenterm-shell/palette/palette-row";
import { agentEntries } from "../../moltenterm-shell/palette/palette-sources";
import { UsageWeekGrid, UsageWeekRow } from "../../moltenterm-shell/usage-week/usage-week";
import { usageWeekLine } from "../../moltenterm-shell/usage-week/usage-week-model";

import "../../moltenterm-shell/library/library.css";
import "../../moltenterm-shell/molten-button.css";
import "../../moltenterm-shell/moltenterm-shell.css";

const Day = 24 * 60 * 60 * 1000;
const Now = new Date(2026, 10, 25, 12).getTime();

const query = new URLSearchParams(globalThis.location?.search);
if (query.get("lang")) {
    I18nModel.getInstance().setLanguageSetting(query.get("lang"));
}
if (query.get("theme") === "light") {
    globalThis.document?.documentElement.classList.add("mt-light", "df-light");
}

function usageRow(agent: string, name: string, percent: number, resetsInDays: number): UsageWeekRow {
    const line = usageWeekLine(
        { id: "week", label: "This week", usedpercent: percent, resetsat: Now + resetsInDays * Day },
        Now
    );
    return { key: agent, agent, name, line, readAt: Now };
}

const UsageRows: UsageWeekRow[] = [
    usageRow("claude", "Claude Code", 73, 2),
    usageRow("codex", "Codex", 31, 4),
    usageRow("kimi", "Kimi Code", 56, 1),
];

// Every agent of the catalogue found on this computer, after the two presets the app ships.
const Installed = [
    ["claude", "Claude Code", "claude"],
    ["codex", "Codex", "codex"],
    ["gemini", "Gemini CLI", "gemini"],
    ["opencode", "OpenCode", "opencode"],
    ["kimi", "Kimi Code", "kimi"],
    ["qwen", "Qwen Code", "qwen"],
    ["cursor", "Cursor CLI", "agent"],
    ["copilot", "GitHub Copilot CLI", "copilot"],
    ["grok", "Grok Build", "grok"],
    ["vibe", "Mistral Vibe", "vibe"],
].map(([id, name, command]) => ({ id, name, command, installed: true }));

const LauncherEntries = agentEntries({}, Installed);

const Cards = [
    ["claude-code", "Claude Code", "claude"],
    ["codex", "Codex", "codex"],
    ["kimi", "Kimi Code", "kimi"],
    ["cursor", "Cursor CLI", "agent"],
].map(([id, name, command]) => ({
    card: {
        id,
        name,
        command,
        ready: true,
        full: true,
        account: "subscriptionOrKey",
        provider: name,
        install: [],
    },
    agent: { id, name },
}));

function Panel({ title, width, children }: { title: string; width: number; children: React.ReactNode }) {
    return (
        <section
            className="flex flex-col gap-2 rounded-md p-3"
            style={{ width, background: "var(--mt-surface-1)", border: "1px solid var(--mt-line-1)" }}
        >
            <h2 className="text-11 font-semibold uppercase text-secondary">{title}</h2>
            {children}
        </section>
    );
}

export default function ProviderMarksPreview() {
    return (
        <div
            className="flex min-h-screen flex-wrap items-start gap-4 p-4"
            style={{ background: "var(--mt-surface-0)" }}
        >
            <Panel title="Brokk's usage grid" width={300}>
                <UsageWeekGrid rows={UsageRows} now={Now} />
            </Panel>
            <Panel title="Launcher: agents found on this computer" width={360}>
                <div>
                    {LauncherEntries.map((entry, i) => (
                        <PaletteRow
                            key={entry.id}
                            entry={entry}
                            index={i}
                            selected={i === 1}
                            query=""
                            onHover={() => {}}
                            onOpen={() => {}}
                        />
                    ))}
                </div>
            </Panel>
            <Panel title="Library: agent cards" width={360}>
                <div className="mt-lib-pcards">
                    {Cards.map((row) => (
                        <AgentCard key={row.card.id} row={row as never} job={undefined} />
                    ))}
                </div>
            </Panel>
        </div>
    );
}
