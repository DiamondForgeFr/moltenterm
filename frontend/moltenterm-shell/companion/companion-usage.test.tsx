// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CompanionStatus, CompanionView, usageAction } from "./companion-model";
import { openUsagePage, UsageButton } from "./companion-usage";

const { openLink } = vi.hoisted(() => ({ openLink: vi.fn(async (_url: string) => {}) }));

vi.mock("@/app/store/global", () => ({ openLink }));

// The URLs come from wavesrv's usage adapters (pkg/molten/usage); these stand for what it sends.
const claude: CompanionView = {
    blockid: "b",
    version: 1,
    status: "live",
    agent: "claude",
    agentname: "Claude Code",
    usage: { pageurl: "https://claude.ai/settings/usage", pagename: "Claude usage" },
};
const codex: CompanionView = {
    ...claude,
    agent: "codex",
    agentname: "Codex",
    usage: { pageurl: "https://chatgpt.com/codex/settings/usage", pagename: "Codex usage" },
};

describe("companion usage action", () => {
    it("names the adapter's page", () => {
        expect(usageAction(claude)).toEqual({ url: "https://claude.ai/settings/usage", title: "Open Claude usage" });
        expect(usageAction(codex)).toEqual({
            url: "https://chatgpt.com/codex/settings/usage",
            title: "Open Codex usage",
        });
    });

    it("stays while the agent works, waits, has exited or before its session shows", () => {
        const statuses: CompanionStatus[] = ["live", "loading", "searching", "remote", "unsupportedformat", "error"];
        for (const status of statuses) {
            expect(usageAction({ ...claude, status })).not.toBeNull();
        }
        expect(usageAction({ ...claude, ended: true })).not.toBeNull();
    });

    it("is absent without a usage adapter or an agent", () => {
        expect(usageAction({ ...claude, usage: undefined })).toBeNull();
        expect(usageAction({ ...claude, agent: undefined })).toBeNull();
        expect(usageAction({ ...claude, status: "noagent" })).toBeNull();
        expect(usageAction({ ...claude, status: "unsupportedagent" })).toBeNull();
        expect(
            usageAction({ ...claude, usage: { pageurl: "http://claude.ai/settings/usage", pagename: "x" } })
        ).toBeNull();
        expect(usageAction({ ...claude, usage: { pageurl: "javascript:alert(1)", pagename: "x" } })).toBeNull();
        expect(usageAction(null)).toBeNull();
    });

    it("renders a keyboard-reachable button with the page in its tooltip", () => {
        const html = renderToStaticMarkup(<UsageButton view={claude} />);
        expect(html).toMatch(/^<button type="button"/);
        expect(html).toContain('title="Open Claude usage"');
        expect(html).toContain('aria-label="Open Claude usage"');
        expect(html).toContain("cursor-pointer");
        expect(html).toContain(">Usage<");
        expect(renderToStaticMarkup(<UsageButton view={{ ...claude, usage: undefined }} />)).toBe("");
    });

    it("opens the page through openLink", async () => {
        openLink.mockClear();
        expect(openUsagePage(codex)).toBe(true);
        await Promise.resolve();
        expect(openLink).toHaveBeenCalledExactlyOnceWith("https://chatgpt.com/codex/settings/usage");
        openLink.mockClear();
        expect(openUsagePage({ ...codex, usage: undefined })).toBe(false);
        await Promise.resolve();
        expect(openLink).not.toHaveBeenCalled();
    });
});
