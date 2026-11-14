// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("../boss/boss-store", async () => {
    const { atom } = await import("jotai");
    const nameAtom = atom("Brokk");
    return { BossBubbleModel: { getInstance: () => ({ nameAtom }) } };
});
vi.mock("../agent-info/agent-info-hooks", () => ({ useWorkspaceName: (id: string) => (id ? "Atelier" : "") }));
vi.mock("./brainstorm-launch-store", async () => {
    const { atom } = await import("jotai");
    const model = {
        setupPreviewAtom: atom(null),
        profileAtom: atom(""),
        dryRunAtom: atom(null),
        dryRunBusyAtom: atom(false),
        setupBusyAtom: atom(false),
        setupFailureAtom: atom(null),
        copiedAtom: atom(false),
        handoffPreviewAtom: atom(null),
        agentAtom: atom(""),
        briefAtom: atom(null),
        handoffBusyAtom: atom(false),
        handoffFailureAtom: atom(null),
        setupFoldedAtom: atom(false),
        handoffFoldedAtom: atom(false),
        show: vi.fn(async () => {}),
    };
    return { BrainstormLaunchModel: { getInstance: () => model } };
});

import { globalStore } from "@/app/store/jotaiStore";
import en from "../i18n/locales/en.json";
import { HandoffCard, SetupCard } from "./brainstorm-launch";
import type { HandoffPreview, SetupPreview } from "./brainstorm-launch-model";
import { BrainstormLaunchModel } from "./brainstorm-launch-store";

const model = BrainstormLaunchModel.getInstance() as any;

const Dir = "/synthetic/Projects/safe-kids-videos";
const Harness = "saasfoundryai new --profile harness --project-name safe-kids-videos";
const Full = "saasfoundryai new --profile full --project-name safe-kids-videos";

const proposal = (id: string, action: string, status = "proposed") => ({
    id,
    kind: "proposal",
    text: id,
    status,
    action,
});

const state = (
    promotedto: any = { dir: Dir, workspace: "ws-1", at: 5 },
    nodes = [proposal("s", "saasfoundry"), proposal("h", "handoff")]
) =>
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
            turns: 4,
            promotedto,
        },
        brief: { name: "Safe Kids Videos", slug: "safe-kids-videos" },
        graph: {
            schema: 1,
            rev: 2,
            centre: "c",
            nodes: [{ id: "c", kind: "topic", text: "Kids", status: "open" }, ...nodes],
            links: [],
        },
    }) as any;

const setupPreview = (extra: Partial<SetupPreview> = {}): SetupPreview => ({
    dir: Dir,
    workspace: "ws-1",
    sf: true,
    profile: "harness",
    profilereason: "It is a Go tool, not a web SaaS.",
    name: "safe-kids-videos",
    commands: { full: Full, harness: Harness },
    ...extra,
});

const handoffPreview = (extra: Partial<HandoffPreview> = {}): HandoffPreview => ({
    dir: Dir,
    workspace: "ws-1",
    agent: "claude",
    agentname: "Claude Code",
    agents: [
        { id: "claude", name: "Claude Code", installed: true },
        { id: "codex", name: "Codex", installed: false },
    ],
    brief: "# Safe Kids Videos\n\n## First step\n\nSketch the parents' validation flow.\n",
    ...extra,
});

const setup = (s: any) => renderToStaticMarkup(<SetupCard state={s} />);
const handoff = (s: any) => renderToStaticMarkup(<HandoffCard state={s} />);

beforeEach(() => {
    globalStore.set(model.setupPreviewAtom, setupPreview());
    globalStore.set(model.profileAtom, "");
    globalStore.set(model.dryRunAtom, null);
    globalStore.set(model.dryRunBusyAtom, false);
    globalStore.set(model.setupBusyAtom, false);
    globalStore.set(model.setupFailureAtom, null);
    globalStore.set(model.handoffPreviewAtom, handoffPreview());
    globalStore.set(model.briefAtom, null);
    globalStore.set(model.handoffBusyAtom, false);
    globalStore.set(model.handoffFailureAtom, null);
    globalStore.set(model.setupFoldedAtom, false);
    globalStore.set(model.handoffFoldedAtom, false);
});

