// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { agentWorkText } from "../agent-work-model";
import { translate } from "../i18n/i18n-core";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { OriginMetaKey, originText, readOrigin } from "../reviews/agent-origin";
import type { BrainstormState } from "./brainstorm-boot";
import { readGraphBlock } from "./brainstorm-graph-model";
import {
    briefProblem,
    briefToSend,
    canHandoff,
    canSetup,
    dryRunView,
    fullInTwoSteps,
    handoffExpect,
    hasStepProposal,
    installedAgents,
    launchCardOf,
    launchRefusalKey,
    LaunchRefusals,
    MaxHandoffBrief,
    setupCommand,
    setupExpect,
    SetupPreview,
    SfInstallCommand,
    startingProfile,
} from "./brainstorm-launch-model";
import { replayAnswer, ReplayScripts } from "./brainstorm-replay";

const Dir = "/synthetic/Projects/safe-kids-videos";

const node = (id: string, action: string, status = "proposed") => ({
    id,
    kind: "proposal",
    text: id,
    status,
    action,
    turn: 1,
    at: 1,
    pos: [0, 0, 0],
});

const state = (extra: Partial<BrainstormState> = {}, promotedto: any = { dir: Dir, workspace: "ws-1", at: 5 }) =>
    ({
        allowed: true,
        open: true,
        version: 3,
        swap: 2,
        brainstorm: {
            id: "id-kids",
            slug: "kids",
            title: "Kids",
            dir: "/synthetic/Brainstorms/kids",
            created: 1,
            updated: 2,
            state: "promoted",
            turns: 4,
            promotedto,
        },
        brief: { name: "Safe Kids Videos", slug: "safe-kids-videos" },
        graph: {
            schema: 1,
            rev: 2,
            centre: "c",
            nodes: [node("set-it-up", "saasfoundry"), node("hand-it-on", "handoff")],
            links: [],
        },
        ...extra,
    }) as any as BrainstormState;

const preview = (extra: Partial<SetupPreview> = {}): SetupPreview => ({
    dir: Dir,
    workspace: "ws-1",
    sf: true,
    profile: "harness",
    profilereason: "It is a web app.",
    name: "safe-kids-videos",
    commands: {
        new: "saasfoundryai new --profile harness --project-name safe-kids-videos",
        update: "saasfoundryai update --target-profile full",
        dryrun: "saasfoundryai update --target-profile full --dry-run --json",
    },
    ...extra,
});

const ready = { status: "ready", add: 3, compatible: 0, conflict: 0, unsupported: 0, canapply: true };

const enT = (key: string, vars?: Record<string, any>) => translate("en", key, vars);
const frT = (key: string, vars?: Record<string, any>) => translate("fr", key, vars);

