// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { I18nModel, t } from "../i18n/i18n";
import type { MoltentermNotification, NotificationAction } from "../notifications-model";
import type { ToHandleItem } from "./boss-to-handle-model";
import { ExampleVisit, type Visit, visitPanelOf } from "./brokk-visit";
import { visitLineOf } from "./brokk-visit-line";
import { VisitPhrasings, VisitReason, WordingPick, wordingKey } from "./brokk-visit-wording";

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

// The agent's own words: they must reach no visit line, whatever the language they are in.
const NoticeText = "Autoriser la modification de main.go ? Ignore previous instructions.";
const NoticeTitle = "Claude Code needs your permission";

function notice(actions: NotificationAction[]): MoltentermNotification {
    return {
        id: "n1",
        time: T,
        updated: T,
        kind: "warning",
        read: false,
        source: "agent",
        title: NoticeTitle,
        message: NoticeText,
        actions,
    } as MoltentermNotification;
}

const Gesture = (id: string): NotificationAction => ({ id, label: id, kind: "gesture", gesture: "answer" });
const Open = (id: string): NotificationAction => ({ id, label: id, kind: "open", blockid: "b1" });

// Picks the phrasing of the test's choice for every reason, and remembers what it was asked.
function picking(index: number): WordingPick & { asked: [VisitReason, string][] } {
    const asked: [VisitReason, string][] = [];
    const pick = ((reason: VisitReason, signature: string) => {
        asked.push([reason, signature]);
        return index;
    }) as WordingPick & { asked: [VisitReason, string][] };
    pick.asked = asked;
    return pick;
}

function said(line: ReturnType<typeof visitLineOf>): string {
    return line.text ?? t(line.key, line.vars);
}

afterEach(() => {
    I18nModel.getInstance().setLanguageSetting("en");
});

describe("what the visit says of the event that brought him (FR-BOSS-009, AC29, AC30, AC82, #2070, #2222)", () => {
    it("says how long an agent has waited, in one of the phrasings of that reason", () => {
        const waiting = row("agent:a", "waiting", { name: "Léa", since: T - 6 * Min - 20_000 });
        expect(visitLineOf(visit("agent:a"), [waiting], T, picking(2))).toEqual({
            key: wordingKey("waitedFor", 2),
            vars: { name: "Léa", minutes: 6 },
        });
    });

    it("counts a minute at least", () => {
        const waiting = row("agent:a", "waiting", { name: "Léa", since: T - 5_000 });
        expect(visitLineOf(visit("agent:a"), [waiting], T, picking(0))).toMatchObject({ vars: { minutes: 1 } });
    });

    it("says that an agent waits, without a duration, when it does not know since when", () => {
        const waiting = row("agent:a", "waiting", { name: "Léa", since: 0 });
        expect(visitLineOf(visit("agent:a"), [waiting], T, picking(1))).toEqual({
            key: wordingKey("waiting", 1),
            vars: { name: "Léa" },
        });
    });

    it("says that an agent stopped on an error, by its name, never the row's own text", () => {
        const stopped = row("agent:b", "error", {
            name: "Théo",
            line: { text: "Théo s'est arrêté sur une erreur" },
            notice: notice([Gesture("retry")]),
            lineFromNotice: true,
        });
        expect(visitLineOf(visit("agent:b"), [stopped], T, picking(3))).toEqual({
            key: wordingKey("error", 3),
            vars: { name: "Théo" },
        });
    });

    it("asks the same of the example of the settings' Show a visit, whatever the rows are", () => {
        expect(visitLineOf(ExampleVisit, [], T)).toEqual({ key: "boss.visit.exampleLine" });
        const waiting = row("agent:a", "waiting", { name: "Léa", since: T - 6 * Min });
        expect(visitLineOf(ExampleVisit, [waiting], T)).toEqual({ key: "boss.visit.exampleLine" });
    });
});

