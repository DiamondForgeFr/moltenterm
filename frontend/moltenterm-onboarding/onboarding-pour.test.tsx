// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pour's stage and scenes, rendered without a window (FR-ONB-007 AC-1 to AC-8, TC-ONB-007).

import { MoltentermMarkPath } from "@/util/moltenterm-identity";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setTestMatrix } from "../moltenterm-shell/agent-info/agent-features-fixture";
import type { OnboardingAgent, OnboardingAgents } from "./onboarding-agent-model";
import { OnboardingPour, PourProps } from "./onboarding-pour";
import { StartScene } from "./onboarding-pour-scenes";

// The interface reads wavesrv's real compatibility matrix (FR-AGC-003).
setTestMatrix();

const noop = () => {};

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
    };
}

const Agents: OnboardingAgents = {
    version: "1.0.0",
    agents: [
        agent("claude-code", "Claude Code", "claude", true),
        agent("codex", "Codex", "codex", true),
        agent("gemini-cli", "Gemini CLI", "gemini", false),
        agent("qwen-code", "Qwen Code", "qwen", false),
        agent("kimi", "Kimi Code", "kimi", false),
    ],
};

function render(props: Partial<PourProps> = {}): string {
    return renderToStaticMarkup(
        <OnboardingPour
            reduced={false}
            busy={false}
            agents={Agents}
            checking={false}
            onRecord={noop}
            onCheckAgain={noop}
            onSkip={noop}
            onStart={noop}
            {...props}
        />
    );
}

