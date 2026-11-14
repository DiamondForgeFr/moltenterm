// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import type { PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, Mock, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom({ oid: "ws-current" }) } };
});
vi.mock("@/app/store/services", () => ({ WorkspaceService: { SetActiveTab: vi.fn() } }));
vi.mock("../notifications-store", () => ({ MoltentermNotifications: { getInstance: () => ({ goTo: vi.fn() }) } }));
vi.mock("./brainstorm-store", async () => {
    const { atom } = await import("jotai");
    const stateAtom = atom(null) as PrimitiveAtom<any>;
    return { BrainstormModel: { getInstance: () => ({ stateAtom, end: vi.fn() }) } };
});

import { globalStore } from "@/app/store/jotaiStore";
import {
    HandoffPreviewCommand,
    HandoffStartCommand,
    SetupDryRunCommand,
    SetupPreviewCommand,
    SetupStartCommand,
} from "./brainstorm-boot";
import type { HandoffPreview, Launch, SetupPreview } from "./brainstorm-launch-model";
import { BrainstormLaunchModel } from "./brainstorm-launch-store";
import { BrainstormModel } from "./brainstorm-store";

const Dir = "/synthetic/Projects/safe-kids-videos";
const Harness = "saasfoundryai new --profile harness --project-name safe-kids-videos";
const Full = "saasfoundryai new --profile full --project-name safe-kids-videos";

const state = () =>
    ({
        allowed: true,
        open: true,
        version: 4,
        swap: 2,
        brainstorm: { id: "id-kids", slug: "kids", promotedto: { dir: Dir, workspace: "ws-1", at: 5 } },
        brief: { name: "Safe Kids Videos", slug: "safe-kids-videos" },
    }) as any;

const setupPreview = (extra: Partial<SetupPreview> = {}): SetupPreview => ({
    dir: Dir,
    workspace: "ws-1",
    sf: true,
    profile: "harness",
    profilereason: "It is a Go tool.",
    name: "safe-kids-videos",
    commands: { full: Full, harness: Harness },
    ...extra,
});

const handoffPreview = (extra: Partial<HandoffPreview> = {}): HandoffPreview => ({
    dir: Dir,
    workspace: "ws-1",
    agent: "claude",
    agentname: "Claude",
    agents: [
        { id: "claude", name: "Claude", installed: true },
        { id: "codex", name: "Codex", installed: true },
    ],
    brief: "# Safe Kids Videos\n\n## First step\n\nSketch the flow.\n",
    ...extra,
});

const launch = (step: "setup" | "handoff"): Launch => ({
    step,
    at: 9,
    dir: Dir,
    workspace: "ws-1",
    tab: "tab-1",
    block: "block-1",
    command: step === "setup" ? Harness : "claude -- '…'",
    typed: true,
});

// A fake wavesrv: the calls the cards made, and its answers.
function fakeWavesrv(answers: Record<string, (data: any) => any>) {
    const calls: { command: string; data: any; timeout: number }[] = [];
    const call = async (command: string, data: any, timeout: number) => {
        calls.push({ command, data, timeout });
        const answer = answers[command];
        if (answer == null) {
            throw new Error(`no answer for ${command}`);
        }
        return answer(data);
    };
    return { calls, call };
}

let model: BrainstormLaunchModel;
let goTo: Mock<(launch: Launch) => Promise<void>>;

beforeEach(() => {
    BrainstormLaunchModel.resetInstance();
    model = BrainstormLaunchModel.getInstance();
    goTo = vi.fn(async (_launch: Launch) => {});
    globalStore.set(BrainstormModel.getInstance().stateAtom, state());
});

