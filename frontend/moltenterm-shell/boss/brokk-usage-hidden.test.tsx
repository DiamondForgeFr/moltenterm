// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));
vi.mock("../companion/companion-task-model", () => ({ agentName: (id: string) => `Agent ${id}` }));

import { UsageHidden, UsageHiddenList } from "./brokk-usage-hidden";
import type { HiddenUsage } from "./brokk-usage-model";

const Now = new Date(2026, 10, 12, 10, 0, 0).getTime();
const Day = 24 * 60 * 60 * 1000;

const unused: HiddenUsage = { provider: "codex", plan: "free", lastUse: Now - 10 * Day, reason: "unused" };
const chosen: HiddenUsage = { provider: "claude", plan: "Max", lastUse: 0, reason: "chosen" };

// FR-BOSS-009, AC95 and AC97 (#2341): the line under the grid and the list it opens. They load on demand, so they are
// rendered here, not through the group.
describe("the providers not used lately", () => {
    it("shows one quiet line with how many wait, closed, and nothing when none does", () => {
        const html = renderToStaticMarkup(<UsageHidden items={[unused, chosen]} now={Now} onChoose={() => {}} />);
        expect(html).toContain('data-testid="brokk-usage-hidden-toggle"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain("Not used lately (2)");
        expect(html).not.toContain('data-testid="brokk-usage-hidden"');
        expect(renderToStaticMarkup(<UsageHidden items={[]} now={Now} onChoose={() => {}} />)).toBe("");
    });

    it("lists each provider with its plan and its last use, or that no use was seen", () => {
        const html = renderToStaticMarkup(<UsageHiddenList items={[unused, chosen]} now={Now} onChoose={() => {}} />);
        const [first, second] = html.split('data-testid="brokk-usage-hidden-item"').slice(1);
        expect(first).toContain('data-provider="codex"');
        expect(first).toContain(">free<");
        expect(first).toContain("Last use 10 d ago");
        expect(second).toContain('data-provider="claude"');
        expect(second).toContain("Hidden by you");
        expect(second).toContain("No use seen");
    });

    it("gives each one buttons, Show automatically only to one the developer hid, each named for its agent", () => {
        const html = renderToStaticMarkup(<UsageHiddenList items={[unused, chosen]} now={Now} onChoose={() => {}} />);
        const [first, second] = html.split('data-testid="brokk-usage-hidden-item"').slice(1);
        expect(first).toContain('aria-label="Always show: Agent codex"');
        expect(first).not.toContain("Show automatically");
        expect(second).toContain('aria-label="Always show: Agent claude"');
        expect(second).toContain('aria-label="Show automatically: Agent claude"');
        expect(second.match(/<button type="button"/g)).toHaveLength(2);
    });
});
