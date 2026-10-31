// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Install on a card of the pour runs the catalog's command and follows it (FR-ONB-007 AC-5, #1667).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OnboardingAgent, OnboardingAgents } from "./onboarding-agent-model";
import {
    CliInstallStatus,
    cleanInstallOutput,
    installPhase,
    isSecretQuestion,
    lastLine,
} from "./onboarding-install-model";
import { pourAgentCards } from "./onboarding-pour-agents";
import { AgentsScene } from "./onboarding-pour-scenes";

const noop = () => {};
const KimiCommand = "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash";

function agent(id: string, name: string, executable: string, found: boolean): OnboardingAgent {
    return {
        id,
        name,
        executable,
        found,
        path: "",
        invocation: "/morph <request>",
        format: "skill",
        installed: found,
        guides: [],
        installpage: `https://example.invalid/${id}`,
        installcommands: id === "kimi" ? [KimiCommand] : [`install ${id}`],
    };
}

function list(kimiFound: boolean): OnboardingAgents {
    return {
        version: "1.0.0",
        agents: [agent("claude-code", "Claude Code", "claude", true), agent("kimi", "Kimi Code", "kimi", kimiFound)],
    };
}

function scene(install: CliInstallStatus, kimiFound = false, open = "kimi"): string {
    return renderToStaticMarkup(
        <AgentsScene
            cards={pourAgentCards(list(kimiFound))}
            loading={false}
            checking={false}
            open={open}
            installs={install ? { kimi: install } : {}}
            onToggle={noop}
            onCheck={noop}
        />
    );
}

describe("the install's output", () => {
    it("drops colours and keeps a redrawn line's last state", () => {
        const raw = "\x1b[1;32mDownloading\x1b[0m\r\n 10%\r 55%\r100%\r\n\x1b]0;title\x07done\n";
        expect(cleanInstallOutput(raw)).toBe("Downloading\n100%\ndone\n");
    });

    it("finds the question the installer waits on, hidden when it is a password", () => {
        expect(lastLine("Fetching…\nContinue? [y/N] ")).toBe("Continue? [y/N]");
        expect(isSecretQuestion("Password: ")).toBe(true);
        expect(isSecretQuestion("[sudo] password for dev: ")).toBe(true);
        expect(isSecretQuestion("Continue? [y/N] ")).toBe(false);
    });

    it("tells running, ready and the ways it did not work apart", () => {
        expect(installPhase(null, false)).toBe("idle");
        expect(installPhase({ id: "kimi", state: "running" }, false)).toBe("running");
        expect(installPhase({ id: "kimi", state: "succeeded" }, true)).toBe("ready");
        expect(installPhase({ id: "kimi", state: "succeeded" }, false)).toBe("notfound");
        expect(installPhase({ id: "kimi", state: "failed", exitcode: 1 }, false)).toBe("failed");
        expect(installPhase({ id: "kimi", state: "canceled" }, false)).toBe("canceled");
    });
});

describe("Install on a card (FR-ONB-007 AC-5)", () => {
    it("says what Install runs before it runs: the catalog's command, to copy too", () => {
        const html = scene(null);
        expect(html).toContain("MoltenTerm runs this official command in your shell.");
        expect(html).toContain(KimiCommand);
        expect(html).not.toContain("Nothing runs from here");
        expect(html).toMatch(/data-testid="pour-act-kimi"[^>]*>Install</);
    });

    it("shows a loader with the command, Show details and Cancel while it runs", () => {
        const html = scene({ id: "kimi", state: "running", command: KimiCommand, output: "Downloading\n" });
        expect(html).toContain("Installing Kimi Code…");
        expect(html).toContain("fa-spinner");
        expect(html).toContain('data-installing=""');
        expect(html).toContain(KimiCommand);
        expect(html).toContain('data-testid="pour-details-kimi"');
        expect(html).toContain('data-testid="pour-cancel-kimi"');
        expect(html).not.toContain('data-testid="pour-output-kimi"');
        expect(html).not.toContain('data-testid="pour-check-again"');
    });

    it("opens the output with a field when the installer asks a question", () => {
        const html = scene({ id: "kimi", state: "running", output: "Password: ", waiting: true });
        expect(html).toContain('data-testid="pour-output-kimi"');
        expect(html).toContain("The installer is asking a question.");
        expect(html).toMatch(/<input[^>]*type="password"/);
    });

    it("says it did not work, with the output, the command to copy and the install page", () => {
        const html = scene({ id: "kimi", state: "failed", exitcode: 7, output: "curl: (7) Failed to connect\n" });
        expect(html).toContain("Kimi Code did not install");
        expect(html).toContain("it stopped with code 7");
        expect(html).toContain("curl: (7) Failed to connect");
        expect(html).toContain('data-testid="pour-command-kimi"');
        expect(html).toContain("Install page ↗");
        expect(html).toContain('data-testid="pour-retry-kimi"');
        expect(html).toContain('data-testid="pour-check-again"');
        expect(html).toContain('role="alert"');
    });

    it("says so when the command ended but the agent is still not found", () => {
        const html = scene({ id: "kimi", state: "succeeded", output: "installed\n" });
        expect(html).toContain("MoltenTerm cannot find kimi on this computer yet");
        expect(html).toContain("installed");
    });

    it("turns the card Ready once the check finds it, and closes the install", () => {
        const html = scene({ id: "kimi", state: "succeeded" }, true);
        expect(html).toMatch(/data-agent="kimi" data-ready=""/);
        expect(html).not.toContain('data-testid="pour-drawer-kimi"');
    });

    it("says a cancel stopped the command, and Install can run again", () => {
        const html = scene({ id: "kimi", state: "canceled" });
        expect(html).toContain("Install canceled");
        expect(html).toContain('data-testid="pour-retry-kimi"');
    });

    it("shows a start refusal from wavesrv, with the command to copy", () => {
        const html = scene({
            id: "kimi",
            state: "failed",
            error: "Installing Kimi Code from MoltenTerm is not available",
        });
        expect(html).toContain("Installing Kimi Code from MoltenTerm is not available");
        expect(html).toContain(KimiCommand);
    });
});