// FR-BOSS-010 AC16, AC-1, AC-2 (#2251).
describe("the SaaSFoundryAI card's work (#2251)", () => {
    it("previews, then sends the profile and exactly what the preview showed, then goes to the terminal", async () => {
        const wavesrv = fakeWavesrv({
            [SetupPreviewCommand]: () => ({ preview: setupPreview() }),
            [SetupStartCommand]: () => ({
                preview: setupPreview({ launched: launch("setup") }),
                launch: launch("setup"),
            }),
        });
        model.useDeps({ call: wavesrv.call, goTo });
        await model.show("setup");
        expect(wavesrv.calls[0]).toMatchObject({ command: SetupPreviewCommand, data: { swap: 2, id: "id-kids" } });
        expect(model.profile()).toBe("harness");
        expect(await model.startSetup("SaaSFoundryAI")).toBe(true);
        const start = wavesrv.calls.find((c) => c.command === SetupStartCommand);
        expect(start.data).toEqual({
            swap: 2,
            id: "id-kids",
            profile: "harness",
            tabname: "SaaSFoundryAI",
            expect: { dir: Dir, workspace: "ws-1", command: Harness },
        });
        expect(start.timeout).toBeGreaterThan(120000);
        expect(goTo).toHaveBeenCalledWith(launch("setup"));
    });

    it("sends the profile the developer picked, with its own command", async () => {
        const wavesrv = fakeWavesrv({
            [SetupPreviewCommand]: () => ({ preview: setupPreview() }),
            [SetupStartCommand]: () => ({ preview: setupPreview(), launch: launch("setup") }),
        });
        model.useDeps({ call: wavesrv.call, goTo });
        await model.show("setup");
        model.chooseProfile("full");
        await model.startSetup("SaaSFoundryAI");
        const start = wavesrv.calls.find((c) => c.command === SetupStartCommand);
        expect(start.data.profile).toBe("full");
        expect(start.data.expect.command).toBe(Full);
    });

    // The #2250 lesson: a preview that no longer holds runs nothing; the card previews again.
    it("previews again when wavesrv says stale, and goes nowhere", async () => {
        let previews = 0;
        const wavesrv = fakeWavesrv({
            [SetupPreviewCommand]: () => ({ preview: setupPreview({ managed: previews++ > 0 }) }),
            [SetupStartCommand]: () => ({ preview: setupPreview(), stale: true }),
        });
        model.useDeps({ call: wavesrv.call, goTo });
        await model.show("setup");
        expect(await model.startSetup("SaaSFoundryAI")).toBe(false);
        expect(goTo).not.toHaveBeenCalled();
        expect(globalStore.get(model.setupPreviewAtom).managed).toBe(true);
        expect(globalStore.get(model.setupFailureAtom)).toBeNull();
    });

    // The #2250 lesson: a click wavesrv did not answer says so and looks again: the terminal may be open.
    it("says it could not tell when wavesrv did not answer, and looks again", async () => {
        let previews = 0;
        const wavesrv = fakeWavesrv({
            [SetupPreviewCommand]: () => ({
                preview: previews++ === 0 ? setupPreview() : setupPreview({ launched: launch("setup") }),
            }),
            [SetupStartCommand]: () => {
                throw new Error("timeout");
            },
        });
        model.useDeps({ call: wavesrv.call, goTo });
        await model.show("setup");
        expect(await model.startSetup("SaaSFoundryAI")).toBe(false);
        expect(globalStore.get(model.setupFailureAtom)).toBe("unknown");
        expect(globalStore.get(model.setupPreviewAtom).launched?.block).toBe("block-1");
        expect(goTo).not.toHaveBeenCalled();
    });

    it("says a refusal and holds a second click while one runs", async () => {
        let release: () => void;
        const wavesrv = fakeWavesrv({
            [SetupPreviewCommand]: () => ({ preview: setupPreview() }),
            [SetupStartCommand]: () =>
                new Promise((resolve) => {
                    release = () => resolve({ preview: setupPreview(), error: "terminal" });
                }),
        });
        model.useDeps({ call: wavesrv.call, goTo });
        await model.show("setup");
        const first = model.startSetup("SaaSFoundryAI");
        await Promise.resolve();
        expect(await model.startSetup("SaaSFoundryAI")).toBe(false);
        release();
        expect(await first).toBe(false);
        expect(wavesrv.calls.filter((c) => c.command === SetupStartCommand)).toHaveLength(1);
        expect(globalStore.get(model.setupFailureAtom)).toBe("terminal");
    });

    // AC-3: without SaaSFoundryAI the click holds; Check again reads the PATH again.
    it("holds the click without the CLI, and Check again asks wavesrv to look again", async () => {
        const wavesrv = fakeWavesrv({
            [SetupPreviewCommand]: () => ({
                preview: setupPreview({ sf: false, refusal: "nosf", commands: undefined }),
            }),
        });
        model.useDeps({ call: wavesrv.call, goTo });
        await model.show("setup");
        expect(await model.startSetup("SaaSFoundryAI")).toBe(false);
        await model.refreshSetup(true);
        expect(wavesrv.calls.map((c) => c.data.refresh)).toEqual([false, true]);
        expect(wavesrv.calls.some((c) => c.command === SetupStartCommand)).toBe(false);
    });

    it("reads the dry run only on the developer's Preview", async () => {
        const managed = setupPreview({
            managed: true,
            commands: { update: "saasfoundryai update --target-profile full" },
        });
        const wavesrv = fakeWavesrv({
            [SetupPreviewCommand]: () => ({ preview: managed }),
            [SetupDryRunCommand]: () => ({ preview: managed, dryrun: { status: "ready", add: 3, canapply: true } }),
        });
        model.useDeps({ call: wavesrv.call, goTo });
        await model.show("setup");
        expect(wavesrv.calls.some((c) => c.command === SetupDryRunCommand)).toBe(false);
        await model.dryRun();
        expect(globalStore.get(model.dryRunAtom)).toMatchObject({ status: "ready", add: 3 });
    });
});

