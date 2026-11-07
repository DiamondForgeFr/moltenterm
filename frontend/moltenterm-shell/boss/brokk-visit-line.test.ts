// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { InfoItem, ToHandleItem } from "./boss-to-handle-model";
import type { Visit } from "./brokk-visit";
import { visitLineOf } from "./brokk-visit-line";

const T = new Date(2026, 10, 7, 14, 0, 0).getTime();
const Min = 60_000;

function row(key: string, tone: ToHandleItem["tone"], extra: Partial<ToHandleItem> = {}): ToHandleItem {
    return {
        key,
        tone,
        notice: null,
        lineFromNotice: false,
        name: "",
        line: { text: "" },
        place: "",
        since: 0,
        rank: 1,
        seen: false,
        actions: [],
        ...extra,
    };
}

function visit(...keys: string[]): Visit {
    return { severity: "important", expression: "doubtful", keys, count: keys.length };
}

describe("what the visit says of the event that brought him (FR-BOSS-009, AC29, AC30, #2070)", () => {
    it("says how long an agent has waited, with the sentence of his mood's caption", () => {
        const waiting = row("agent:a", "waiting", { name: "Léa", since: T - 6 * Min - 20_000 });
        expect(visitLineOf(visit("agent:a"), [waiting], [], T)).toEqual({
            key: "boss.screen.waitedFor",
            vars: { name: "Léa", minutes: 6 },
        });
    });

    it("counts a minute at least", () => {
        const waiting = row("agent:a", "waiting", { name: "Léa", since: T - 5_000 });
        expect(visitLineOf(visit("agent:a"), [waiting], [], T)).toMatchObject({ vars: { minutes: 1 } });
    });

    it("says the text the agent brought, with its name, when it asks something: the very words of its row", () => {
        const asking = row("agent:a", "waiting", {
            name: "Léa",
            since: T - 6 * Min,
            lineFromNotice: true,
            line: { text: "Autoriser la modification de main.go ?" },
        });
        const line = visitLineOf(visit("agent:a"), [asking], [], T);
        expect(line).toEqual({ text: "Léa: Autoriser la modification de main.go ?" });
    });

    it("says the row's own sentence for an agent that stopped, a failing CI and a pull request ready", () => {
        const stopped = row("agent:b", "error", { name: "Théo", line: { text: "Théo s'est arrêté sur une erreur" } });
        expect(visitLineOf(visit("agent:b"), [stopped], [], T)).toEqual({ text: "Théo s'est arrêté sur une erreur" });
        const ci = row("ci:/work/app:12", "error", { name: "app #12", line: { text: "La CI a échoué" } });
        expect(visitLineOf(visit("ci:/work/app:12"), [ci], [], T)).toEqual({ text: "La CI a échoué (app #12)" });
        const ready = row("ready:/work/app:14", "success", { name: "app #14", line: { text: "Prête à fusionner" } });
        expect(visitLineOf(visit("ready:/work/app:14"), [ready], [], T)).toEqual({
            text: "Prête à fusionner (app #14)",
        });
    });

    it("takes the gravest event of the visit that has words: the first key it lists", () => {
        const first = row("agent:a", "waiting", { name: "Léa", since: T - 20 * Min });
        const second = row("agent:b", "waiting", { name: "Théo", since: T - 6 * Min });
        const line = visitLineOf(visit("agent:a", "agent:b"), [second, first], [], T);
        expect(line).toMatchObject({ vars: { name: "Léa", minutes: 20 } });
    });

    it("skips an event that has no row, and says the next one", () => {
        const waiting = row("agent:a", "waiting", { name: "Léa", since: T - 6 * Min });
        const line = visitLineOf(visit("usage:claude", "agent:a"), [waiting], [], T);
        expect(line).toMatchObject({ key: "boss.screen.waitedFor" });
    });

    it("says who finished for good news that is no row", () => {
        const info: InfoItem = { key: "done:blk", name: "Léa", place: "", line: { key: "boss.todo.infoDone" } };
        expect(visitLineOf(visit("finished:blk"), [], [info], T)).toEqual({
            key: "boss.screen.finished",
            vars: { name: "Léa" },
        });
    });

    it("says how many things wait when no event of the visit has words of its own (a download, an update, a reading)", () => {
        expect(visitLineOf(visit("download:1", "update:2"), [], [], T)).toEqual({
            key: "boss.screen.toHandle",
            count: 2,
        });
    });
});
