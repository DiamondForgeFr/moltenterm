// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Sign in runs the agent's own sign-in in a terminal panel, the plans page apart (FR-ONB-007 AC-5b, #1723).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentSignIn, OnboardingAgent, OnboardingAgents } from "./onboarding-agent-model";
import { needsSignIn, pourAgentCards } from "./onboarding-pour-agents";
import { AgentsScene } from "./onboarding-pour-scenes";
import { isSignInActive, signInEnded, signInHowKey, signInOpensKey, type SignInRun } from "./onboarding-signin-model";

const noop = () => {};

function agent(id: string, name: string, executable: string, signin: AgentSignIn): OnboardingAgent {
    return {
        id,
        name,
        executable,
        found: true,
        path: "",
        invocation: "/morph <request>",
        format: "skill",
        installed: true,
        guides: [],
        planspage: `https://example.invalid/${id}/plans`,
        signin,
    };
}

const List: OnboardingAgents = {
    version: "1.0.0",
    agents: [
        agent("codex", "Codex", "codex", { kind: "command", command: "codex login", opens: "browser" }),
        agent("kimi", "Kimi Code", "kimi", { kind: "slash", command: "kimi", slash: "/login", opens: "device" }),
        agent("antigravity", "Antigravity CLI", "agy", { kind: "firstrun", command: "agy", opens: "browser" }),
    ],
};

function scene(open: string, signIns: Record<string, SignInRun> = {}): string {
    return renderToStaticMarkup(
        <AgentsScene
            cards={pourAgentCards(List)}
            loading={false}
            checking={false}
            open={open}
            signIns={signIns}
            onToggle={noop}
            onCheck={noop}
            onSignIn={noop}
        />
    );
}

describe("the sign-in line", () => {
    it("names the kind and what the sign-in does", () => {
        expect(signInHowKey(List.agents[0].signin)).toBe("onboarding.pour.agents.signInHow.command");
        expect(signInOpensKey(List.agents[1].signin)).toBe("onboarding.pour.agents.signInOpens.device");
    });

    it("ends when the command stops after it ran, or when the panel is gone", () => {
        expect(signInEnded(false, null, false)).toBe(false);
        expect(signInEnded(true, "running", false)).toBe(false);
        expect(signInEnded(true, "done", false)).toBe(true);
        expect(signInEnded(false, null, true)).toBe(true);
        expect(isSignInActive({ state: "running" })).toBe(true);
        expect(isSignInActive({ state: "ended" })).toBe(false);
    });
});

describe("Sign in on the first launch's card", () => {
    it("is the card's action for an agent found whose sign-in was not seen", () => {
        const html = scene(null);
        expect(html).toMatch(/data-testid="pour-act-codex"[^>]*>Sign in</);
        expect(needsSignIn(pourAgentCards(List)[0])).toBe(true);
    });

    it("says what will happen, offers Sign in, Check again and the plans page apart", () => {
        const html = scene("codex");
        expect(html).toContain('data-testid="pour-signin-how"');
        expect(html).toContain("MoltenTerm runs <code");
        expect(html).toContain("codex login</code> in a terminal: Codex opens your browser to sign in.");
        expect(html).toContain('data-testid="pour-signin-run"');
        expect(html).toContain('data-testid="pour-signin-check"');
        expect(html).toContain('href="https://example.invalid/codex/plans"');
        expect(html).toContain("Create an account / see plans");
        expect(html).not.toContain("download");
    });

    it("tells which command to type when the sign-in happens inside the agent", () => {
        const html = scene("kimi");
        expect(html).toContain("MoltenTerm starts Kimi Code in a terminal: type <code");
        expect(html).toContain("/login</code>, then it shows a code to enter in your browser.");
        expect(scene("antigravity")).toContain("on its first start it opens your browser to sign in.");
    });

    it("follows the terminal: no second Sign in while it runs, and what to do once it ended", () => {
        const running = scene("codex", { codex: { state: "running", blockId: "b1" } });
        expect(running).toContain("Finish the sign-in in the terminal");
        expect(running).not.toContain('data-testid="pour-signin-run"');
        const ended = scene("codex", { codex: { state: "ended", blockId: "b1" } });
        expect(ended).toContain("Not signed in yet?");
        expect(ended).toContain('data-testid="pour-signin-run"');
        expect(scene("codex", { codex: { state: "failed", error: "boom" } })).toContain(
            "The terminal did not open: boom"
        );
    });
});