// AC-4 (#2251).
describe("the hand-off card's work (#2251)", () => {
    it("sends the agent it showed and the brief as edited, then goes to the agent", async () => {
        const wavesrv = fakeWavesrv({
            [HandoffPreviewCommand]: () => ({ preview: handoffPreview() }),
            [HandoffStartCommand]: () => ({ preview: handoffPreview(), launch: launch("handoff") }),
        });
        model.useDeps({ call: wavesrv.call, goTo });
        await model.show("handoff");
        model.editBrief("My own brief");
        expect(await model.startHandoff("First step")).toBe(true);
        const start = wavesrv.calls.find((c) => c.command === HandoffStartCommand);
        expect(start.data).toEqual({
            swap: 2,
            id: "id-kids",
            brief: "My own brief",
            tabname: "First step",
            expect: { dir: Dir, workspace: "ws-1", agent: "claude" },
        });
        expect(goTo).toHaveBeenCalledWith(launch("handoff"));
    });

    it("sends the preview's brief when it was not edited, and the agent picked", async () => {
        const wavesrv = fakeWavesrv({
            [HandoffPreviewCommand]: (data) => ({
                preview: handoffPreview(data.agent ? { agent: data.agent, agentname: "Codex" } : {}),
            }),
            [HandoffStartCommand]: () => ({ preview: handoffPreview(), launch: launch("handoff") }),
        });
        model.useDeps({ call: wavesrv.call, goTo });
        await model.show("handoff");
        model.chooseAgent("codex");
        // The preview of the agent before goes at once: the click waits for the new one.
        expect(await model.startHandoff("First step")).toBe(false);
        await model.refreshHandoff();
        await model.startHandoff("First step");
        const start = wavesrv.calls.find((c) => c.command === HandoffStartCommand);
        expect(start.data.agent).toBe("codex");
        expect(start.data.expect.agent).toBe("codex");
        expect(start.data.brief).toBe(handoffPreview().brief);
    });

    it("goes to the agent a click before started, and starts none", async () => {
        const wavesrv = fakeWavesrv({
            [HandoffPreviewCommand]: () => ({ preview: handoffPreview() }),
            [HandoffStartCommand]: () => ({
                preview: handoffPreview({ launched: launch("handoff") }),
                launch: launch("handoff"),
                already: true,
            }),
        });
        model.useDeps({ call: wavesrv.call, goTo });
        await model.show("handoff");
        expect(await model.startHandoff("First step")).toBe(true);
        expect(goTo).toHaveBeenCalledWith(launch("handoff"));
        expect(globalStore.get(model.handoffPreviewAtom).launched?.block).toBe("block-1");
    });

    it("starts the inputs over for another brainstorm", async () => {
        const wavesrv = fakeWavesrv({ [HandoffPreviewCommand]: () => ({ preview: handoffPreview() }) });
        model.useDeps({ call: wavesrv.call, goTo });
        await model.show("handoff");
        model.editBrief("draft");
        globalStore.set(BrainstormModel.getInstance().stateAtom, {
            ...state(),
            brainstorm: { ...state().brainstorm, id: "id-other" },
        });
        await model.show("handoff");
        expect(globalStore.get(model.briefAtom)).toBeNull();
    });
});
