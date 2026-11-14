// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The SaaSFoundryAI and hand-off cards' work (FR-BOSS-010 AC16, #2251). wavesrv previews each step and, on the
// developer's click, opens a shown terminal in the project's workspace (pkg/molten/brainstorm/launch.go): this model asks
// it, sends what the preview showed, then leaves the brainstorm and goes to that terminal. Each click is one approval;
// nothing is remembered as one. A click again goes to the terminal the first one opened.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceService } from "@/app/store/services";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom } from "jotai";
import { MoltentermNotifications } from "../notifications-store";
import {
    BrainstormRouteId,
    BrainstormState,
    CallTimeoutMs,
    HandoffPreviewCommand,
    HandoffStartCommand,
    SetupDryRunCommand,
    SetupPreviewCommand,
    SetupStartCommand,
} from "./brainstorm-boot";
import {
    briefToSend,
    canHandoff,
    canSetup,
    DryRun,
    handoffExpect,
    HandoffPreview,
    HandoffResult,
    Launch,
    LaunchFailure,
    LaunchStep,
    setupExpect,
    SetupPreview,
    SetupResult,
    startingProfile,
} from "./brainstorm-launch-model";
import { BrainstormModel } from "./brainstorm-store";

// A start waits for the new terminal's first prompt in wavesrv (its own 2 min): past it, the call gives up too.
const StartTimeoutMs = 150000;
// The dry run is SaaSFoundryAI's own (its 60 s in wavesrv).
const DryRunTimeoutMs = 75000;

type Call = (command: string, data: Record<string, unknown>, timeout: number) => Promise<any>;

export type LaunchDeps = {
    call: Call;
    // Leaves the brainstorm, then shows the terminal: its workspace, its tab, then its panel.
    goTo: (launch: Launch) => Promise<void>;
    copy: (text: string) => Promise<void>;
};

const LiveDeps: LaunchDeps = {
    call: (command, data, timeout) => TabRpcClient.wshRpcCall(command, data, { route: BrainstormRouteId, timeout }),
    goTo: async (launch) => {
        await BrainstormModel.getInstance().end();
        // Another workspace shows its active tab when the window switches to it: the terminal's tab is made that one.
        if (launch.workspace && launch.workspace !== globalStore.get(atoms.workspace)?.oid) {
            try {
                await WorkspaceService.SetActiveTab(launch.workspace, launch.tab);
            } catch (e) {
                console.log("brainstorm: the terminal's tab could not be made the workspace's own", e);
            }
        }
        await MoltentermNotifications.getInstance().goTo({
            workspaceid: launch.workspace,
            tabid: launch.tab,
            blockid: launch.block,
        });
    },
    copy: (text) => navigator.clipboard.writeText(text),
};

export class BrainstormLaunchModel {
    private static instance: BrainstormLaunchModel = null;

    setupPreviewAtom = atom(null) as PrimitiveAtom<SetupPreview>;
    // The profile the developer picked; "" before they picked one (his recommendation shows selected).
    profileAtom = atom("") as PrimitiveAtom<string>;
    dryRunAtom = atom(null) as PrimitiveAtom<DryRun>;
    dryRunBusyAtom = atom(false) as PrimitiveAtom<boolean>;
    setupBusyAtom = atom(false) as PrimitiveAtom<boolean>;
    setupFailureAtom = atom(null) as PrimitiveAtom<LaunchFailure>;
    copiedAtom = atom(false) as PrimitiveAtom<boolean>;

    handoffPreviewAtom = atom(null) as PrimitiveAtom<HandoffPreview>;
    // The agent the developer picked for this hand-off; "" keeps the project's choice.
    agentAtom = atom("") as PrimitiveAtom<string>;
    // The brief as the developer edited it; null while it is the preview's.
    briefAtom = atom(null) as PrimitiveAtom<string>;
    handoffBusyAtom = atom(false) as PrimitiveAtom<boolean>;
    handoffFailureAtom = atom(null) as PrimitiveAtom<LaunchFailure>;

    // Each card folded to its eyebrow, so the graph behind shows.
    setupFoldedAtom = atom(false) as PrimitiveAtom<boolean>;
    handoffFoldedAtom = atom(false) as PrimitiveAtom<boolean>;

    private deps: LaunchDeps = LiveDeps;
    // The brainstorm the cards' inputs are of: another one starts them over.
    private of: string = null;
    private setupSeq = 0;
    private handoffSeq = 0;

    private constructor() {}

