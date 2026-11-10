// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { I18nModel, t } from "../i18n/i18n";
import type { ToHandleItem } from "./boss-to-handle-model";
import { ExampleVisit, type Visit, visitPanelOf } from "./brokk-visit";
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
        expect(visitLineOf(visit("agent:a"), [waiting], T)).toEqual({
            key: "boss.screen.waitedFor",
            vars: { name: "Léa", minutes: 6 },
        });
    });

    it("counts a minute at least", () => {
        const waiting = row("agent:a", "waiting", { name: "Léa", since: T - 5_000 });
        expect(visitLineOf(visit("agent:a"), [waiting], T)).toMatchObject({ vars: { minutes: 1 } });
    });

    it("says the text the agent brought, with its name, when it asks something: the very words of its row", () => {
        const asking = row("agent:a", "waiting", {
            name: "Léa",
            since: T - 6 * Min,
            lineFromNotice: true,
            line: { text: "Autoriser la modification de main.go ?" },
        });
        const line = visitLineOf(visit("agent:a"), [asking], T);
        expect(line).toEqual({ text: "Léa: Autoriser la modification de main.go ?" });
    });

    it("says the row's own sentence for an agent that stopped", () => {
        const stopped = row("agent:b", "error", { name: "Théo", line: { text: "Théo s'est arrêté sur une erreur" } });
        expect(visitLineOf(visit("agent:b"), [stopped], T)).toEqual({ text: "Théo s'est arrêté sur une erreur" });
    });

    it("says the example's own sentence for the visit of the settings' Show a visit, which has no row", () => {
        expect(visitLineOf(ExampleVisit, [], T)).toEqual({ key: "boss.visit.exampleLine" });
        const waiting = row("agent:a", "waiting", { name: "Léa", since: T - 6 * Min });
        expect(visitLineOf(ExampleVisit, [waiting], T)).toEqual({ key: "boss.visit.exampleLine" });
    });
});

// #2205: a failing CI or a pull request ready is said in Brokk's own words, in the user's language, the PR by number:
// its title and the names of its checks are GitHub's text, which stays on the row, the card and Integration.
describe("a failing CI or a ready PR is said in his own words, the PR by number (FR-BOSS-009, AC81, #2205)", () => {
    const Title = "Fix the archive badge of the sidebar";
    const ci = row("ci:/work/app:2204", "error", {
        name: "#2204",
        line: { key: "boss.todo.ciFailed", vars: { checks: "lint, unit-tests" } },
    });
    const ready = row("ready:/work/app:2204", "success", { name: "#2204", line: { text: Title } });

    function said(keys: string[], items: ToHandleItem[]): string {
        const line = visitLineOf(visit(...keys), items, T);
        return line.text ?? t(line.key, line.vars);
    }

    afterEach(() => {
        I18nModel.getInstance().setLanguageSetting("en");
    });

    for (const [lang, ciLine, readyLine] of [
        ["en", "The CI of PR #2204 failed", "PR #2204 is ready to merge"],
        ["fr", "La CI de la PR #2204 a échoué", "La PR #2204 est prête à fusionner"],
    ]) {
        it(`says it in ${lang}, with no title and no check name`, () => {
            I18nModel.getInstance().setLanguageSetting(lang);
            expect(said(["ci:/work/app:2204"], [ci])).toBe(ciLine);
            expect(said(["ready:/work/app:2204"], [ready])).toBe(readyLine);
            const withMore = said(["ready:/work/app:2204", "download:1"], [ready]);
            expect(withMore.startsWith(readyLine)).toBe(true);
            for (const text of [said(["ci:/work/app:2204"], [ci]), said(["ready:/work/app:2204"], [ready]), withMore]) {
                expect(text).not.toContain(Title);
                expect(text).not.toContain("lint");
                expect(text).not.toContain("unit-tests");
            }
        });
    }

    it("names the PR by the key's number, even when its row is gone or its folder holds a colon", () => {
        expect(visitLineOf(visit("ready:/work/app:14"), [], T)).toEqual({
            key: "boss.visit.reason.ready",
            vars: { number: "14" },
        });
        expect(visitLineOf(visit("ci:C:\\work\\app:12"), [], T)).toEqual({
            key: "boss.visit.reason.ciFailed",
            vars: { number: "12" },
        });
    });
});

// #2203: the visit's line and its count come from one source, its own events. An event that is no row says what it is,
// and the others follow as "and N more": never a count of "things to handle", which a download, the update on offer, a
// plan reading or a finished agent are not.
describe("the line and the count of a visit are one source (FR-BOSS-009, AC79, #2203)", () => {
    it("names the reason of an event that is no row, by its kind", () => {
        expect(visitLineOf(visit("download:1"), [], T)).toEqual({ key: "boss.visit.reason.download" });
        expect(visitLineOf(visit("update:2.0.0"), [], T)).toEqual({ key: "boss.visit.reason.update" });
        expect(visitLineOf(visit("usage:claude"), [], T)).toEqual({ key: "boss.visit.reason.usage" });
        expect(visitLineOf(visit("security:lodash"), [], T)).toEqual({ key: "boss.visit.reason.security" });
    });

    it("never says how many things are to handle, whatever the events are", () => {
        for (const keys of [["download:1"], ["update:2"], ["usage:codex"], ["download:1", "update:2"], ["x:unknown"]]) {
            const line = visitLineOf(visit(...keys), [], T);
            expect(JSON.stringify(line), keys.join(",")).not.toContain("toHandle");
            expect(JSON.stringify(line), keys.join(",")).not.toContain("things to handle");
        }
    });

    it("takes the gravest event of the visit, the first key it lists, and counts the others as more", () => {
        const first = row("agent:a", "waiting", { name: "Léa", since: T - 20 * Min });
        const second = row("agent:b", "waiting", { name: "Théo", since: T - 6 * Min });
        const line = visitLineOf(visit("agent:a", "agent:b"), [second, first], T);
        expect(line).toEqual({ text: "Léa has waited 20 min and 1 more" });
    });

    it("counts every other event of the visit, rows or not", () => {
        const waiting = row("agent:a", "waiting", { name: "Léa", since: T - 6 * Min });
        const line = visitLineOf(visit("agent:a", "download:1", "update:2"), [waiting], T);
        expect(line).toEqual({ text: "Léa has waited 6 min and 2 more" });
        const noRow = visitLineOf(visit("download:1", "update:2", "usage:claude"), [], T);
        expect(noRow).toEqual({ text: "A download has news and 2 more" });
    });

    it("says that something needs him when the key of the event is unknown, rather than a count", () => {
        expect(visitLineOf(visit("agent:gone"), [], T)).toEqual({ key: "boss.visit.reason.other" });
    });

    it("leads to the panel that holds the reason: Downloads for a download, the Notifications for the rest", () => {
        expect(visitPanelOf(visit("download:1"))).toBe("downloads");
        expect(visitPanelOf(visit("agent:a"))).toBe("notifications");
        expect(visitPanelOf(visit("ci:/work/app:12"))).toBe("notifications");
        expect(visitPanelOf(visit("ready:/work/app:14"))).toBe("notifications");
        expect(visitPanelOf(visit("update:2"))).toBe("notifications");
        expect(visitPanelOf(visit("security:lodash"))).toBe("notifications");
    });

    it("asks for no panel when the week grid under his square already names the reason, or for the example", () => {
        expect(visitPanelOf(visit("usage:claude"))).toBeNull();
        expect(visitPanelOf(ExampleVisit)).toBeNull();
        expect(visitPanelOf(null)).toBeNull();
    });
});
