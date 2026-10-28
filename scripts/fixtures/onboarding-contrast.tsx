// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot } from "react-dom/client";
import { atom } from "jotai";
import { AgentStep } from "../../frontend/moltenterm-onboarding/onboarding-agent-step";
import { MorphStep } from "../../frontend/moltenterm-onboarding/onboarding-morph-step";
import { ProjectStep } from "../../frontend/moltenterm-onboarding/onboarding-project-step";
import { FirstRunPanel } from "../../frontend/moltenterm-onboarding/onboarding-view";
import { choices, measure } from "./contrast-measure";
import { FoundAgent, Fixture } from "./onboarding-contrast-mocks";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mount = document.createElement("main");
document.body.append(mount);
const root = createRoot(mount);
const Cases = ["first-run", "agent-list", "agent-action", "morph-list", "morph-open", "project"];

const reject = async () => { throw new Error("Unable to save: fixture failure"); };
const ctx: any = {
    panelBlockId: "fixture", data: {}, setData: reject, complete: reject, skip: reject, markDone: reject, openBeside: reject,
    state: { data: { agent: { agent: FoundAgent.id } } },
};
const click = async (testId: string) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (!button) throw new Error(`Missing real onboarding button ${testId}`);
    await act(async () => button.click());
};

async function render(kind: string) {
    Fixture.mode = kind;
    document.querySelectorAll("main").forEach(el => { el.style.display = el === mount ? "" : "none"; });
    await act(async () => root.render(null));
    const model: any = {
        blockAtom: atom({ meta: { "molten:onboarding:page": "summary" } }),
        busyAtom: atom(false),
        errorAtom: atom("Unable to continue: fixture failure"),
    };
    const view = kind === "first-run" ? <FirstRunPanel model={model} />
        : kind.startsWith("agent") ? <AgentStep ctx={ctx} />
        : kind.startsWith("morph") ? <MorphStep ctx={ctx} />
        : <ProjectStep ctx={ctx} />;
    await act(async () => root.render(<div className="bg-[var(--mt-neutral-panel)] p-4">{view}</div>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    if (kind === "agent-action") await click("first-run-use-agent");
    if (kind === "morph-open") await click("first-run-open-agent");
    if (kind === "project") await click("first-run-scan-projects");
    if (!document.body.textContent.includes("fixture failure")) throw new Error(`Missing real ${kind} error`);
}

(globalThis as any).renderOnboardingCase = render;
(globalThis as any).runOnboardingContrastChecks = async () => {
    try {
    const rows: any[] = [];
    for (const kind of Cases) {
        await render(kind);
        const errors = Array.from(document.querySelectorAll<HTMLElement>("p"))
            .filter(el => el.children.length === 0 && el.textContent.includes("fixture failure"));
        if (!errors.length) throw new Error(`Missing ${kind} measured text`);
        for (const accent of choices) {
            document.documentElement.style.setProperty("--mt-accent", accent);
            for (const el of errors) {
                const result = measure(el);
                if (result.ratio < 4.5) throw new Error(`${kind} ${accent}: ${JSON.stringify(result)} ${el.outerHTML}`);
                rows.push({ kind, accent, text: el.textContent, ...result });
            }
        }
    }
    await act(async () => root.render(null));
    return { samples: rows.length, accents: choices.length, minimum: Math.min(...rows.map(r => r.ratio)), kinds: Cases, rows };
  } catch (e: any) { throw new Error(String(e?.stack ?? e?.message ?? JSON.stringify(e))); }
};