describe("OnboardingPour (FR-ONB-007)", () => {
    it("frames the scene: five heat bars, Skip always there, no Back on the first scene", () => {
        const html = render();
        expect(html.match(/data-heat="/g)).toHaveLength(5);
        expect(html).toContain('data-heat="now"');
        expect(html).toContain('data-testid="first-run-skip"');
        expect(html).toContain("Skip, I&#x27;ll explore on my own");
        expect(html).not.toContain('data-testid="first-run-back"');
        expect(html).toMatch(/class="molten-btn [^"]*"[^>]*data-testid="first-run-next"[^>]*>Light the forge/);
        expect(html).toContain("molten-btn-wave");
        expect(html).toContain("data-mt-dark-surface");
    });

    it("pours the real MoltenTerm mark, then the title", () => {
        const html = render();
        expect(html).toContain(`d="${MoltentermMarkPath}"`);
        expect(html).toContain("mt-pour-melt");
        expect(html).toContain("All your AI agents,");
        expect(html).toContain("one workshop.");
        expect(html).toContain("Claude Code, Codex and the others");
        expect(html).toContain('data-testid="first-run-about"');
    });

    it("shows Back from the second scene and the scene's own next label", () => {
        const html = render({ initialScene: 2 });
        expect(html).toContain('data-testid="first-run-back"');
        expect(html).toMatch(/data-testid="first-run-next"[^>]*>And then\?/);
        expect(html.match(/data-heat="done"/g)).toHaveLength(2);
    });

    it("marks reduced motion on the stage, so every scene shows at once", () => {
        expect(render({ reduced: true })).toContain("data-reduced");
        expect(render()).not.toContain("data-reduced");
        const morph = render({ reduced: true, initialScene: 3 });
        expect(morph).toContain("/morph add a Paris · Tokyo clock");
        expect(morph).toContain("data-poured");
    });

    it("lists the agents from the detection, ready or not installed, with the plan recipes to configure", () => {
        const html = render({ initialScene: 1 });
        expect(html).toContain("MoltenTerm found 2 command-line agents on this computer.");
        expect(html).toMatch(/data-agent="claude-code" data-ready=""/);
        expect(html).toMatch(/data-agent="kimi">/);
        expect(html).toContain("$ claude");
        expect(html).toContain("$ kimi");
        expect(html).toContain("Full integration");
        expect(html).toContain("Process detection");
        expect(html).toContain("Kimi subscription");
        expect(html).toContain("Not installed");
        expect(html).toContain('data-testid="pour-act-kimi"');
        // found, its sign-in not seen: the sign-in step (#1680)
        expect(html).toMatch(/data-testid="pour-act-claude-code"[^>]*>Sign in/);
        expect(html).toMatch(/data-testid="pour-act-glm"[^>]*>Configure/);
        expect(html).toMatch(/data-testid="pour-act-minimax"[^>]*>Configure/);
        expect(html).not.toContain('data-testid="pour-act-deepseek"');
        expect(html).toContain('data-testid="pour-codex-hooks"');
        expect(html).toContain("/hooks");
    });

    it("says so while it looks for the agents, and when it could not", () => {
        expect(render({ initialScene: 1, agents: null })).toContain("Looking for the command-line agents");
        const failed = render({ initialScene: 1, agents: null, agentsError: "The agents could not be listed: boom" });
        expect(failed).toContain("The agents could not be listed: boom");
    });

    it("says no agent is found yet, and every card can be installed", () => {
        const none = { version: "", agents: Agents.agents.map((a) => ({ ...a, found: false })) };
        const html = render({ initialScene: 1, agents: none });
        expect(html).toContain("MoltenTerm found no command-line agent on this computer yet.");
        expect(html).not.toContain("data-ready");
        expect(html).toContain('data-testid="pour-act-claude-code"');
    });

    it("draws the workshop as an illustration with a text alternative", () => {
        const html = render({ initialScene: 2 });
        expect(html).toMatch(/class="mt-pour-win"[^>]*aria-hidden="true"/);
        expect(html).toMatch(/class="sr-only">Illustration: the MoltenTerm sidebar/);
        expect(html.match(/data-forged=""/g).length).toBeGreaterThanOrEqual(3);
        expect(html).toContain("A workspace per project");
        expect(html).toContain("<code");
        expect(html).toContain("And other surprises are waiting for you there.");
    });

    it("demonstrates /morph without running anything, and can pour again", () => {
        const html = render({ initialScene: 3 });
        expect(html).toContain('data-testid="pour-replay"');
        expect(html).toContain("molten undo");
        expect(html).toContain("mt-pour-cast");
    });

    it("offers the three starts, Open my project first", () => {
        const html = render({ initialScene: 4 });
        expect(html).toMatch(/aria-pressed="true"[^>]*data-start="project"/);
        expect(html).toMatch(/aria-pressed="false"[^>]*data-start="morph"[^>]*><b[^>]*>Try \/morph/);
        expect(html).toContain('data-start="free"');
        expect(html).toContain("Getting started stays in the Help menu.");
        expect(html).toMatch(/data-testid="first-run-next"[^>]*>Enter the workshop/);
        expect(render({ initialScene: 4, busy: true })).toContain("Opening your workshop…");
    });

    it("shows Try /morph's request to paste before it opens the agent, or says to install one", () => {
        const withAgent = renderToStaticMarkup(
            <StartScene
                markPath={MoltentermMarkPath}
                start="morph"
                morphAgentName="Claude Code"
                morphRequest="/morph add a command"
                onChoose={noop}
            />
        );
        expect(withAgent).toContain("Claude Code opens in a scratch folder.");
        expect(withAgent).toContain("/morph add a command");
        const without = renderToStaticMarkup(
            <StartScene markPath={MoltentermMarkPath} start="morph" onChoose={noop} />
        );
        expect(without).toContain('data-testid="pour-morph-noagent"');
        const project = renderToStaticMarkup(
            <StartScene markPath={MoltentermMarkPath} start="project" onChoose={noop} />
        );
        expect(project).not.toContain("pour-morph-");
    });

    it("shows a failure above the buttons", () => {
        expect(render({ error: "Could not start" })).toMatch(/role="alert"[^>]*>Could not start/);
    });
});
