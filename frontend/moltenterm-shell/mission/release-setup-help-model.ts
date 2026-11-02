// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Help from the pipeline setup (#1152, FR-MC-044): one way to talk to the AI, the coding agent in the setup tab's
// terminal. "Ask for help" and each step's "Question" build the context (which screen or step, what the panel shows,
// the interface language) and give it to the tab's askAgent (#1150, pipeline-agent.ts), which opens or reuses the
// terminal and its agent and hands it MoltenTerm's request with the writing guide as its brief. The developer then
// asks in their own words, in the terminal. Kept apart from the components so the rules can be tested without the app.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";

// The setup's screens (epic #1149): the line the agent gets about where the developer is.
export type HelpScreen = "start" | "flow" | "describe" | "adjust" | "details" | "validate" | "prepare" | "template";

export type HelpStep = {
    channel?: "rc" | "public";
    number?: number;
    // The step's kind (prepare, changelog, tag...), a hint for the agent.
    kind?: string;
    // The step's sentence, as the screen shows it.
    text?: string;
};

// must match PipelineAskResult in pipeline-agent.ts (#1150)
export type AskResult = "sent" | "busy" | "none" | "missing" | "failed";
export type AskAgent = (req: { context: string }) => Promise<AskResult>;

// What the developer sees of the last request: being sent, or askAgent's result.
export type HelpStatus = "idle" | "asking" | AskResult;

// askAgent cuts nothing but refuses a context over 8000 characters (pkg/molten/mission/pipelineask.go).
const MaxContextChars = 7500;

const ScreenWords: Record<HelpScreen, string> = {
    start: "the first screen of the setup, reading the project",
    flow: `"Your way of publishing": the steps the project follows, in plain words`,
    describe: `"Describe it in your words": the developer tells the flow they want, the AI restates it in steps`,
    adjust: "adjusting what was understood of the project's way of publishing",
    details: `"See the technical details": the exact changes and files`,
    validate: `"Validation": the summary of the changes before the validation request is opened`,
    prepare: "the prepared pipeline, before the validation request",
    template: "saving the way of publishing to reuse it in other projects",
};

const LanguageNames: Record<string, string> = { en: "English", fr: "French" };

function languageOf(locale: string): string {
    const base = (locale ?? "").toLowerCase().split("-")[0];
    return LanguageNames[base] ?? (base ? `the language whose code is ${base}` : "English");
}

function stepLine(step: HelpStep): string {
    const channel =
        step.channel === "rc"
            ? "the release candidate"
            : step.channel === "public"
              ? "the public release"
              : "the release";
    let line = step.number ? `step ${step.number} of ${channel}` : channel;
    if (step.text) {
        line += `: "${step.text}"`;
    }
    return line;
}

// The context the agent gets: what the developer asks about, where they are, in which language to answer, and what the
// panel shows. The writing guide comes with the request itself (askAgent's brief).
export function helpContextOf(req: { locale: string; screen: HelpScreen; step?: HelpStep; panel?: string }): string {
    const lines: string[] = [];
    lines.push(
        req.step
            ? `The developer is asking about ${stepLine(req.step)}.`
            : `The developer is asking for help on ${ScreenWords[req.screen] ?? "the pipeline setup"}.`
    );
    if (req.step) {
        lines.push(`They are on the setup's screen ${ScreenWords[req.screen] ?? req.screen}.`);
    }
    if (req.step?.kind) {
        lines.push(`The step's kind: ${req.step.kind}.`);
    }
    lines.push(
        `Answer in ${languageOf(req.locale)}, their interface language. Say in one short sentence that you are ready, then wait for their question in this terminal.`
    );
    const panel = (req.panel ?? "").trim();
    if (panel) {
        lines.push("", "What the panel shows:", "", panel);
    }
    const text = lines.join("\n");
    return text.length > MaxContextChars ? text.slice(0, MaxContextChars) + "…" : text;
}

type PipelineStepText = { id?: string; title?: string; manual?: string };

// The pipeline's release steps as plain lines for the agent's context, read from the proposed .molten/project.json;
// screens that tell the steps in sentences give those instead (plainContextOf).
export function pipelineContextOf(text: string): string {
    if (!text) {
        return "";
    }
    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch {
        return "";
    }
    const lines: string[] = [];
    const channels: [string, string][] = [
        ["rc", "Release candidate"],
        ["public", "Public release"],
    ];
    for (const [channel, name] of channels) {
        const steps: PipelineStepText[] = parsed?.release?.[channel];
        if (!Array.isArray(steps) || steps.length === 0) {
            continue;
        }
        lines.push(`${name}:`);
        steps.forEach((s, i) => {
            lines.push(`${i + 1}. ${s?.title || s?.id || "?"}${s?.manual ? " (by hand)" : ""}`);
        });
    }
    return lines.join("\n");
}

// The plain sentences of a screen's channels as the agent's context: "Public release:" then "1. sentence".
export function plainContextOf(channels: { name: string; steps: { number: number; text: string }[] }[]): string {
    return channels
        .filter((c) => c.steps.length > 0)
        .map((c) => [`${c.name}:`, ...c.steps.map((s) => `${s.number}. ${s.text}`)].join("\n"))
        .join("\n");
}

export type ScreenHelp = { screen: HelpScreen; panel: string };

// The help state of one project's setup, shared by the panel's "Ask for help" (pipeline-agent-ui.tsx) and its steps'
// "Question" buttons: the screen shown and what it says, and what became of the last request.
export class SetupHelp {
    private static instances = new Map<string, SetupHelp>();

    dir: string;
    statusAtom = atom<HelpStatus>("idle") as PrimitiveAtom<HelpStatus>;
    screenAtom = atom<ScreenHelp>(null) as PrimitiveAtom<ScreenHelp>;

    private constructor(dir: string) {
        this.dir = dir;
    }

    static getInstance(dir: string): SetupHelp {
        let rtn = SetupHelp.instances.get(dir);
        if (rtn == null) {
            rtn = new SetupHelp(dir);
            SetupHelp.instances.set(dir, rtn);
        }
        return rtn;
    }

    static resetInstances(): void {
        SetupHelp.instances.clear();
    }

    async ask(askAgent: AskAgent, context: string): Promise<void> {
        if (globalStore.get(this.statusAtom) === "asking") {
            return;
        }
        globalStore.set(this.statusAtom, "asking");
        let result: AskResult = "failed";
        try {
            result = await askAgent({ context });
        } catch (e) {
            console.log("setup help", e);
        }
        globalStore.set(this.statusAtom, result ?? "failed");
    }
}
