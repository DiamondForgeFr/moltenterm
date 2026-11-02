// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-dom", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-dom")>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import { AgentChoiceDialog, answerAgentChoice, PendingChoice } from "./agent-choice";

beforeAll(() => {
    vi.stubGlobal("document", { body: {} });
});

function pending(extra: Partial<PendingChoice> = {}): PendingChoice {
    return {
        kind: "investigate",
        number: 797,
        branch: "fix/797-ci",
        base: "develop",
        agent: "Claude Code",
        agentid: "claude",
        agents: [
            { id: "claude", name: "Claude Code", installed: true },
            { id: "codex", name: "Codex", installed: true },
        ],
        answer: vi.fn(),
        ...extra,
    };
}

function render(p: PendingChoice): string {
    return renderToStaticMarkup(<AgentChoiceDialog pending={p} />);
}

function optionTags(html: string): string[] {
    return html.match(/<button[^>]*data-option="[^"]*"[^>]*>/g) ?? [];
}

function footerOf(html: string): string {
    return html.slice(html.indexOf("data-dialog-buttons"));
}

function validateTag(html: string): string {
    return /<button[^>]*data-testid="agent-choice-validate"[^>]*>/.exec(html)?.[0] ?? "";
}

describe("the agent choice options (#890, #930)", () => {
    it("shows the two ways as a radio group, the default one checked and the only tab stop", () => {
        const html = render(pending());
        const [background, together] = optionTags(html);
        expect(background).toContain('role="radio"');
        expect(background).toContain('aria-checked="true"');
        expect(background).toContain('data-option="background"');
        expect(background).toContain("data-selected");
        expect(background).toContain('tabindex="0"');
        expect(together).toContain('role="radio"');
        expect(together).toContain('aria-checked="false"');
        expect(together).toContain('data-option="together"');
        expect(together).not.toContain("data-selected");
        expect(together).toContain('tabindex="-1"');
        expect(html).toContain('role="radiogroup" aria-label="How the agent works"');
    });

    it("names each option by its title and describes it by its text", () => {
        const html = render(pending());
        for (const tag of optionTags(html)) {
            const labelled = /aria-labelledby="([^"]+)"/.exec(tag)[1];
            const described = /aria-describedby="([^"]+)"/.exec(tag)[1];
            expect(html).toContain(`id="${labelled}"`);
            expect(html).toContain(`id="${described}"`);
        }
        expect(html).toContain("Let the agent handle it");
        expect(html).toContain("Analyze and resolve with the agent");
    });

    it("puts Cancel and a primary Validate in the footer, never the options", () => {
        const html = render(pending());
        const footer = footerOf(html);
        expect(footer.match(/<button/g)).toHaveLength(2);
        expect(footer).not.toContain("data-option");
        expect(footer.indexOf('data-testid="agent-choice-cancel"')).toBeLessThan(
            footer.indexOf('data-testid="agent-choice-validate"')
        );
        const validate = validateTag(html);
        expect(validate).toContain("molten-btn");
        expect(validate).not.toContain(' disabled=""');
        expect(footer).toMatch(/data-testid="agent-choice-validate"[^>]*>Validate<i class="molten-btn-wave"/);
    });

    it("disables the options and Validate while no agent can start", () => {
        const html = render(pending({ missing: "Gemini", agents: [] }));
        for (const tag of optionTags(html)) {
            expect(tag).toContain("disabled");
        }
        expect(validateTag(html)).toContain(' disabled=""');
    });

    it("answers with the selected mode, and the agent only when the developer switched", () => {
        const p = pending();
        answerAgentChoice(p, null, "together");
        expect(p.answer).toHaveBeenLastCalledWith("together", undefined);
        answerAgentChoice(p, "codex", "background");
        expect(p.answer).toHaveBeenLastCalledWith("background", "codex");
        answerAgentChoice(p, null, null);
        expect(p.answer).toHaveBeenLastCalledWith(null, undefined);
    });

    it("starts nothing while the chosen agent is missing and none was picked", () => {
        const p = pending({ missing: "Gemini" });
        answerAgentChoice(p, null, "background");
        expect(p.answer).not.toHaveBeenCalled();
        answerAgentChoice(p, "codex", "background");
        expect(p.answer).toHaveBeenCalledWith("background", "codex");
    });
});
