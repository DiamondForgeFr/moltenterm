// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What Sign in decides (FR-ONB-007 AC-5b, #1723), kept apart from the store so the cards render and test without a
// window: the one line saying what will happen, and when the sign-in terminal is over.

import type { AgentSignIn } from "./onboarding-agent-model";

export type SignInRunState = "opening" | "running" | "ended" | "failed";

export type SignInRun = { state: SignInRunState; blockId?: string; error?: string };

// onboarding.pour.agents.signInHow.<kind>, with {name}, {command}, {slash} and {opens}; {opens} is
// onboarding.pour.agents.signInOpens.<opens>.
export function signInHowKey(signIn: AgentSignIn): string {
    return `onboarding.pour.agents.signInHow.${signIn?.kind ?? "firstrun"}`;
}

export function signInOpensKey(signIn: AgentSignIn): string {
    return `onboarding.pour.agents.signInOpens.${signIn?.opens ?? "browser"}`;
}

// The command ended (the controller no longer runs it, once it was seen running) or its panel is gone.
export function signInEnded(seenRunning: boolean, procStatus: string, blockGone: boolean): boolean {
    if (blockGone) {
        return true;
    }
    return seenRunning && procStatus !== "running";
}

export function isSignInActive(run: SignInRun): boolean {
    return run?.state === "opening" || run?.state === "running";
}
