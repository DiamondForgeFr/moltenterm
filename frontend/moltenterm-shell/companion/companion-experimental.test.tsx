// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExperimentalRow, PlanUsageBody } from "./companion-gauges";
import {
    CompanionUsageInfo,
    creditsText,
    experimentalLabel,
    experimentalStatement,
    experimentalView,
    gaugesView,
} from "./companion-gauges-model";

vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));

const Min = 60 * 1000;
const now = new Date(2026, 9, 6, 10, 0, 0).getTime();
const Endpoint = "Anthropic usage endpoint";
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
    experimental: { source: "claude-oauth", name: Endpoint, on: true, store: Store },
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
        expect(off).toMatchObject({ kind: "off", statement: experimentalStatement(Store, Endpoint) });
        expect(experimentalView(withEndpoint)).toMatchObject({ kind: "on", reason: "" });
    });

    it("says exactly what is read in the confirmation", () => {
        expect(experimentalStatement(Store, Endpoint)).toBe(
            `MoltenTerm will read the agent's sign-in token from ${Store} to get your plan usage (source: ${Endpoint}). ` +
                "The token stays in memory, is never saved or sent anywhere else. Undocumented: it may stop working."
        );
        expect(experimentalStatement("", "")).toBe(
            "MoltenTerm will read the agent's sign-in token from where the agent keeps it to get your plan usage " +
                "(source: the provider's usage endpoint). The token stays in memory, is never saved or sent anywhere else. " +
                "Undocumented: it may stop working."
        );
    });

    it("gives a failure's reason in plain words, and none while the first answer comes", () => {
        const failing = (reason: any) =>
            experimentalView({ ...withEndpoint, experimental: { ...withEndpoint.experimental, reason } });
        expect(failing("ratelimited")).toMatchObject({
            kind: "on",
            reason: "The provider asked to wait: MoltenTerm asks again later",
        });
        expect(failing("signedout").kind === "on" && failing("signedout")).toMatchObject({
            reason: expect.stringContaining("never asks"),
        });
        expect(failing("waiting")).toMatchObject({ kind: "on", reason: "" });
        expect(failing("somethingnew")).toMatchObject({ kind: "on", reason: "The source could not be read" });
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
        expect(html).toContain(experimentalLabel());
        expect(html).toContain("Turn off");
        expect(html).not.toContain("Model limits unavailable");
    });

    it("is off with a one-line explanation and a Turn on that only opens the confirmation", () => {
        const html = render({ ...withEndpoint, experimental: { ...withEndpoint.experimental, on: false } });
        expect(html).toContain('data-state="off"');
        expect(html).toContain("Experimental · undocumented source");
        expect(html).toContain("undocumented endpoint of the provider");
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
        expect(html).toContain('data-window="week"');
        expect(html).toContain('data-testid="usage-week-session"');
        expect(html).not.toContain("model:opus");
        expect(html).toContain("Model limits unavailable");
        expect(html).toContain("The provider refused the agent&#x27;s sign-in token");
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
        expect(html).toContain(experimentalStatement(Store, Endpoint).replace(/"/g, "&quot;").replace(/'/g, "&#x27;"));
        expect(html).toMatch(/class="molten-btn[^"]*"[^>]*>Turn on/);
        expect(html).toContain("Cancel");
    });
});

describe("Kimi managed usage", () => {
    const store = "~/.kimi-code/credentials/kimi-code.json";
    const info: CompanionUsageInfo = {
        ...withEndpoint,
        agent: "kimi",
        sourcename: "Kimi Code managed usage endpoint",
        experimental: { source: "kimi-oauth", name: "Kimi Code managed usage endpoint", on: true, store },
        snapshot: {
            agent: "kimi",
            source: "kimi-oauth",
            readat: now,
            windows: [],
            credits: {
                enabled: true,
                used: 0,
                limit: 0,
                balance: "0.00",
                unit: "USD",
                monthly: { used: 0, limit: 0, limitenabled: false, unit: "USD" },
            },
        },
    };

    it("discloses every credential, transport, persistence and eligibility boundary", () => {
        const statement = experimentalStatement(store, "Kimi Code managed usage endpoint", "kimi-oauth");
        for (const text of [
            "only access_token and expires_at",
            store,
            "official managed-usage endpoint of the configured .com or .ai region",
            "never refreshes or writes credentials",
            "persists the token",
            "logs, RPC, or storage",
            "shared or environment-scoped credential",
            "keyring, custom providers, arbitrary hosts, and API keys",
            "official Kimi Code 2.6.3",
        ]) {
            expect(statement).toContain(text);
        }
        const off = experimentalView({ ...info, experimental: { ...info.experimental, on: false } });
        expect(off).toMatchObject({ kind: "off", source: "kimi-oauth", statement });
        const html = renderToStaticMarkup(
            <ExperimentalRow view={off} onSet={() => {}} confirming onConfirming={() => {}} />
        );
        expect(html).toContain("Managed limits, booster, and monthly spending");
        expect(html).toContain("access_token");
    });

    it("uses Kimi labels and availability reasons", () => {
        expect(
            experimentalView({ ...info, experimental: { ...info.experimental, reason: "unsupported" } })
        ).toMatchObject({
            kind: "on",
            label: "Managed limits, booster, and monthly spending",
            unavailable: "Managed usage unavailable",
            reason: expect.stringContaining("Only Kimi Code's official .com or .ai"),
        });
    });

    it("renders zero booster balance and unlimited zero monthly spending together", () => {
        expect(creditsText(info.snapshot.credits)).toBe("Booster balance: $0.00 · Monthly spending: $0.00 · Unlimited");
        expect(render(info)).toContain("Booster balance: $0.00");
        expect(render(info)).toContain("Monthly spending: $0.00");
    });

    it("renders limited monthly spending without changing Claude or Codex formatting", () => {
        const credits = {
            ...info.snapshot.credits,
            balance: "12.35",
            monthly: { used: 5.43, limit: 20, limitenabled: true, unit: "USD" },
        };
        expect(creditsText(credits)).toBe("Booster balance: $12.35 · Monthly spending: $5.43 of $20.00");
        expect(creditsText(withEndpoint.snapshot.credits)).toBe("Extra usage: $12.50 of $50.00");
    });
});
