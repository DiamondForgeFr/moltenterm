// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Uninstall's confirmation and result (#1699): the settings folders go to the trash only when ticked, the box opens
// unticked, and the words say what those folders hold.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OnboardingAgent } from "../../moltenterm-onboarding/onboarding-agent-model";
import type { PourAgentCard } from "../../moltenterm-onboarding/onboarding-pour-agents";
import { AgentCard, InstallBlock, StatusBlock, TrashReport, UninstallBlock, UninstallConfirm } from "./agents-section";

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

describe("the domino loader while an install or uninstall runs (#1712)", () => {
    const Domino = /<span class="df-domino-loader[^"]*"[^>]*>(<span><\/span>)+<\/span>/;
    const Missing: PourAgentCard = {
        ...Card,
        ready: false,
        install: ["curl -fsSL https://claude.ai/install.sh | bash"],
    };
    const Found = {
        id: "claude-code",
        name: "Claude Code",
        found: true,
        uninstall: Uninstall,
    } as unknown as OnboardingAgent;

    it("shows it on the card with Installing or Uninstalling, and the state dot otherwise", () => {
        const installing = renderToStaticMarkup(
            <AgentCard row={{ card: Missing, agent: Found }} job={{ id: "claude-code", state: "running" }} />
        );
        expect(installing).toMatch(new RegExp(`data-state="running">${Domino.source}Installing Claude Code…`));
        const uninstalling = renderToStaticMarkup(
            <AgentCard
                row={{ card: Card, agent: Found }}
                job={{ id: "claude-code", kind: "uninstall", state: "running" }}
            />
        );
        expect(uninstalling).toMatch(new RegExp(`data-state="running">${Domino.source}Uninstalling Claude Code…`));
        const idle = renderToStaticMarkup(<AgentCard row={{ card: Missing, agent: Found }} job={null} />);
        expect(idle).not.toMatch(Domino);
    });

    it("shows it on the page's Install and Uninstall blocks only while they run", () => {
        const running = renderToStaticMarkup(
            <InstallBlock card={Missing} job={{ id: "claude-code", state: "running" }} />
        );
        expect(running).toMatch(new RegExp(`${Domino.source}Installing Claude Code…`));
        expect(renderToStaticMarkup(<InstallBlock card={Missing} job={null} />)).not.toMatch(Domino);
        const uninstalling = renderToStaticMarkup(
            <UninstallBlock
                card={Card}
                agent={Found}
                job={{ id: "claude-code", kind: "uninstall", state: "running" }}
            />
        );
        expect(uninstalling).toMatch(new RegExp(`${Domino.source}Uninstalling Claude Code…`));
        expect(renderToStaticMarkup(<UninstallBlock card={Card} agent={Found} job={null} />)).not.toMatch(Domino);
    });
});

describe("Sign in on the agent's page (#1723)", () => {
    const Found = { id: "claude-code", name: "Claude Code", found: true } as unknown as OnboardingAgent;
    const Unseen: PourAgentCard = {
        ...Card,
        signedIn: false,
        plansPage: "https://claude.com/pricing",
        signIn: { kind: "command", command: "claude auth login", opens: "browser" },
    };

    it("runs the agent's own sign-in, says what will happen, and links the plans apart", () => {
        const html = renderToStaticMarkup(<StatusBlock card={Unseen} agent={Found} />);
        expect(html).toContain("claude auth login</code> in a terminal: Claude Code opens your browser to sign in.");
        expect(html).toContain('data-testid="library-agent-signin-run"');
        expect(html).toContain('href="https://claude.com/pricing"');
        expect(html).toContain("Create an account / see plans");
    });

    it("offers nothing once the sign-in is seen", () => {
        const html = renderToStaticMarkup(<StatusBlock card={{ ...Unseen, signedIn: true }} agent={Found} />);
        expect(html).not.toContain("library-agent-signin");
    });
});
