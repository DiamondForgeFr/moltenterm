// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot } from "react-dom/client";
import { OnboardingPour } from "../../frontend/moltenterm-onboarding/onboarding-pour";
import { choices, measure } from "./contrast-measure";
import { Fixture, FoundAgent } from "./onboarding-contrast-mocks";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mount = document.createElement("main");
document.body.append(mount);
const root = createRoot(mount);
// The pour's two failure lines (FR-ONB-007): an action that failed, and the agent detection of scene 2.
const Cases = ["first-run", "agent-list"];
const noop = () => {};

async function render(kind: string) {
    Fixture.mode = kind;
    document.querySelectorAll("main").forEach((el) => {
        el.style.display = el === mount ? "" : "none";
    });
    await act(async () => root.render(null));
    const view = (
        <OnboardingPour
            reduced
            busy={false}
            error={kind === "first-run" ? "Unable to continue: fixture failure" : undefined}
            agents={kind === "first-run" ? { agents: [FoundAgent as any], version: "1" } : null}
            agentsError={kind === "agent-list" ? "Unable to list the agents: fixture failure" : undefined}
            checking={false}
            initialScene={kind === "agent-list" ? 1 : 0}
            onRecord={noop}
            onCheckAgain={noop}
            onSkip={noop}
            onStart={noop}
        />
    );
    await act(async () => root.render(<div style={{ height: 760 }}>{view}</div>));
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (!document.body.textContent.includes("fixture failure")) throw new Error(`Missing real ${kind} error`);
}

(globalThis as any).renderOnboardingCase = render;
(globalThis as any).runOnboardingContrastChecks = async () => {
    try {
        const rows: any[] = [];
        for (const kind of Cases) {
            await render(kind);
            const errors = Array.from(document.querySelectorAll<HTMLElement>("p")).filter(
                (el) => el.children.length === 0 && el.textContent.includes("fixture failure")
            );
            if (!errors.length) throw new Error(`Missing ${kind} measured text`);
            for (const accent of choices) {
                document.documentElement.style.setProperty("--mt-accent", accent);
                for (const el of errors) {
                    const result = measure(el);
                    if (result.ratio < 4.5)
                        throw new Error(`${kind} ${accent}: ${JSON.stringify(result)} ${el.outerHTML}`);
                    rows.push({ kind, accent, text: el.textContent, ...result });
                }
            }
        }
        await act(async () => root.render(null));
        return {
            samples: rows.length,
            accents: choices.length,
            minimum: Math.min(...rows.map((r) => r.ratio)),
            kinds: Cases,
            rows,
        };
    } catch (e: any) {
        throw new Error(String(e?.stack ?? e?.message ?? JSON.stringify(e)));
    }
};