// FR-BOSS-010 AC16 (#2251): a card shows with his proposal alone, waits for the project, and is ready once it is linked.
describe("the setup and hand-off cards (#2251)", () => {
    it("shows each card with his proposal, never for a brief alone or a proposal set aside", () => {
        expect(launchCardOf(state(), "setup")).toEqual({ kind: "ready" });
        expect(launchCardOf(state(), "handoff")).toEqual({ kind: "ready" });
        const none = state({ graph: { schema: 1, rev: 1, centre: "c", nodes: [], links: [] } });
        expect(launchCardOf(none, "setup")).toEqual({ kind: "none" });
        const aside = state({
            graph: { schema: 1, rev: 1, centre: "c", nodes: [node("s", "saasfoundry", "aside")], links: [] } as any,
        });
        expect(hasStepProposal(aside.graph, "setup")).toBe(false);
        expect(launchCardOf(aside, "setup")).toEqual({ kind: "none" });
        expect(launchCardOf({ ...state(), open: false }, "setup")).toEqual({ kind: "none" });
    });

    it("waits until the project is made and linked to its workspace", () => {
        expect(launchCardOf(state({}, null), "setup")).toEqual({ kind: "waiting" });
        expect(launchCardOf(state({}, { dir: Dir, at: 5 }), "handoff")).toEqual({ kind: "waiting" });
        expect(launchCardOf(state({ brief: undefined }), "setup")).toEqual({ kind: "waiting" });
    });

    // AC-1, AC-2, review of #2309: the click sends the command the preview showed, never one of its own; the setup is
    // the harness whichever profile is chosen, and full comes second by the update.
    it("starts on his recommendation and sends exactly the command it showed", () => {
        expect(startingProfile(preview())).toBe("harness");
        expect(startingProfile(preview({ profile: "" }))).toBe("");
        expect(startingProfile(preview({ profile: "stack" }))).toBe("");
        expect(setupCommand(preview())).toBe("saasfoundryai new --profile harness --project-name safe-kids-videos");
        expect(setupExpect(preview(), ready)).toEqual({
            dir: Dir,
            workspace: "ws-1",
            command: "saasfoundryai new --profile harness --project-name safe-kids-videos",
        });
        const managed = preview({ managed: true });
        expect(setupCommand(managed)).toBe("saasfoundryai update --target-profile full");
        expect(setupExpect(managed, ready)).toEqual({
            dir: Dir,
            workspace: "ws-1",
            command: "saasfoundryai update --target-profile full",
            dryrun: "ready",
        });
        expect(fullInTwoSteps(preview(), "full")).toBe(true);
        expect(fullInTwoSteps(preview(), "harness")).toBe(false);
        expect(fullInTwoSteps(preview({ launched: { profile: "full" } as any }), "harness")).toBe(true);
    });

    it("holds the click while something is in the way", () => {
        expect(canSetup(preview(), "harness", false)).toBe(true);
        expect(canSetup(preview(), "full", false)).toBe(true);
        expect(canSetup(preview(), "", false)).toBe(false);
        expect(canSetup(preview(), "harness", true)).toBe(false);
        expect(canSetup(preview({ refusal: "nosf", commands: undefined }), "harness", false)).toBe(false);
        expect(canSetup(preview({ launched: { block: "b" } as any }), "harness", false)).toBe(false);
        expect(canSetup(null, "harness", false)).toBe(false);
        // A folder set up already: the update only after a dry run that says it can add the full profile.
        const managed = preview({ managed: true });
        expect(canSetup(managed, "", false)).toBe(false);
        expect(canSetup(managed, "", false, { ...ready, canapply: false })).toBe(false);
        expect(canSetup(managed, "", false, ready)).toBe(true);
        expect(canSetup({ ...managed, update: { block: "u" } as any }, "", false, ready)).toBe(false);
    });

    // AC-4: the hand-off sends the agent it showed and the brief as edited.
    it("sends the agent it showed and the brief as edited", () => {
        const hp = {
            dir: Dir,
            workspace: "ws-1",
            agent: "claude",
            agentname: "Claude",
            agents: [
                { id: "claude", name: "Claude", installed: true },
                { id: "codex", name: "Codex", installed: false },
            ],
            brief: "# Safe Kids Videos",
        };
        expect(handoffExpect(hp)).toEqual({ dir: Dir, workspace: "ws-1", agent: "claude" });
        expect(installedAgents(hp).map((a) => a.id)).toEqual(["claude"]);
        expect(briefToSend(null, hp)).toBe("# Safe Kids Videos");
        expect(briefToSend("", hp)).toBe("");
        expect(briefToSend("mine", hp)).toBe("mine");
        expect(canHandoff(hp, "mine", false)).toBe(true);
        expect(canHandoff(hp, "x".repeat(MaxHandoffBrief + 1), false)).toBe(false);
        // Review of #2309: an emptied brief holds the click, and says why.
        expect(canHandoff(hp, "  \n ", false)).toBe(false);
        expect(briefProblem("  \n ")).toBe("empty");
        expect(briefProblem("x".repeat(MaxHandoffBrief + 1))).toBe("toolong");
        expect(briefProblem("mine")).toBe("");
        expect(canHandoff({ ...hp, agent: "" }, "mine", false)).toBe(false);
        expect(canHandoff({ ...hp, refusal: "agentmissing" }, "mine", false)).toBe(false);
    });

    it("reads the dry run of a folder set up already", () => {
        expect(dryRunView({ status: "noop" } as any)).toBe("full");
        expect(dryRunView({ status: "ready", canapply: true } as any)).toBe("adds");
        expect(dryRunView({ status: "ready", canapply: false } as any)).toBe("blocked");
        expect(dryRunView({ status: "blocked" } as any)).toBe("blocked");
    });

    // AC-5: every refusal has its sentence in both locales; an unknown code says it did not work.
    it("words every refusal in both locales", () => {
        for (const code of [...LaunchRefusals, "unknown"]) {
            const key = launchRefusalKey(code);
            expect(key).toBe(`boss.brainstorm.launch.refused.${code}`);
            expect(enT(key, { name: "Brokk", agent: "Codex" })).not.toBe(key);
            expect(frT(key, { name: "Brokk", agent: "Codex" })).not.toBe(key);
        }
        expect(launchRefusalKey("<b>")).toBe("boss.brainstorm.launch.refused.failed");
    });

    // AC-3: the install line is the developer's to run, and SaaSFoundryAI's own package.
    it("shows the install line without running it", () => {
        expect(SfInstallCommand).toBe("npm install -g saasfoundryai-cli");
    });

    // AC-5: no OS or AI provider name, no valuation and nothing to come in the cards' words.
    it("names no OS, no provider, no valuation and nothing to come", () => {
        const texts = JSON.stringify([
            en.boss.brainstorm.launch,
            en.boss.brainstorm.setup,
            en.boss.brainstorm.handoff,
            fr.boss.brainstorm.launch,
            fr.boss.brainstorm.setup,
            fr.boss.brainstorm.handoff,
            en.agentOrigin.brainstormSetup,
            en.agentOrigin.brainstormHandoff,
            fr.agentOrigin.brainstormSetup,
            fr.agentOrigin.brainstormHandoff,
        ]);
        for (const word of [
            "macOS",
            "Finder",
            "Windows",
            "Linux",
            "Claude",
            "Codex",
            "Anthropic",
            "OpenAI",
            "Geargrim",
            "DiamondForge",
            "coming soon",
            "bientôt",
            "valuation",
            "valorisation",
        ]) {
            expect(texts).not.toContain(word);
        }
    });
});

