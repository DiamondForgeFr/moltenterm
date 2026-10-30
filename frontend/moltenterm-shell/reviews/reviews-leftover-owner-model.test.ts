// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { translate } from "../i18n/i18n-core";
import { wordPhrase } from "../i18n/phrase";
import { cardState } from "./reviews-card-model";
import {
    LeftoverAsk,
    LeftoverAsksAnswer,
    leftoverAway,
    leftoverOwnerCard,
    leftoverTurnRows,
    ownerReachable,
    unreachableOwner,
} from "./reviews-leftover-owner-model";
import { leftoverParts } from "./reviews-leftovers-model";
import type { ReviewPr } from "./reviews-model";
import type { UpcomingLeftover } from "./reviews-upcoming-model";

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const fr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);

const tree = "/p/.claude/worktrees/agent-a44bcb44e87d5cd93";
const valentin = { via: "agent" as const, pid: 44215, blockid: "b-valentin", firstname: "Valentin", agent: "claude" };

const leftover: UpcomingLeftover = {
    branch: "fix/1130-notification-card-number",
    pr: 1141,
    title: "Notification card number",
    worktree: tree,
    local: true,
    lock: "live",
    lockpid: 44215,
    owner: valentin,
};

function ask(patch: Partial<LeftoverAsk>): LeftoverAsk {
    return { dir: "/p", number: 1141, worktree: tree, owner: valentin, state: "asked", askedat: 1, ...patch };
}

function asks(...list: LeftoverAsk[]): LeftoverAsksAnswer {
    return { dir: "/p", asks: list };
}

function words(a: LeftoverAsk) {
    const card = leftoverOwnerCard(a, "11:40");
    if (card == null) {
        return null;
    }
    return {
        kind: card.kind,
        turn: card.turn,
        tone: card.tone,
        sentence: wordPhrase(card.sentence),
        why: wordPhrase(card.why),
        primary: wordPhrase(card.primary.label),
        action: card.primary.id,
        blockId: card.primary.blockId,
        molten: card.molten,
        history: wordPhrase(card.history),
    };
}

describe("a leftover's owner asked (#1143)", () => {
    it("asked: the agents' section, Follow {name}, calm", () => {
        expect(words(ask({ state: "asked" }))).toEqual({
            kind: "agent-working",
            turn: "agents",
            tone: "agent",
            sentence: "Asked Valentin · waiting",
            why: "",
            primary: "Follow Valentin",
            action: "follow",
            blockId: "b-valentin",
            molten: false,
            history: "Cleanup asked of Valentin at 11:40",
        });
        // A request queued behind the owner's work reads the same: nothing is the developer's yet.
        expect(words(ask({ state: "asked", delivery: "queued" })).turn).toBe("agents");
    });

    it("needs you: Yours, the PR card's own Answer {name} and sentence, with the owner's reason", () => {
        const needs = words(ask({ state: "needsyou", why: "outcome", reason: "#1130 still has a test running" }));
        expect(needs).toMatchObject({
            kind: "agent-waiting",
            turn: "yours",
            tone: "you",
            sentence: "Valentin is waiting for you",
            why: "#1130 still has a test running",
            primary: "Answer Valentin",
            action: "answer",
            blockId: "b-valentin",
            molten: true,
        });
        // The same call to action as a PR card whose agent waits for the developer.
        const pr = { number: 1, branch: "b", base: "develop", headoid: "", ci: { checks: [] } } as unknown as ReviewPr;
        const prCard = cardState({
            pr,
            agents: [{ kind: "panel", blockId: "b-valentin", name: "Valentin", state: "waiting", since: 1 }],
        });
        expect(wordPhrase(prCard.sentence)).toBe(needs.sentence);
        expect(wordPhrase(prCard.primary.label)).toBe(needs.primary);
        expect(prCard.primary.id).toBe(needs.action);
        expect(prCard.turn).toBe(needs.turn);
        expect(prCard.tone).toBe(needs.tone);
        expect(words(ask({ state: "needsyou", why: "question" })).why).toBe("a question about the cleanup");
        expect(words(ask({ state: "needsyou", why: "stopped" })).why).toBe("the worktree is still there");
    });

    it("done or free: no turn card, the Leftovers group's own until wavesrv answers after it", () => {
        expect(words(ask({ state: "done", endedat: 100 }))).toBeNull();
        expect(words(ask({ state: "free" }))).toBeNull();
        expect(leftoverAway(leftover, asks(ask({ state: "done", endedat: 100 })), 50)).toBe(true);
        expect(leftoverAway(leftover, asks(ask({ state: "done", endedat: 100 })), 150)).toBe(false);
        expect(leftoverAway(leftover, asks(ask({ state: "asked" })), 150)).toBe(true);
        expect(leftoverAway(leftover, asks(), 150)).toBe(false);
    });

    it("sorts the asked leftovers by turn", () => {
        const other: UpcomingLeftover = { ...leftover, pr: 1142, worktree: "/p/w2" };
        const rows = leftoverTurnRows(
            [leftover, other, { ...leftover, pr: 7, worktree: "" }],
            asks(ask({ state: "needsyou" }), ask({ number: 1142, worktree: "/p/w2", state: "asked" }))
        );
        expect(rows.yours.map((r) => r.leftover.pr)).toEqual([1141]);
        expect(rows.agents.map((r) => r.leftover.pr)).toEqual([1142]);
    });

    it("unreachable owner: named by process and pid, never asked", () => {
        const node: UpcomingLeftover = {
            ...leftover,
            owner: { via: "process", pid: 7000, process: "node", folder: "/elsewhere" },
        };
        expect(ownerReachable(node.owner)).toBe(false);
        expect(unreachableOwner(node)?.folder).toBe("/elsewhere");
        expect(unreachableOwner(leftover)).toBeNull();
        expect(leftoverParts(en, node, [])[0].text).toBe(
            "worktree agent-a44bcb44e87d5cd93, locked by node (pid 7000), which MoltenTerm cannot reach"
        );
        expect(leftoverParts(en, leftover, [])[0].text).toBe(
            "worktree agent-a44bcb44e87d5cd93, locked by Valentin: Clean up asks Valentin to remove it"
        );
        expect(leftoverParts(fr, { ...leftover, owner: { ...valentin, via: "parent" } }, [])[0].text).toBe(
            "worktree agent-a44bcb44e87d5cd93, verrouillé par la session de Valentin\u00a0: Nettoyer demande à Valentin de le supprimer"
        );
    });

    describe("in French", () => {
        beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
        afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

        it("words the states", () => {
            expect(words(ask({ state: "asked" }))).toMatchObject({
                sentence: "Demandé à Valentin · en attente",
                primary: "Suivre Valentin",
                history: "Nettoyage demandé à Valentin à 11:40",
            });
            expect(
                words(ask({ state: "needsyou", why: "outcome", reason: "#1130 a encore un test en cours" }))
            ).toMatchObject({
                sentence: "Valentin vous attend",
                why: "#1130 a encore un test en cours",
                primary: "Répondre à Valentin",
            });
            expect(words(ask({ state: "needsyou", why: "stopped" })).why).toBe("le worktree est toujours là");
        });
    });
});
