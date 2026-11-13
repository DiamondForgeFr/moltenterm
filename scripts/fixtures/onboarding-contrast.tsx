// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot } from "react-dom/client";
import { OnboardingPour } from "../../frontend/moltenterm-onboarding/onboarding-pour";
import { sceneIndex } from "../../frontend/moltenterm-onboarding/onboarding-pour-model";
import { choices, measure } from "./contrast-measure";
import { Fixture, FoundAgent } from "./onboarding-contrast-mocks";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mount = document.createElement("main");
document.body.append(mount);
const root = createRoot(mount);
// The text is measured at rest, never while a scene still fades in: the pour's entrances only come from transparent
// (onboarding-pour.css), so without them every element shows its own style at once.
const atRest = document.createElement("style");
atRest.textContent =
    ".mt-pour *, .mt-pour *::before, .mt-pour *::after { animation: none !important; transition: none !important; }";
document.head.append(atRest);
// The pour's two failure lines (FR-ONB-007): an action that failed, and the agent detection of scene 2. Then every line
// of Brokk's scene with its /brainstorm block (FR-ONB-007 B-2 to B-5, #2304).
const Cases = ["first-run", "agent-list", "brokk"];
const noop = () => {};

// The text an element draws itself. The second half of a title is molten text clipped from a gradient, which no single
// colour describes: it is display text, judged by eye like the other scenes' titles.
function drawsText(el: HTMLElement): boolean {
    return (
        el.closest(".mt-pour-hot") == null &&
        Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim() !== "")
    );
}

function measuredText(kind: string): HTMLElement[] {
    if (kind === "brokk") {
        return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="pour-brokk"] *')).filter(drawsText);
    }
    return Array.from(document.querySelectorAll<HTMLElement>("p")).filter(
        (el) => el.children.length === 0 && el.textContent.includes("fixture failure")
    );
}

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
            agents={kind === "agent-list" ? null : { agents: [FoundAgent as any], version: "1" }}
            agentsError={kind === "agent-list" ? "Unable to list the agents: fixture failure" : undefined}
            checking={false}
            initialScene={kind === "agent-list" ? 1 : kind === "brokk" ? sceneIndex("brokk") : 0}
            onRecord={noop}
            onCheckAgain={noop}
            onSkip={noop}
            onStart={noop}
            brokk={{ name: "Brokk", brainstorm: true }}
        />
    );
    await act(async () => root.render(<div style={{ height: 760 }}>{view}</div>));
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (kind === "brokk") {
        if (document.querySelector('[data-testid="pour-brokk-brainstorm"]') == null) throw new Error("Missing Brokk's scene");
        return;
    }
    if (!document.body.textContent.includes("fixture failure")) throw new Error(`Missing real ${kind} error`);
}

(globalThis as any).renderOnboardingCase = render;
(globalThis as any).runOnboardingContrastChecks = async () => {
    try {
        const rows: any[] = [];
        for (const kind of Cases) {
            await render(kind);
            const errors = measuredText(kind);
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
