// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Uninstall's confirmation and result (#1699): the settings folders go to the trash only when ticked, the box opens
// unticked, and the words say what those folders hold.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PourAgentCard } from "../../moltenterm-onboarding/onboarding-pour-agents";
import { TrashReport, UninstallConfirm } from "./agents-section";

const Card: PourAgentCard = {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    ready: true,
    full: true,
    account: "subscriptionOrKey",
    provider: "Claude",
    install: [],
};

const Uninstall = {
    method: "native",
    command: "rm -f ~/.local/bin/claude && rm -rf ~/.local/share/claude",
    documented: true,
    removes: ["~/.local/bin/claude", "~/.local/share/claude"],
    config: ["~/.claude", "~/.claude.json"],
    configholdskey: "library.agents.uninstall.holds.claude-code",
    available: true,
};

describe("uninstall confirmation", () => {
    it("opens unticked, names the program's files, and says what the settings hold and that they go to the trash", () => {
        const html = renderToStaticMarkup(<UninstallConfirm card={Card} uninstall={Uninstall} onCancel={() => {}} />);
        expect(html).toContain('data-testid="library-agent-uninstall-config"');
        expect(html).not.toMatch(/data-testid="library-agent-uninstall-config"[^>]*checked/);
        expect(html).not.toMatch(/checked=""[^>]*data-testid="library-agent-uninstall-config"/);
        expect(html).toContain("~/.local/share/claude");
        expect(html).not.toContain('data-testid="library-agent-uninstall-trash"');
        expect(html).toContain("conversation history");
        expect(html).toContain("project memories");
        expect(html).toContain("to the trash");
    });

    it("reports what went to the trash, and where it stopped", () => {
        const done = renderToStaticMarkup(
            <TrashReport job={{ id: "claude-code", kind: "uninstall", state: "succeeded", trashed: ["~/.claude"] }} />
        );
        expect(done).toContain("Moved to the trash: ~/.claude");
        const stopped = renderToStaticMarkup(
            <TrashReport
                job={{
                    id: "claude-code",
                    kind: "uninstall",
                    state: "succeeded",
                    trashed: ["~/.claude"],
                    trashfailed: "~/.claude.json",
                    trasherrortext: {
                        code: "onboarding.trashFailed",
                        vars: { path: "~/.claude.json", detail: "permission denied" },
                    },
                }}
            />
        );
        expect(stopped).toContain("~/.claude.json could not be moved to the trash");
        expect(stopped).toContain("left the rest as it was");
        expect(renderToStaticMarkup(<TrashReport job={{ id: "x", state: "succeeded" }} />)).toBe("");
    });
});