// FR-BOSS-010 AC16, AC-1 (#2251): before the click the card shows the choice, his reason, what each installs and the
// exact command.
describe("the SaaSFoundryAI card (#2251)", () => {
    it("shows both profiles in plain words, his choice and reason, and the command", () => {
        const html = setup(state());
        expect(html).toContain('data-kind="ready"');
        expect(html).toContain(en.boss.brainstorm.setup.profiles.full.line1);
        expect(html).toContain(en.boss.brainstorm.setup.profiles.harness.line1);
        expect(html).toMatch(
            /aria-checked="true"[^>]*class="[^"]*mt-selected-action[^"]*"[^>]*data-testid="brainstorm-setup-profile-harness"/
        );
        expect(html).toMatch(/aria-checked="false"[^>]*data-testid="brainstorm-setup-profile-full"/);
        expect(html).toContain("Brokk&#x27;s choice");
        expect(html).toContain("Brokk: “It is a Go tool, not a web SaaS.”");
        expect(html).toContain(`data-testid="brainstorm-setup-command">${Harness}<`);
        expect(html).toContain("in a terminal of “Atelier”");
        expect(html).toContain("Your keys stay with you.");
        expect(html).toMatch(
            /class="molten-btn[^"]*"[^>]*data-testid="brainstorm-setup-start"[^>]*>Set up: Harness only/
        );
        expect(html).toContain("molten-btn-wave");
    });

    it("follows the developer's pick", () => {
        globalStore.set(model.profileAtom, "full");
        const html = setup(state());
        expect(html).toContain(`data-testid="brainstorm-setup-command">${Full}<`);
        expect(html).toMatch(/data-testid="brainstorm-setup-start"[^>]*>Set up: Full/);
    });

    it("holds the click until a profile is chosen when he recommended none", () => {
        globalStore.set(model.setupPreviewAtom, setupPreview({ profile: "", profilereason: "" }));
        const html = setup(state());
        expect(html).not.toContain('data-testid="brainstorm-setup-command"');
        expect(html).not.toContain('data-testid="brainstorm-setup-recommended"');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="brainstorm-setup-start"/);
    });

    // AC-3: without the CLI, how to install it, and nothing to click that would run it.
    it("says how to install SaaSFoundryAI and runs nothing without it", () => {
        globalStore.set(model.setupPreviewAtom, setupPreview({ sf: false, refusal: "nosf", commands: undefined }));
        const html = setup(state());
        expect(html).toContain('data-testid="brainstorm-setup-nosf"');
        expect(html).toContain(">npm install -g saasfoundryai-cli<");
        expect(html).toContain('data-testid="brainstorm-setup-check"');
        expect(html).not.toContain('data-testid="brainstorm-setup-start"');
    });

    it("offers the dry run on a folder set up already, then its summary and the update", () => {
        const managed = setupPreview({
            managed: true,
            commands: { update: "saasfoundryai update --target-profile full" },
        });
        globalStore.set(model.setupPreviewAtom, managed);
        let html = setup(state());
        expect(html).toContain(en.boss.brainstorm.setup.managed);
        expect(html).toContain('data-testid="brainstorm-setup-dryrun-start"');
        expect(html).not.toContain('data-testid="brainstorm-setup-start"');
        globalStore.set(model.dryRunAtom, {
            status: "ready",
            add: 42,
            conflict: 2,
            compatible: 0,
            unsupported: 0,
            canapply: true,
        });
        html = setup(state());
        expect(html).toContain("The full profile adds 42 files.");
        expect(html).toContain("2 of them differ from yours");
        expect(html).toContain('data-testid="brainstorm-setup-command">saasfoundryai update --target-profile full<');
        expect(html).toMatch(/data-testid="brainstorm-setup-start"[^>]*>Add the full profile/);
        globalStore.set(model.dryRunAtom, {
            status: "noop",
            add: 0,
            conflict: 0,
            compatible: 0,
            unsupported: 0,
            canapply: false,
        });
        html = setup(state());
        expect(html).toContain(en.boss.brainstorm.setup.dryFull);
        expect(html).not.toContain('data-testid="brainstorm-setup-start"');
    });

    it("after the click: when the terminal opened, and the way to it", () => {
        const launched = {
            step: "setup",
            at: 1,
            dir: Dir,
            workspace: "ws-1",
            tab: "t",
            block: "b",
            command: Harness,
            typed: true,
        };
        globalStore.set(model.setupPreviewAtom, setupPreview({ launched } as any));
        const html = setup(state());
        expect(html).toContain('data-testid="brainstorm-setup-launched"');
        expect(html).toMatch(/data-testid="brainstorm-setup-goto"[^>]*>Go to the terminal/);
        expect(html).not.toContain('data-testid="brainstorm-setup-start"');
        globalStore.set(model.setupPreviewAtom, setupPreview({ launched: { ...launched, typed: false } } as any));
        expect(setup(state())).toContain(`data-testid="brainstorm-setup-untyped">${Harness}<`);
    });

    it("waits for the project, and shows nothing without his proposal or once it is set aside", () => {
        expect(setup(state(null))).toContain(en.boss.brainstorm.setup.waiting.replace("{name}", "Brokk"));
        expect(setup(state(undefined, []))).toBe("");
        expect(setup(state(undefined, [proposal("s", "saasfoundry", "aside")]))).toBe("");
    });

    it("says a refusal in one sentence with Try again", () => {
        globalStore.set(model.setupFailureAtom, "terminal");
        const html = setup(state());
        expect(html).toContain(en.boss.brainstorm.launch.refused.terminal);
        expect(html).toContain('data-testid="brainstorm-setup-retry"');
    });

    it("draws the dominoes while it opens the terminal", () => {
        globalStore.set(model.setupBusyAtom, true);
        const html = setup(state());
        expect(html).toContain('data-testid="brainstorm-setup-working"');
        expect(html).toContain("df-domino-loader");
        expect(html).not.toContain('data-testid="brainstorm-setup-start"');
    });
});

