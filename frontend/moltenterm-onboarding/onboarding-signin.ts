// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Sign in on an agent's card (FR-ONB-007 AC-5b, #1723), on the first launch and in Library › Agents: a terminal panel
// in the current workspace runs the agent's own sign-in, the command wavesrv builds from its catalog by agent id
// (pkg/molten/onboarding/signin.go). Nothing runs before the click. While the terminal runs, and when its command
// ends or the panel closes, MoltenTerm checks again by itself whether the agent's documented credentials file is
// there, and the card follows.

import { createBlock, createBlockSplitHorizontally } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { BlockService, ObjectService } from "@/app/store/services";
import { makeORef } from "@/app/store/wos";
import * as jotai from "jotai";
import { t } from "../moltenterm-shell/i18n/i18n";
import { serverErrorText } from "../moltenterm-shell/i18n/server-text";
import type { AgentSignIn, OnboardingAgents } from "./onboarding-agent-model";
import { agentSignInMeta, listOnboardingAgents } from "./onboarding-client";
import { isSignInActive, signInEnded, signInHowKey, signInOpensKey, type SignInRun } from "./onboarding-signin-model";

const SignInPollMs = 2000;
// Only bounds a sign-in left open: the terminal stays, Check again stays on the card.
const SignInFollowLimitMs = 30 * 60 * 1000;

type SignInTarget = { id: string; name: string; signIn?: AgentSignIn };

// The line as plain text, printed at the top of the terminal.
export function signInNote(card: SignInTarget): string {
    return t(signInHowKey(card.signIn), {
        name: card.name,
        command: card.signIn?.command ?? "",
        slash: card.signIn?.slash ?? "",
        opens: t(signInOpensKey(card.signIn)),
    });
}

function signedIn(list: OnboardingAgents, id: string): boolean {
    return !!list?.agents?.find((a) => a.id === id)?.signedin;
}

export class AgentSignInModel {
    private static instance: AgentSignInModel = null;

    runsAtom = jotai.atom({}) as jotai.PrimitiveAtom<Record<string, SignInRun>>;

    private constructor() {}

    static getInstance(): AgentSignInModel {
        if (AgentSignInModel.instance == null) {
            AgentSignInModel.instance = new AgentSignInModel();
        }
        return AgentSignInModel.instance;
    }

    static resetInstance(): void {
        AgentSignInModel.instance = null;
    }

    setRun(id: string, run: SignInRun) {
        globalStore.set(this.runsAtom, { ...globalStore.get(this.runsAtom), [id]: run });
    }

    // Opens the sign-in terminal beside besideBlockId when given (the first-run panel), else in the active tab, then
    // follows it. onList gets the detection that saw the sign-in, and the last one when the terminal ends.
    async start(
        card: SignInTarget,
        opts: { besideBlockId?: string; onList: (list: OnboardingAgents) => void }
    ): Promise<void> {
        if (isSignInActive(globalStore.get(this.runsAtom)[card.id])) {
            return;
        }
        this.setRun(card.id, { state: "opening" });
        let blockId: string;
        try {
            const meta = await agentSignInMeta(card.id, signInNote(card));
            const blockDef: BlockDef = {
                // The header names the agent's command, not the printed line wrapped around it.
                meta: {
                    ...meta,
                    "frame:title": t("onboarding.pour.agents.signInTitle", { name: card.name }),
                    "frame:text": card.signIn?.command ?? "",
                },
            };
            blockId = opts.besideBlockId
                ? await createBlockSplitHorizontally(blockDef, opts.besideBlockId, "after")
                : await createBlock(blockDef);
        } catch (e) {
            this.setRun(card.id, { state: "failed", error: serverErrorText(e) });
            return;
        }
        this.setRun(card.id, { state: "running", blockId });
        await this.follow(card.id, blockId, opts.onList);
    }

    async follow(id: string, blockId: string, onList: (list: OnboardingAgents) => void): Promise<void> {
        const deadline = Date.now() + SignInFollowLimitMs;
        let seenRunning = false;
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, SignInPollMs));
            const [status, block] = await Promise.all([
                BlockService.GetControllerStatus(blockId).catch((): BlockControllerRuntimeStatus => null),
                ObjectService.GetObject(makeORef("block", blockId)).catch((): WaveObj => null),
            ]);
            const procStatus = status?.shellprocstatus ?? null;
            seenRunning = seenRunning || procStatus === "running";
            const ended = signInEnded(seenRunning, procStatus, block == null);
            let list: OnboardingAgents = null;
            try {
                list = await listOnboardingAgents();
            } catch (e) {
                console.log("agent sign-in: check failed", e);
            }
            if (list != null && (ended || signedIn(list, id))) {
                onList(list);
            }
            if (ended || signedIn(list, id)) {
                break;
            }
        }
        this.setRun(id, { state: "ended", blockId });
    }
}