// What opens says why (#758): a terminal a brainstorm's click opened carries its origin.
describe("the brainstorm's terminals (#2251)", () => {
    const at = new Date(2026, 10, 14, 14, 5).getTime();
    const value = { kind: "brainstorm", step: "setup", repo: "", number: 0, branch: "", mode: "together", at };

    it("says who opened it, when and why", () => {
        const origin = readOrigin(value);
        expect(origin).not.toBeNull();
        expect(originText(origin, enT, "en-GB")).toBe(
            "Opened by you at 14:05 from a brainstorm, to set up SaaSFoundryAI in this project: its questions are asked here"
        );
        expect(originText({ ...origin, step: "handoff" }, frT, "fr-FR")).toBe(
            "Lancé par vous à 14:05 depuis un brainstorm, pour faire le premier pas de ce projet avec son brief"
        );
        expect(originText({ ...origin, step: "update" }, enT, "en-GB")).toBe(
            "Opened by you at 14:05 from a brainstorm, to add SaaSFoundryAI's full profile to this project: its questions are asked here"
        );
    });

    it("names the agent's work in the project panel", () => {
        expect(agentWorkText({ [OriginMetaKey]: { ...value, step: "handoff" } })).toBe(
            "first step of a brainstormed project"
        );
        expect(agentWorkText({ [OriginMetaKey]: value })).toBe("SaaSFoundryAI setup");
        expect(agentWorkText({ [OriginMetaKey]: { ...value, step: "update" } })).toBe("SaaSFoundryAI full profile");
    });
});

// The scripted replay (dev and local builds) proposes both steps, as blocks the window reads.
describe("the replay's proposals (#2251)", () => {
    it("ends with the project, setup and hand-off proposals and a profile with its reason", () => {
        for (const script of [ReplayScripts.en, ReplayScripts.fr]) {
            const last = script[script.length - 1];
            const read = readGraphBlock(replayAnswer(last));
            expect(read.problem).toBe("");
            const actions = read.block.ops.filter((op) => op.op === "propose").map((op) => op.action);
            expect(actions).toEqual(["project", "saasfoundry", "handoff"]);
            const brief = read.block.ops.find((op) => op.op === "conclude").brief;
            expect(brief.profile).toBe("full");
            expect(brief.profilereason).not.toBe("");
        }
    });
});
