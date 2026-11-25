// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The logo that starts a usage row is the provider's own mark (#2542, FR-BOSS-009 AC113): each agent of the set draws
// its mark, an agent without one (Kimi Code) or an unknown one keeps the AI icon, and the name popover, the keyboard
// button of a row with a menu and the row's accessible name stay what they were.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiIcon } from "../ai-icon";
import { ProviderMarks } from "../provider-marks/provider-marks";
import { UsageWeekGrid, UsageWeekRow } from "./usage-week";
import { usageWeekLine } from "./usage-week-model";

vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));

const now = new Date(2026, 10, 12, 10, 0, 0).getTime();

function row(agent: string, name: string, extra: Partial<UsageWeekRow> = {}): UsageWeekRow {
    const line = usageWeekLine({ id: "week", label: "This week", usedpercent: 40, resetsat: now + 86400000 }, now);
    return { key: agent, agent, name, line, readAt: now, ...extra };
}

const html = (rows: UsageWeekRow[]) => renderToStaticMarkup(<UsageWeekGrid rows={rows} now={now} />);
const logos = (markup: string) =>
    [...markup.matchAll(/<(span|button) [^>]*data-testid="usage-week-logo"[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => ({
        tag: m[0].slice(0, m[0].indexOf(">") + 1),
        inner: m[2],
    }));

describe("each agent's row starts with its provider's mark", () => {
    const agents: [string, string][] = [
        ["claude", "Claude Code"],
        ["codex", "Codex"],
        ["opencode", "OpenCode"],
        ["cursor", "Cursor CLI"],
    ];

    it("draws the mark of every agent that has one, with the same slot", () => {
        const found = logos(html(agents.map(([agent, name]) => row(agent, name))));
        expect(found).toHaveLength(agents.length);
        found.forEach((logo, i) => {
            const [agent] = agents[i];
            expect(logo.tag).toContain(`data-logo="${agent}"`);
            expect(logo.inner).toContain(`data-mark="${agent}"`);
            expect(logo.inner).toContain("<img ");
            expect(logo.inner).not.toContain(AiIcon);
            expect(logo.inner).toMatch(/style="width:17px;height:17px"/);
        });
    });

    it("keeps the AI icon for Kimi Code, whose terms do not allow its mark, and for an unknown agent", () => {
        const found = logos(html([row("kimi", "Kimi Code"), row("my-agent", "My agent")]));
        expect(found).toHaveLength(2);
        for (const logo of found) {
            expect(logo.tag).toContain('data-logo="ai"');
            expect(logo.inner).toContain(AiIcon);
            expect(logo.inner).not.toContain("<img ");
        }
    });

    it("draws a mark with a dark and a light variant twice, one for each theme", () => {
        const [codex] = logos(html([row("codex", "Codex")]));
        expect(codex.inner.match(/<img /g)).toHaveLength(2);
        expect(codex.inner).toContain('data-tone="on-dark"');
        expect(codex.inner).toContain('data-tone="on-light"');
        expect(ProviderMarks.codex.onDark).not.toBe(ProviderMarks.codex.onLight);
        const [claude] = logos(html([row("claude", "Claude Code")]));
        expect(claude.inner.match(/<img /g)).toHaveLength(1);
    });

    it("keeps the agent's name as the logo's popover text, and never as the mark's own text", () => {
        const [codex] = logos(html([row("codex", "Codex")]));
        expect(codex.tag).toContain('data-name="Codex"');
        expect(codex.inner).toContain('alt=""');
        expect(codex.inner).toContain('aria-hidden="true"');
    });

    it("keeps the keyboard button of a row with a menu, mark inside", () => {
        const [codex] = logos(html([row("codex", "Codex", { onContextMenu: () => {} })]));
        expect(codex.tag).toMatch(/^<button /);
        expect(codex.tag).toContain('type="button"');
        expect(codex.tag).toContain('aria-haspopup="menu"');
        expect(codex.tag).toContain('aria-label="Show or hide Codex"');
        expect(codex.inner).toContain('data-mark="codex"');
    });

    it("keeps the row's accessible name", () => {
        const markup = html([row("codex", "Codex")]);
        expect(markup).toContain('aria-label="Codex, 40 %');
    });
});
