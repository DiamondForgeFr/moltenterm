// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Clean up on a merged PR's leftovers (#1088, FR-REV-022 AC14), through the cleanup after a merge (FR-REV-013,
// pkg/molten/review/cleanup.go) and its safety checks: wavesrv keeps a worktree that would lose work or that a panel
// works in, and says why. Agent sessions at rest in it are closed, then the worktree goes; anything else (work to lose,
// an agent still working, a plain terminal) waits for a confirmation that names it.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { t } from "../i18n/i18n";
import {
    removeKeptWorktree,
    ReviewCleanupRequest,
    ReviewCleanupResult,
    ReviewCleanupStepResult,
    runReviewCleanup,
} from "../review/review-cleanup";
import { closePanels } from "../review/review-panels";
import {
    busyAgents,
    cleanedUp,
    cleanupNotes,
    keptAgentStep,
    LeftoverCleanupSteps,
    leftoverKey,
    panelsClosable,
} from "./reviews-leftovers-model";
import { upcomingGet } from "./reviews-upcoming-client";
import type { AgentBarFacts, UpcomingLeftover } from "./reviews-upcoming-model";

// What a confirmation waits on: agents still at work on the branch (before anything runs), or the worktree wavesrv
// kept (its loss and its panels).
export type LeftoverConfirm =
    | { kind: "busy"; agents: AgentBarFacts[] }
    | { kind: "kept"; step: ReviewCleanupStepResult; busyConfirmed: boolean };

export type LeftoverState = {
    busy?: boolean;
    confirm?: LeftoverConfirm;
    notes?: string[];
    error?: string;
    // When it was cleaned up: the card leaves until wavesrv answers after that.
    cleanedAt?: number;
};

// A forced ask wavesrv answers from its cache for this long (pkg/molten/mission/upcoming.go upcomingForcedInterval).
const UpcomingForcedIntervalMs = 5500;

type LeftoverTarget = { dir: string; repo: string; leftover: UpcomingLeftover; agents: AgentBarFacts[] };

export class LeftoversModel {
    private static instance: LeftoversModel = null;

    statesAtom = atom({}) as PrimitiveAtom<Record<string, LeftoverState>>;
    // Clean up all's confirmation: the leftovers it lists.
    allAtom = atom(null) as PrimitiveAtom<LeftoverTarget[]>;

    private constructor() {}

    static getInstance(): LeftoversModel {
        if (LeftoversModel.instance == null) {
            LeftoversModel.instance = new LeftoversModel();
        }
        return LeftoversModel.instance;
    }

    static resetInstance(): void {
        LeftoversModel.instance = null;
    }

    stateOf(dir: string, pr: number): LeftoverState {
        return globalStore.get(this.statesAtom)[leftoverKey(dir, pr)] ?? {};
    }

    private patch(dir: string, pr: number, patch: Partial<LeftoverState>) {
        const key = leftoverKey(dir, pr);
        globalStore.set(this.statesAtom, (states) => ({ ...states, [key]: { ...(states[key] ?? {}), ...patch } }));
    }

    private request(target: LeftoverTarget): Omit<ReviewCleanupRequest, "steps" | "worktreeconfirmed"> {
        const { dir, repo, leftover } = target;
        return { dir, repo, number: leftover.pr, ticket: leftover.ticket > 0 ? leftover.ticket : undefined };
    }

    // cleanUp: Clean up on one card. busyConfirmed: the developer already chose to stop the agents at work.
    async cleanUp(target: LeftoverTarget, busyConfirmed = false) {
        const { dir, leftover } = target;
        if (this.stateOf(dir, leftover.pr).busy) {
            return;
        }
        const busy = busyAgents(target.agents);
        if (busy.length > 0 && !busyConfirmed) {
            this.patch(dir, leftover.pr, { confirm: { kind: "busy", agents: busy }, error: null, notes: null });
            return;
        }
        await this.run(target, async () => {
            const req = this.request(target);
            const result = await runReviewCleanup({ ...req, steps: LeftoverCleanupSteps });
            const kept = keptAgentStep(result);
            if (kept == null || !panelsClosable(kept, busyConfirmed)) {
                return { result, kept, busyConfirmed };
            }
            await closePanels(kept.panels.map((p) => p.blockid));
            const again = await removeKeptWorktree(req, kept);
            return { result: mergeResults(result, again), kept: keptAgentStep(again), busyConfirmed };
        });
    }

    // confirm: the developer's yes to the open confirmation of the card.
    async confirm(target: LeftoverTarget) {
        const confirm = this.stateOf(target.dir, target.leftover.pr).confirm;
        if (confirm == null) {
            return;
        }
        this.patch(target.dir, target.leftover.pr, { confirm: null });
        if (confirm.kind === "busy") {
            await this.cleanUp(target, true);
            return;
        }
        await this.run(target, async () => {
            const req = this.request(target);
            await closePanels((confirm.step.panels ?? []).map((p) => p.blockid));
            const result = await removeKeptWorktree(req, confirm.step);
            return { result, kept: keptAgentStep(result), busyConfirmed: confirm.busyConfirmed };
        });
    }

    cancel(dir: string, pr: number) {
        this.patch(dir, pr, { confirm: null });
    }

    private async run(
        target: LeftoverTarget,
        work: () => Promise<{ result: ReviewCleanupResult; kept: ReviewCleanupStepResult; busyConfirmed: boolean }>
    ) {
        const { dir, leftover } = target;
        this.patch(dir, leftover.pr, { busy: true, error: null, notes: null, confirm: null });
        try {
            const { result, kept, busyConfirmed } = await work();
            const patch: Partial<LeftoverState> = { notes: cleanupNotes(t, result, leftover) };
            if (kept != null) {
                patch.confirm = { kind: "kept", step: kept, busyConfirmed };
            } else if (cleanedUp(result)) {
                patch.cleanedAt = Date.now();
            }
            this.patch(dir, leftover.pr, patch);
        } catch (e) {
            this.patch(dir, leftover.pr, { error: String(e?.message ?? e) });
        } finally {
            this.patch(dir, leftover.pr, { busy: false });
            this.refresh(dir);
        }
    }

    // refresh asks wavesrv again now, and once more after its forced-ask cache, which may hold the answer from before.
    private refresh(dir: string) {
        upcomingGet(dir, true).catch(() => {});
        setTimeout(() => upcomingGet(dir, true).catch(() => {}), UpcomingForcedIntervalMs);
    }

    askAll(targets: LeftoverTarget[]) {
        globalStore.set(this.allAtom, targets.length > 0 ? targets : null);
    }

    cancelAll() {
        globalStore.set(this.allAtom, null);
    }

    // confirmAll: Clean up all after its one confirmation, which listed every leftover and the agents at work on them;
    // a worktree that would lose work still asks on its own card.
    async confirmAll() {
        const targets = globalStore.get(this.allAtom) ?? [];
        globalStore.set(this.allAtom, null);
        for (const target of targets) {
            await this.cleanUp(target, true);
        }
    }
}

// mergeResults: the first run's steps, the ones run again replacing theirs.
export function mergeResults(first: ReviewCleanupResult, again: ReviewCleanupResult): ReviewCleanupResult {
    if (again == null) {
        return first;
    }
    const ids = new Set((again.steps ?? []).map((s) => s.id));
    return { ...first, steps: [...(first.steps ?? []).filter((s) => !ids.has(s.id)), ...(again.steps ?? [])] };
}