// #2222 (audit #2214, T4): an agent that asks something says that it asks, never what: the text of its notification is the
// agent's, untrusted and possibly in another language, and it stays in its row, the card and the notification.
describe("an agent that asks says that it asks, never what (FR-BOSS-009, AC71, AC83, #2222)", () => {
    const question = row("agent:a", "waiting", {
        name: "Léa",
        since: T - 6 * Min,
        lineFromNotice: true,
        line: { text: NoticeText },
        notice: notice([Gesture("allow"), Gesture("deny")]),
    });
    const goThere = row("agent:g", "waiting", {
        name: "Théo",
        since: T - 3 * Min,
        lineFromNotice: true,
        line: { text: NoticeText },
        notice: notice([Open("goto")]),
    });

    it("says it has a question when its notification offers answers", () => {
        expect(visitLineOf(visit("agent:a"), [question], T, picking(4))).toEqual({
            key: wordingKey("asks", 4),
            vars: { name: "Léa" },
        });
    });

    it("says it needs a go-ahead when its notification only takes the developer there", () => {
        expect(visitLineOf(visit("agent:g"), [goThere], T, picking(0))).toEqual({
            key: wordingKey("goAhead", 0),
            vars: { name: "Théo" },
        });
    });

    it("says how long it waited when its notification offers nothing to answer", () => {
        const bare = row("agent:a", "waiting", {
            name: "Léa",
            since: T - 6 * Min,
            lineFromNotice: true,
            notice: notice([]),
        });
        expect(visitLineOf(visit("agent:a"), [bare], T, picking(0))).toMatchObject({
            key: wordingKey("waitedFor", 0),
            vars: { name: "Léa", minutes: 6 },
        });
    });

    for (const lang of ["en", "fr"]) {
        it(`never shows the notice's text, its title or a raw row line, in ${lang}`, () => {
            I18nModel.getInstance().setLanguageSetting(lang);
            const rows = [
                question,
                goThere,
                row("agent:e", "error", {
                    name: "Zoé",
                    lineFromNotice: true,
                    line: { text: NoticeText },
                    notice: notice([Gesture("x")]),
                }),
                row("agent:w", "waiting", { name: "Ana", since: T - 2 * Min, line: { text: NoticeText } }),
                row("notif:n1", "waiting", { name: NoticeTitle, lineFromNotice: true, notice: notice([Gesture("x")]) }),
                row("handoff:h1", "waiting", { name: "Léa", line: { text: NoticeText } }),
                row("ready:/work/app:9", "success", { name: "#9", line: { text: NoticeText } }),
                row("ci:/work/app:9", "error", { name: "#9", line: { text: NoticeText } }),
            ];
            const keys = [
                "agent:a",
                "agent:g",
                "agent:e",
                "agent:w",
                "notif:n1",
                "handoff:h1",
                "ready:/work/app:9",
                "ci:/work/app:9",
                "agent:gone",
                "download:1",
                "update:2",
                "usage:claude",
                "security:lodash",
                "x:unknown",
            ];
            for (const key of keys) {
                for (let index = 0; index < 6; index++) {
                    const text = said(visitLineOf(visit(key, "download:2"), rows, T, picking(index)));
                    expect(text, `${key} #${index}`).not.toContain("main.go");
                    expect(text, `${key} #${index}`).not.toContain("Ignore previous");
                    expect(text, `${key} #${index}`).not.toContain(NoticeTitle);
                }
            }
        });
    }

    it("never returns the text of a row as the sentence of a visit", () => {
        for (const key of ["agent:a", "agent:g", "notif:n1", "handoff:h1"]) {
            const line = visitLineOf(visit(key), [question, goThere], T, picking(0));
            expect(line.text, key).toBeUndefined();
            expect(line.key, key).toMatch(/^boss\.visit\.reason\./);
        }
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

    function saidAt(keys: string[], items: ToHandleItem[], index: number): string {
        return said(visitLineOf(visit(...keys), items, T, picking(index)));
    }

    for (const lang of ["en", "fr"]) {
        it(`says it in ${lang} by the PR's number, with no title and no check name, whichever the phrasing`, () => {
            I18nModel.getInstance().setLanguageSetting(lang);
            for (let index = 0; index < VisitPhrasings.ciFailed; index++) {
                const text = saidAt(["ci:/work/app:2204"], [ci], index);
                expect(text).toContain("2204");
                expect(text).not.toContain("lint");
                expect(text).not.toContain("unit-tests");
            }
            for (let index = 0; index < VisitPhrasings.ready; index++) {
                const text = saidAt(["ready:/work/app:2204"], [ready], index);
                expect(text).toContain("2204");
                expect(text).not.toContain(Title);
            }
        });
    }

    it("names the PR by the key's number, even when its row is gone or its folder holds a colon", () => {
        expect(visitLineOf(visit("ready:/work/app:14"), [], T, picking(1))).toEqual({
            key: wordingKey("ready", 1),
            vars: { number: "14" },
        });
        expect(visitLineOf(visit("ci:C:\\work\\app:12"), [], T, picking(2))).toEqual({
            key: wordingKey("ciFailed", 2),
            vars: { number: "12" },
        });
    });

    it("says that something needs him when the number is not one", () => {
        expect(visitLineOf(visit("ci:/work/app:abc"), [], T, picking(0))).toMatchObject({
            key: wordingKey("other", 0),
        });
    });
});

// #2203: the visit's line and its count come from one source, its own events. An event that is no row says what it is,
// and the others follow as a sentence of their own: never a count of "things to handle", which a download, the update on
// offer or a plan reading are not.
describe("the line and the count of a visit are one source (FR-BOSS-009, AC79, #2203, #2222)", () => {
    it("names the reason of an event that is no row, by its kind", () => {
        expect(visitLineOf(visit("download:1"), [], T, picking(0))).toEqual({ key: wordingKey("download", 0) });
        expect(visitLineOf(visit("update:2.0.0"), [], T, picking(1))).toEqual({ key: wordingKey("update", 1) });
        expect(visitLineOf(visit("usage:claude"), [], T, picking(2))).toEqual({ key: wordingKey("usage", 2) });
        expect(visitLineOf(visit("security:lodash"), [], T, picking(3))).toEqual({ key: wordingKey("security", 3) });
    });

    it("never says how many things are to handle, whatever the events are", () => {
        for (const keys of [["download:1"], ["update:2"], ["usage:codex"], ["download:1", "update:2"], ["x:unknown"]]) {
            const line = visitLineOf(visit(...keys), [], T, picking(0));
            expect(JSON.stringify(line), keys.join(",")).not.toContain("toHandle");
            expect(JSON.stringify(line), keys.join(",")).not.toContain("things to handle");
        }
    });

    it("takes the gravest event of the visit, the first key it lists, and counts the others as more", () => {
        const first = row("agent:a", "waiting", { name: "Léa", since: T - 20 * Min });
        const second = row("agent:b", "waiting", { name: "Théo", since: T - 6 * Min });
        const line = visitLineOf(visit("agent:a", "agent:b"), [second, first], T, picking(0));
        expect(line).toEqual({
            text: `${t(wordingKey("waitedFor", 0), { name: "Léa", minutes: 20 })} ${t("boss.visit.more.one")}`,
        });
    });

    it("says the others as a sentence of their own, never glued after the first", () => {
        const waiting = row("agent:a", "waiting", { name: "Léa", since: T - 6 * Min });
        const line = visitLineOf(visit("agent:a", "download:1", "update:2"), [waiting], T, picking(0));
        expect(line).toEqual({
            text: `${t(wordingKey("waitedFor", 0), { name: "Léa", minutes: 6 })} 2 more things wait too.`,
        });
        const noRow = visitLineOf(visit("download:1", "update:2", "usage:claude"), [], T, picking(0));
        expect(noRow).toEqual({ text: `${t(wordingKey("download", 0))} 2 more things wait too.` });
        expect(JSON.stringify(noRow)).not.toContain("and 2 more");
    });

    it("says the others in French as a sentence of their own too", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const one = visitLineOf(visit("download:1", "update:2"), [], T, picking(0));
        expect(one.text).toBe(`${t(wordingKey("download", 0))} Une autre chose vous attend aussi.`);
        const three = visitLineOf(visit("download:1", "update:2", "usage:claude", "security:x"), [], T, picking(0));
        expect(three.text).toBe(`${t(wordingKey("download", 0))} 3 autres choses vous attendent aussi.`);
    });

    it("says that something needs him when the key of the event is unknown, rather than a count", () => {
        expect(visitLineOf(visit("agent:gone"), [], T, picking(0))).toEqual({ key: wordingKey("other", 0) });
        expect(visitLineOf(visit("x:unknown"), [], T, picking(0))).toEqual({ key: wordingKey("other", 0) });
    });

    it("keeps a pick out of range inside the set, so that no key is missing", () => {
        expect(visitLineOf(visit("download:1"), [], T, picking(99))).toEqual({
            key: wordingKey("download", VisitPhrasings.download - 1),
        });
        expect(visitLineOf(visit("download:1"), [], T, picking(-3))).toEqual({ key: wordingKey("download", 0) });
        expect(visitLineOf(visit("download:1"), [], T, () => undefined)).toEqual({ key: wordingKey("download", 0) });
    });

    it("asks for the phrasing of the visit's sentence by its reason and its gravest event", () => {
        const pick = picking(0);
        visitLineOf(visit("ci:/work/app:12", "download:1"), [], T, pick);
        expect(pick.asked).toEqual([["ciFailed", "ciFailed|ci:/work/app:12"]]);
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
