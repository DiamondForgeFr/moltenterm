// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { collectPanel, hasCapability, matchingProviders } from "./panel-registry";
import { CommandProvider, PanelContext, PanelSectionKind } from "./panel-types";

function ctx(caps: string[]): PanelContext {
    return {
        blockId: "b1",
        view: "term",
        meta: {},
        viewModel: null,
        capabilities: new Set(caps),
        agent: null,
        kindLabel: "terminals",
        panelName: "Terminal",
    };
}

function provider(id: string, kind: PanelSectionKind, extra: Partial<CommandProvider> = {}): CommandProvider {
    return {
        id,
        kind,
        sections: () => [
            {
                id: kind === "developer" ? "developer" : `s:${id}`,
                kind,
                title: id,
                items: [{ id: `i:${id}`, type: "action", label: id, run: () => {} }],
            },
        ],
        ...extra,
    };
}

describe("command panel providers (DS-SHELL-086, FR-SHELL-047 validation rule)", () => {
    // Registered in the wrong order on purpose.
    const providers = [
        provider("dev", "developer"),
        provider("terminal", "widget", { needs: ["terminal"] }),
        provider("wave", "widget", { fallback: true }),
        provider("molten", "molten"),
        provider("claude", "agent", { needs: ["agent:claude-code"] }),
        provider("anyagent", "agent", { needs: ["agent:*"], order: 1 }),
    ];

    it("orders sections by kind, Agent → MoltenTerm → widget → Developer, never by registration", () => {
        const panel = collectPanel(ctx(["terminal", "agent", "agent:claude-code"]), providers);
        expect(panel.sections.map((s) => s.title)).toEqual(["claude", "anyagent", "molten", "terminal", "dev"]);
    });

    it("gives a plain shell no Agent section", () => {
        const panel = collectPanel(ctx(["terminal"]), providers);
        expect(panel.sections.map((s) => s.kind)).toEqual(["molten", "widget", "developer"]);
    });

    it("uses the Wave adapter only when no native widget provider matches", () => {
        expect(matchingProviders(ctx(["terminal"]), providers).map((p) => p.id)).not.toContain("wave");
        expect(matchingProviders(ctx(["view:sysinfo"]), providers).map((p) => p.id)).toContain("wave");
    });

    it("merges sections sharing an id (every provider adds to Developer)", () => {
        const extra = provider("terminal-dev", "widget", {
            sections: () => [
                {
                    id: "developer",
                    kind: "developer",
                    title: "Developer",
                    items: [{ id: "x", type: "info", label: "x" }],
                },
            ],
        });
        const panel = collectPanel(ctx([]), [provider("dev", "developer"), extra]);
        expect(panel.sections).toHaveLength(1);
        expect(panel.sections[0].items.map((i) => i.id)).toEqual(["x", "i:dev"]);
    });

    it("keeps a failing provider from breaking the panel", () => {
        const broken = provider("broken", "molten", {
            sections: () => {
                throw new Error("boom");
            },
        });
        const panel = collectPanel(ctx([]), [broken, provider("dev", "developer")]);
        expect(panel.sections.map((s) => s.title)).toEqual(["dev"]);
    });

    it("keeps at most two suggestions", () => {
        const many = provider("s", "agent", {
            suggestions: () => [1, 2, 3].map((n) => ({ id: `${n}`, label: `${n}`, run: () => {} })),
        });
        expect(collectPanel(ctx([]), [many]).suggestions).toHaveLength(2);
    });

    it("matches agent:* against any agent", () => {
        expect(hasCapability(new Set(["agent:codex"]), "agent:*")).toBe(true);
        expect(hasCapability(new Set(["terminal"]), "agent:*")).toBe(false);
    });
});
