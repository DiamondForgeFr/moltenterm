// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Agents section's state (FR-SHELL-088 #1699): wavesrv's catalog listing, the agent page open, and the install or
// uninstall each agent runs. Install and Uninstall go through the first run's window-only route: the window sends the
// agent's id, wavesrv runs the catalog's command (pkg/molten/onboarding/clinstall.go, agentpage.go).

import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as jotai from "jotai";
import type { OnboardingAgents } from "../../moltenterm-onboarding/onboarding-agent-model";
import {
    answerCliInstall,
    cancelCliInstall,
    cliInstallStatus,
    listOnboardingAgents,
    startCliInstall,
    startCliUninstall,
} from "../../moltenterm-onboarding/onboarding-client";
import { isRunning, type CliInstallStatus } from "../../moltenterm-onboarding/onboarding-install-model";
import { serverErrorText } from "../i18n/server-text";
import {
    answerChooseState,
    backChooseState,
    startChooseState,
    type ChooseAnswers,
    type ChooseState,
    type Matrix,
} from "./agents-model";

const JobPollMs = 500;

// must match pkg/molten/agentcontinuity/featuresroute.go (#1696); #1685 moves this to its reader
const FeaturesRouteId = "molten:agentfeatures";
const FeaturesGetCommand = "moltenagentfeatures";
const FeaturesTimeoutMs = 4000;

// "absent": this wavesrv does not serve the matrix yet.
export type MatrixState = Matrix | "absent";

export type { ChooseState };

export class LibraryAgentsModel {
    private static instance: LibraryAgentsModel = null;

    listAtom = jotai.atom(null) as jotai.PrimitiveAtom<OnboardingAgents>;
    errorAtom = jotai.atom(null) as jotai.PrimitiveAtom<string>;
    checkingAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
    openAtom = jotai.atom(null) as jotai.PrimitiveAtom<string>;
    jobsAtom = jotai.atom({}) as jotai.PrimitiveAtom<Record<string, CliInstallStatus>>;
    matrixAtom = jotai.atom(null) as jotai.PrimitiveAtom<MatrixState>;
    // Help me choose: its answers stay in this window, never recorded or sent (FR-ONB-008 AC-6).
    chooseAtom = jotai.atom(null) as jotai.PrimitiveAtom<ChooseState>;

    private constructor() {}

    static getInstance(): LibraryAgentsModel {
        if (LibraryAgentsModel.instance == null) {
            LibraryAgentsModel.instance = new LibraryAgentsModel();
        }
        return LibraryAgentsModel.instance;
    }

    static resetInstance(): void {
        LibraryAgentsModel.instance = null;
    }

    open(id: string) {
        globalStore.set(this.chooseAtom, null);
        globalStore.set(this.openAtom, id);
    }

    startChoose() {
        globalStore.set(this.openAtom, null);
        globalStore.set(this.chooseAtom, startChooseState());
    }

    closeChoose() {
        globalStore.set(this.chooseAtom, null);
    }

    answerChoose(answers: ChooseAnswers) {
        globalStore.set(this.chooseAtom, answerChooseState(globalStore.get(this.chooseAtom), answers));
    }

    backChoose() {
        globalStore.set(this.chooseAtom, backChooseState(globalStore.get(this.chooseAtom)));
    }

    async load(refresh?: boolean): Promise<void> {
        if (globalStore.get(this.checkingAtom)) {
            return;
        }
        globalStore.set(this.checkingAtom, true);
        globalStore.set(this.errorAtom, null);
        try {
            globalStore.set(this.listAtom, await listOnboardingAgents(refresh));
        } catch (e) {
            globalStore.set(this.errorAtom, serverErrorText(e));
        } finally {
            globalStore.set(this.checkingAtom, false);
        }
    }

    async loadMatrix(): Promise<void> {
        if (globalStore.get(this.matrixAtom) != null) {
            return;
        }
        try {
            const matrix = await TabRpcClient.wshRpcCall(FeaturesGetCommand, null, {
                route: FeaturesRouteId,
                timeout: FeaturesTimeoutMs,
            });
            globalStore.set(this.matrixAtom, matrix ?? "absent");
        } catch {
            globalStore.set(this.matrixAtom, "absent");
        }
    }

    setJob(status: CliInstallStatus) {
        globalStore.set(this.jobsAtom, { ...globalStore.get(this.jobsAtom), [status.id]: status });
    }

    // The agent's job is the first run's too: a page opened while the pour installs follows that install.
    async refreshJob(id: string): Promise<void> {
        try {
            const status = await cliInstallStatus(id);
            if (status?.state) {
                this.setJob(status);
                await this.follow(id);
            }
        } catch (e) {
            console.log("library agents: job status failed", e);
        }
    }

    async install(id: string): Promise<void> {
        if (isRunning(globalStore.get(this.jobsAtom)[id])) {
            return;
        }
        try {
            this.setJob(await startCliInstall(id));
        } catch (e) {
            this.setJob({ id, kind: "install", state: "failed", error: serverErrorText(e) });
            return;
        }
        await this.follow(id);
    }

    async uninstall(id: string, removeConfig: boolean): Promise<void> {
        if (isRunning(globalStore.get(this.jobsAtom)[id])) {
            return;
        }
        try {
            this.setJob(await startCliUninstall(id, removeConfig));
        } catch (e) {
            this.setJob({ id, kind: "uninstall", state: "failed", error: serverErrorText(e) });
            return;
        }
        await this.follow(id);
    }

    // Until the job ends, then a check with the login PATH read again, so the page says what is there now.
    async follow(id: string): Promise<void> {
        while (isRunning(globalStore.get(this.jobsAtom)[id])) {
            await new Promise((resolve) => setTimeout(resolve, JobPollMs));
            try {
                this.setJob(await cliInstallStatus(id));
            } catch (e) {
                console.log("library agents: job status failed", e);
            }
        }
        if (globalStore.get(this.jobsAtom)[id]?.state === "canceled") {
            return;
        }
        while (globalStore.get(this.checkingAtom)) {
            await new Promise((resolve) => setTimeout(resolve, JobPollMs));
        }
        await this.load(true);
    }

    async answer(id: string, text: string): Promise<void> {
        try {
            this.setJob(await answerCliInstall(id, text));
        } catch (e) {
            console.log("library agents: answer failed", e);
        }
    }

    async cancel(id: string): Promise<void> {
        try {
            this.setJob(await cancelCliInstall(id));
        } catch (e) {
            console.log("library agents: cancel failed", e);
        }
    }
}