    static getInstance(): BrainstormLaunchModel {
        if (BrainstormLaunchModel.instance == null) {
            BrainstormLaunchModel.instance = new BrainstormLaunchModel();
        }
        return BrainstormLaunchModel.instance;
    }

    static resetInstance(): void {
        BrainstormLaunchModel.instance = null;
    }

    useDeps(deps: Partial<LaunchDeps>): void {
        this.deps = { ...this.deps, ...deps };
    }

    private state(): BrainstormState {
        return globalStore.get(BrainstormModel.getInstance().stateAtom);
    }

    private brainstormOf(): { swap: number; id: string } {
        const state = this.state();
        return { swap: state?.swap, id: state?.brainstorm?.id ?? "" };
    }

    private async ask(command: string, data: Record<string, unknown>, timeout = CallTimeoutMs): Promise<any> {
        try {
            return await this.deps.call(command, data, timeout);
        } catch (e) {
            console.log("brainstorm: wavesrv did not answer", command, e);
            return null;
        }
    }

    // A card shows for this brainstorm: the inputs start over when it is another one, and its preview follows.
    async show(step: LaunchStep): Promise<void> {
        const id = this.state()?.brainstorm?.id ?? "";
        if (id !== this.of) {
            this.of = id;
            globalStore.set(this.setupPreviewAtom, null);
            globalStore.set(this.profileAtom, "");
            globalStore.set(this.dryRunAtom, null);
            globalStore.set(this.setupFailureAtom, null);
            globalStore.set(this.handoffPreviewAtom, null);
            globalStore.set(this.agentAtom, "");
            globalStore.set(this.briefAtom, null);
            globalStore.set(this.handoffFailureAtom, null);
        }
        await (step === "setup" ? this.refreshSetup() : this.refreshHandoff());
    }

    toggleFold(step: LaunchStep): void {
        globalStore.set(step === "setup" ? this.setupFoldedAtom : this.handoffFoldedAtom, (folded) => !folded);
    }

    // The profile the click would use: the developer's pick, else his recommendation.
    profile(): string {
        return globalStore.get(this.profileAtom) || startingProfile(globalStore.get(this.setupPreviewAtom));
    }

    // The SaaSFoundryAI preview; refresh reads the login PATH again (Check again, once the developer installed it).
    async refreshSetup(refresh = false): Promise<void> {
        const seq = ++this.setupSeq;
        const result: SetupResult = await this.ask(SetupPreviewCommand, { ...this.brainstormOf(), refresh });
        if (seq !== this.setupSeq || result == null || result.stale) {
            return;
        }
        globalStore.set(this.setupPreviewAtom, result.preview ?? null);
        if (globalStore.get(this.setupFailureAtom) !== "terminal") {
            globalStore.set(this.setupFailureAtom, null);
        }
    }

    chooseProfile(profile: string): void {
        globalStore.set(this.profileAtom, profile);
        globalStore.set(this.setupFailureAtom, null);
    }

    // Preview on a folder set up already: SaaSFoundryAI's dry run, which changes nothing, read by wavesrv.
    async dryRun(): Promise<void> {
        if (globalStore.get(this.dryRunBusyAtom)) {
            return;
        }
        globalStore.set(this.dryRunBusyAtom, true);
        globalStore.set(this.setupFailureAtom, null);
        try {
            const result: SetupResult = await this.ask(SetupDryRunCommand, this.brainstormOf(), DryRunTimeoutMs);
            if (result == null) {
                globalStore.set(this.setupFailureAtom, "failed");
                return;
            }
            if (result.stale) {
                void this.refreshSetup();
                return;
            }
            globalStore.set(this.setupPreviewAtom, result.preview ?? globalStore.get(this.setupPreviewAtom));
            if (result.error) {
                globalStore.set(this.setupFailureAtom, result.error as LaunchFailure);
                return;
            }
            globalStore.set(this.dryRunAtom, result.dryrun ?? null);
        } finally {
            globalStore.set(this.dryRunBusyAtom, false);
        }
    }

