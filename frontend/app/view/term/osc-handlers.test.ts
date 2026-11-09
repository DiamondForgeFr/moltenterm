import { describe, expect, it } from "vitest";

import { isClaudeCodeCommand, osc52WriteAllowed } from "./osc-handlers";

// MOLTENTERM-PATCH (#2121): OSC 52 writes the clipboard only from the focused terminal unless "always" is chosen.
describe("osc52WriteAllowed", () => {
    it("refuses a terminal that is not focused when the setting is unset or focus", () => {
        for (const mode of [undefined, null, "", "focus"]) {
            expect(osc52WriteAllowed(mode, false, true)).toBe(false);
            expect(osc52WriteAllowed(mode, true, false)).toBe(false);
            expect(osc52WriteAllowed(mode, true, true)).toBe(true);
        }
    });

    it("lets any terminal write when always is chosen", () => {
        expect(osc52WriteAllowed("always", false, false)).toBe(true);
    });
});

describe("isClaudeCodeCommand", () => {
    it("matches direct Claude Code invocations", () => {
        expect(isClaudeCodeCommand("claude")).toBe(true);
        expect(isClaudeCodeCommand("claude --dangerously-skip-permissions")).toBe(true);
    });

    it("matches Claude Code invocations wrapped with env assignments", () => {
        expect(isClaudeCodeCommand('ANTHROPIC_API_KEY="test" claude')).toBe(true);
        expect(isClaudeCodeCommand("env FOO=bar claude --print")).toBe(true);
    });

    it("ignores other commands", () => {
        expect(isClaudeCodeCommand("claudes")).toBe(false);
        expect(isClaudeCodeCommand("echo claude")).toBe(false);
        expect(isClaudeCodeCommand("ls ~/claude")).toBe(false);
        expect(isClaudeCodeCommand("cat /logs/claude")).toBe(false);
        expect(isClaudeCodeCommand("")).toBe(false);
    });
});