// AC-4: the hand-off shows the agent, the workspace and the editable brief.
describe("the hand-off card (#2251)", () => {
    it("shows the agent, the workspace, the brief to edit and the button", () => {
        const html = handoff(state());
        expect(html).toContain('data-kind="ready"');
        expect(html).toMatch(
            /data-testid="brainstorm-handoff-agent"[^>]*>[\s\S]*<option value="claude" selected="">Claude Code<\/option>/
        );
        expect(html).not.toContain('value="codex"');
        expect(html).toContain('data-testid="brainstorm-handoff-workspace">Atelier<');
        expect(html).toMatch(
            /<textarea[^>]*data-testid="brainstorm-handoff-brief"[^>]*>[^<]*Sketch the parents&#x27; validation flow\./
        );
        expect(html).toContain("in your usual permission mode");
        expect(html).toMatch(
            /class="molten-btn[^"]*"[^>]*data-testid="brainstorm-handoff-start"[^>]*>Hand to Claude Code/
        );
    });

    it("keeps the developer's edit, with the way back to his brief", () => {
        globalStore.set(model.briefAtom, "My own first step");
        const html = handoff(state());
        expect(html).toMatch(/<textarea[^>]*>My own first step<\/textarea>/);
        expect(html).toContain('data-testid="brainstorm-handoff-reset"');
    });

    it("says when no agent can start, and offers no button", () => {
        globalStore.set(
            model.handoffPreviewAtom,
            handoffPreview({ agent: "", agentname: "", refusal: "noagent", agents: [] })
        );
        const html = handoff(state());
        expect(html).toContain(en.boss.brainstorm.launch.refused.noagent);
        expect(html).not.toContain('data-testid="brainstorm-handoff-start"');
    });

    it("lets the developer pick another agent when the chosen one is missing", () => {
        globalStore.set(
            model.handoffPreviewAtom,
            handoffPreview({ agent: "", agentname: "", refusal: "agentmissing", missing: true, chosenname: "Codex" })
        );
        const html = handoff(state());
        expect(html).toContain("Codex, chosen for this project, is not installed");
        expect(html).toMatch(/<option value=""[^>]*>Pick an agent<\/option>/);
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="brainstorm-handoff-start"/);
    });

    it("after the click: when the agent started, and the way to it", () => {
        const launched = {
            step: "handoff",
            at: 1,
            dir: Dir,
            workspace: "ws-1",
            tab: "t",
            block: "b",
            agent: "claude",
            agentname: "Claude Code",
            typed: true,
        };
        globalStore.set(model.handoffPreviewAtom, handoffPreview({ launched } as any));
        const html = handoff(state());
        expect(html).toContain('data-testid="brainstorm-handoff-launched"');
        expect(html).toContain("Claude Code started at");
        expect(html).toMatch(/data-testid="brainstorm-handoff-goto"[^>]*>Go to the agent/);
    });

    it("waits for the project", () => {
        expect(handoff(state({ dir: Dir, at: 5 }))).toContain('data-testid="brainstorm-handoff-waiting"');
    });

    it("folds to its eyebrow", () => {
        globalStore.set(model.handoffFoldedAtom, true);
        const html = handoff(state());
        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain('data-testid="brainstorm-handoff-brief"');
    });
});