    // The click (AC-2): wavesrv opens the shown terminal and types the command the preview showed, then the window goes
    // there. When the preview no longer holds (stale), nothing runs and the card previews again.
    async startSetup(tabName: string): Promise<boolean> {
        const preview = globalStore.get(this.setupPreviewAtom);
        const profile = this.profile();
        if (!canSetup(preview, profile, globalStore.get(this.setupBusyAtom))) {
            return false;
        }
        globalStore.set(this.setupBusyAtom, true);
        globalStore.set(this.setupFailureAtom, null);
        try {
            const result: SetupResult = await this.ask(
                SetupStartCommand,
                { ...this.brainstormOf(), profile, tabname: tabName, expect: setupExpect(preview, profile) },
                StartTimeoutMs
            );
            return await this.after(result, "setup");
        } finally {
            globalStore.set(this.setupBusyAtom, false);
        }
    }

    async copyInstall(text: string): Promise<void> {
        try {
            await this.deps.copy(text);
            globalStore.set(this.copiedAtom, true);
        } catch (e) {
            console.log("brainstorm: the install line could not be copied", e);
        }
    }

    // The hand-off preview, for the agent the developer picked ("" for the project's choice).
    async refreshHandoff(): Promise<void> {
        const seq = ++this.handoffSeq;
        const agent = globalStore.get(this.agentAtom);
        const result: HandoffResult = await this.ask(HandoffPreviewCommand, {
            ...this.brainstormOf(),
            ...(agent ? { agent } : {}),
        });
        if (seq !== this.handoffSeq || result == null || result.stale) {
            return;
        }
        globalStore.set(this.handoffPreviewAtom, result.preview ?? null);
        if (globalStore.get(this.handoffFailureAtom) !== "terminal") {
            globalStore.set(this.handoffFailureAtom, null);
        }
    }

    // Another agent picked: the preview of that one goes at once, so the click waits for it.
    chooseAgent(agent: string): void {
        globalStore.set(this.agentAtom, agent);
        globalStore.set(this.handoffFailureAtom, null);
        const preview = globalStore.get(this.handoffPreviewAtom);
        if (preview != null) {
            globalStore.set(this.handoffPreviewAtom, { ...preview, agent: "", agentname: "" });
        }
        void this.refreshHandoff();
    }

    editBrief(text: string): void {
        globalStore.set(this.briefAtom, text);
    }

    resetBrief(): void {
        globalStore.set(this.briefAtom, null);
    }

    // The click (AC-4): wavesrv writes the brief as edited and starts the agent the preview showed in a shown tab, then
    // the window goes there.
    async startHandoff(tabName: string): Promise<boolean> {
        const preview = globalStore.get(this.handoffPreviewAtom);
        const brief = briefToSend(globalStore.get(this.briefAtom), preview);
        if (!canHandoff(preview, brief, globalStore.get(this.handoffBusyAtom))) {
            return false;
        }
        globalStore.set(this.handoffBusyAtom, true);
        globalStore.set(this.handoffFailureAtom, null);
        const agent = globalStore.get(this.agentAtom);
        try {
            const result: HandoffResult = await this.ask(
                HandoffStartCommand,
                {
                    ...this.brainstormOf(),
                    ...(agent ? { agent } : {}),
                    brief,
                    tabname: tabName,
                    expect: handoffExpect(preview),
                },
                StartTimeoutMs
            );
            return await this.after(result, "handoff");
        } finally {
            globalStore.set(this.handoffBusyAtom, false);
        }
    }

    // What a start's answer does to its card: no answer says so and looks again (a terminal may be open), stale looks
    // again, a refusal says why, a terminal opened (now or by a click before) is where the window goes.
    private async after(result: SetupResult | HandoffResult, step: LaunchStep): Promise<boolean> {
        const failure = step === "setup" ? this.setupFailureAtom : this.handoffFailureAtom;
        const refresh = () => (step === "setup" ? this.refreshSetup() : this.refreshHandoff());
        if (result == null) {
            await refresh();
            globalStore.set(failure, "unknown");
            return false;
        }
        if (result.stale) {
            await refresh();
            return false;
        }
        if (step === "setup") {
            globalStore.set(this.setupPreviewAtom, (result as SetupResult).preview ?? null);
        } else {
            globalStore.set(this.handoffPreviewAtom, (result as HandoffResult).preview ?? null);
        }
        if (result.error || result.launch == null) {
            globalStore.set(failure, (result.error || "failed") as LaunchFailure);
            return false;
        }
        await this.goTo(result.launch);
        return true;
    }

    // Go to the terminal: the brainstorm is left first, so the terminal shows with nothing over it.
    async goTo(launch: Launch): Promise<void> {
        if (launch == null) {
            return;
        }
        try {
            await this.deps.goTo(launch);
        } catch (e) {
            console.log("brainstorm: the terminal could not be shown", e);
        }
    }
}
