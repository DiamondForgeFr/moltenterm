// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExperimentalRow, PlanUsageBody } from "./companion-gauges";
import {
    CompanionUsageInfo,
    creditsText,
    ExperimentalLabel,
    experimentalStatement,
    experimentalView,
    gaugesView,
} from "./companion-gauges-model";

vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));

const Min = 60 * 1000;
const now = new Date(2026, 9, 6, 10, 0, 0).getTime();
const Store = `the macOS Keychain ("Claude Code-credentials") or ~/.claude/.credentials.json`;

// What wavesrv sends once the experimental source answered (pkg/molten/companion/usage.go).
const withEndpoint: CompanionUsageInfo = {
    blockid: "b1",
    agent: "claude",
    pageurl: "https://claude.ai/settings/usage",
    pagename: "Claude usage",
    hasgauges: true,
    gauges: "enabled",
    sourcename: "Claude Code status line and Anthropic usage endpoint",
    refreshms: 5 * Min,
    experimental: { source: "claude-oauth", name: "Anthropic usage endpoint", on: true, store: Store },
    snapshot: {
        agent: "claude",
        source: "claude-statusline,claude-oauth",
        readat: now - Min,
        windows: [
            { id: "session", label: "Current session", usedpercent: 40, resetsat: now + 2 * 60 * Min },
            { id: "week", label: "This week", usedpercent: 63, resetsat: now + 3 * 24 * 60 * Min },
            { id: "model:opus", label: "This week (Opus)", usedpercent: 12.25, resetsat: now + 3 * 24 * 60 * Min },
        ],
        credits: { enabled: true, used: 12.5, limit: 50, unit: "USD" },
    },
};

const noop = { onShow: () => {}, onHide: () => {}, onRefresh: () => {}, onExperimental: () => {} };

function render(info: CompanionUsageInfo): string {
    return renderToStaticMarkup(
        <PlanUsageBody view={gaugesView(info, now)} experimental={experimentalView(info)} {...noop} />
    );
}

describe("experimental source rules", () => {
    it("is offered only while the gauges are on, off by default", () => {
        expect(experimentalView({ ...withEndpoint, experimental: undefined })).toEqual({ kind: "none" });
        expect(experimentalView({ ...withEndpoint, gauges: "off" })).toEqual({ kind: "none" });
        expect(experimentalView({ ...withEndpoint, hasgauges: false })).toEqual({ kind: "none" });
        const off = experimentalView({ ...withEndpoint, experimental: { ...withEndpoint.experimental, on: false } });
        expect(off).toEqual({ kind: "off", statement: experimentalStatement(Store) });
        expect(experimentalView(withEndpoint)).toEqual({ kind: "on", reason: "" });
    });

    it("says exactly what is read in the confirmation", () => {
        expect(experimentalStatement(Store)).toBe(
            `MoltenTerm will read your Claude Code sign-in token from ${Store} to ask Anthropic for your plan usage. ` +
                "The token stays in memory, is never saved or sent anywhere else. Undocumented: it may stop working."
        );
    });

    it("gives a failure's reason in plain words, and none while the first answer comes", () => {
        const failing = (reason: any) =>
            experimentalView({ ...withEndpoint, experimental: { ...withEndpoint.experimental, reason } });
        expect(failing("ratelimited")).toEqual({
            kind: "on",
            reason: "Anthropic asked to wait: MoltenTerm asks again later",
        });
        expect(failing("signedout").kind === "on" && failing("signedout")).toMatchObject({
            reason: expect.stringContaining("never asks"),
        });
        expect(failing("waiting")).toEqual({ kind: "on", reason: "" });
        expect(failing("somethingnew")).toEqual({ kind: "on", reason: "The source could not be read" });
    });

    it("formats the credits in their currency", () => {
        expect(creditsText({ enabled: true, used: 12.5, limit: 50, unit: "USD" })).toBe(
            "Extra usage: $12.50 of $50.00"
        );
        expect(creditsText({ enabled: true, used: 3, limit: 20, unit: "EUR" })).toBe("Extra usage: €3.00 of €20.00");
        expect(creditsText({ enabled: true, used: 3, limit: 20 })).toBe("Extra usage: 3 of 20");
        expect(creditsText({ enabled: false, used: 3, limit: 20, unit: "USD" })).toBe("");
    });
});

describe("experimental source row", () => {
    it("adds the model window and the credits line, labelled experimental and undocumented", () => {
        const html = render(withEndpoint);
        expect(html).toContain('data-window="model:opus"');
        expect(html).toContain("This week (Opus)");
        expect(html).toContain("Extra usage: $12.50 of $50.00");
        expect(html).toContain("From the Claude Code status line and Anthropic usage endpoint");
        expect(html).toContain('data-testid="companion-plan-usage-experimental" data-state="on"');
        expect(html).toContain(ExperimentalLabel);
        expect(html).toContain("Turn off");
        expect(html).not.toContain("Model limits unavailable");
    });

    it("is off with a one-line explanation and a Turn on that only opens the confirmation", () => {
        const html = render({ ...withEndpoint, experimental: { ...withEndpoint.experimental, on: false } });
        expect(html).toContain('data-state="off"');
        expect(html).toContain("Experimental · undocumented source");
        expect(html).toContain("undocumented Anthropic endpoint");
        expect(html).toContain("Turn on…");
        expect(html).not.toContain("sign-in token");
    });

    it("hides only its own windows on failure, with one muted line", () => {
        const failing: CompanionUsageInfo = {
            ...withEndpoint,
            experimental: { ...withEndpoint.experimental, reason: "denied" },
            snapshot: {
                ...withEndpoint.snapshot,
                windows: withEndpoint.snapshot.windows.slice(0, 2),
                credits: undefined,
            },
        };
        const html = render(failing);
        expect(html).toContain('data-window="session"');
        expect(html).not.toContain("model:opus");
        expect(html).toContain("Model limits unavailable");
        expect(html).toContain("Anthropic refused Claude Code&#x27;s sign-in token");
    });

    it("stays offered in the unavailable and setup states", () => {
        const off = { ...withEndpoint.experimental, on: false };
        expect(
            render({
                ...withEndpoint,
                gauges: "unavailable",
                reason: "waiting",
                snapshot: undefined,
                experimental: off,
            })
        ).toContain('data-testid="companion-plan-usage-experimental"');
        const setup = { source: "claude-statusline", file: "~/.claude/settings.json", language: "json", snippet: "{}" };
        expect(
            render({
                ...withEndpoint,
                gauges: "unavailable",
                reason: "notsetup",
                setup,
                snapshot: undefined,
                experimental: off,
            })
        ).toContain('data-testid="companion-plan-usage-experimental"');
    });

    it("confirms with Turn on as the call to action and Cancel", () => {
        const view = experimentalView({ ...withEndpoint, experimental: { ...withEndpoint.experimental, on: false } });
        const html = renderToStaticMarkup(
            <ExperimentalRow view={view} onSet={() => {}} confirming onConfirming={() => {}} />
        );
        expect(html).toContain('role="group"');
        expect(html).toContain(experimentalStatement(Store).replace(/"/g, "&quot;"));
        expect(html).toMatch(/class="molten-btn[^"]*"[^>]*>Turn on/);
        expect(html).toContain("Cancel");
    });
});
