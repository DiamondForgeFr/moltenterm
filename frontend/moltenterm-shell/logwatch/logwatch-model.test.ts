// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import {
    askFailureKey,
    candidateDetails,
    LogWatchAskCommand,
    LogWatchAskGesture,
    LogWatchAskResult,
    LogWatchCandidate,
    LogWatchDeps,
    LogWatchMuteCommand,
    LogWatchMuteGesture,
    LogWatchRouteId,
    readCardId,
    runAsk,
    runMute,
} from "./logwatch-model";

function lookup(dict: any, key: string): unknown {
    return key.split(".").reduce((node, part) => node?.[part], dict);
}

function placeholders(text: string): string[] {
    return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const Olivia: LogWatchCandidate = {
    blockid: "b1",
    firstname: "Olivia",
    agentname: "Claude Code",
    workspace: "Shop",
    project: "shop",
    moltenterm: true,
};
const Paul: LogWatchCandidate = { blockid: "b2", firstname: "Paul" };

function deps(answers: LogWatchAskResult[], over: Partial<LogWatchDeps> = {}) {
    const asked: unknown[] = [];
    const queue = [...answers];
    const d: LogWatchDeps = {
        on: () => true,
        ask: vi.fn(async (req) => {
            asked.push(req);
            return queue.shift();
        }),
        mute: vi.fn(async () => {}),
        pick: vi.fn(async () => "b2"),
        word: (e) => `worded: ${(e as Error).message}`,
        ...over,
    };
    return { d, asked };
}

// FR-BOSS-012 AC9: the click sends one request; with no lead that stands out the developer picks, and a cancelled pick
// sends nothing and says nothing.
describe("Ask an agent to look", () => {
    it("is done when wavesrv sent it to the lead", async () => {
        const { d, asked } = deps([{ status: "sent", to: "Olivia", delivery: "delivered" }]);
        expect(await runAsk(d, { id: "abc" })).toEqual({ ok: true });
        expect(asked).toEqual([{ id: "abc" }]);
        expect(d.pick).not.toHaveBeenCalled();
    });

    it("lets the developer pick, then sends to the picked agent", async () => {
        const { d, asked } = deps([
            { status: "pick", agents: [Olivia, Paul] },
            { status: "sent", to: "Paul" },
        ]);
        expect(await runAsk(d, { id: "abc" })).toEqual({ ok: true });
        expect(d.pick).toHaveBeenCalledWith([Olivia, Paul]);
        expect(asked).toEqual([{ id: "abc" }, { id: "abc", blockid: "b2" }]);
    });

    it("sends nothing when the developer cancels the pick", async () => {
        const { d, asked } = deps([{ status: "pick", agents: [Olivia] }], { pick: vi.fn(async () => "") });
        expect(await runAsk(d, { id: "abc" })).toEqual({ ok: true });
        expect(asked).toHaveLength(1);
    });

    it.each<[LogWatchAskResult["status"], string]>([
        ["noagent", "logwatch.noAgent"],
        ["gone", "logwatch.gone"],
        ["unknown", "logwatch.unknown"],
    ])("%s says why on the card", async (status, key) => {
        const { d } = deps([{ status }]);
        expect(await runAsk(d, { id: "abc" })).toEqual({ ok: false, errorKey: key });
    });

    it("words a refusal of wavesrv", async () => {
        const { d } = deps([], { ask: vi.fn(async () => Promise.reject(new Error("off"))) });
        expect(await runAsk(d, { id: "abc" })).toEqual({ ok: false, error: "worded: off" });
    });

    // AC1: where the window's gate is shut (a release, the switch off), nothing is asked.
    it("asks nothing where the watch is off, nor without a card", async () => {
        const off = deps([{ status: "sent" }], { on: () => false });
        expect(await runAsk(off.d, { id: "abc" })).toEqual({ ok: false, errorKey: "logwatch.unavailable" });
        expect(off.asked).toHaveLength(0);
        const none = deps([{ status: "sent" }]);
        expect(await runAsk(none.d, {})).toEqual({ ok: false, errorKey: "logwatch.unknown" });
        expect(none.asked).toHaveLength(0);
    });
});

// AC11: Ignore this kind mutes the signature and closes its card.
describe("Ignore this kind", () => {
    it("mutes and closes the card", async () => {
        const { d } = deps([]);
        expect(await runMute(d, { id: " abc " })).toEqual({ ok: true, resolve: true });
        expect(d.mute).toHaveBeenCalledWith("abc");
    });

    it("does nothing where the watch is off", async () => {
        const { d } = deps([], { on: () => false });
        expect(await runMute(d, { id: "abc" })).toEqual({ ok: false, errorKey: "logwatch.unavailable" });
        expect(d.mute).not.toHaveBeenCalled();
    });
});

describe("the card's helpers", () => {
    it("reads the card's id and the agent's details", () => {
        expect(readCardId({ id: "x1" })).toBe("x1");
        expect(readCardId({ id: 3 })).toBe("");
        expect(readCardId(null)).toBe("");
        expect(candidateDetails(Olivia)).toBe("Claude Code · Shop · shop");
        expect(candidateDetails(Paul)).toBe("");
        expect(askFailureKey("sent")).toBeNull();
        expect(askFailureKey("pick")).toBeNull();
    });
});

// The names the window and wavesrv share (pkg/molten/logwatch).
describe("the wire", () => {
    const route = readFileSync("pkg/molten/logwatch/route.go", "utf8");
    const card = readFileSync("pkg/molten/logwatch/card.go", "utf8");
    const watch = readFileSync("pkg/molten/logwatch/watch.go", "utf8");

    it("matches wavesrv's route, commands, gestures and statuses", () => {
        expect(route).toContain(`RouteId     = "${LogWatchRouteId}"`);
        expect(route).toContain(`AskCommand  = "${LogWatchAskCommand}"`);
        expect(route).toContain(`MuteCommand = "${LogWatchMuteCommand}"`);
        expect(card).toContain(`AskGesture    = "${LogWatchAskGesture}"`);
        expect(card).toContain(`MuteGesture   = "${LogWatchMuteGesture}"`);
        expect(card).toContain(`NotificationSource = "logwatch"`);
        for (const status of ["sent", "pick", "noagent", "gone", "unknown"]) {
            expect(watch).toContain(`= "${status}"`);
        }
    });
});

// AC13: every word of the watch exists in both languages with the same placeholders, and names no machine.
describe("the words", () => {
    const keys = [
        "logwatch.pick.title",
        "logwatch.pick.subtitle",
        "logwatch.pick.moltenterm",
        "logwatch.pick.send",
        "logwatch.pick.cancel",
        "logwatch.pick.agents",
        "logwatch.noAgent",
        "logwatch.gone",
        "logwatch.unknown",
        "logwatch.unavailable",
        "notif.source.logwatch",
        "featuresInTest.features.logwatch.label",
        "featuresInTest.features.logwatch.description",
        ...Object.keys(flatten((en as any).server.logwatch)).map((k) => `server.logwatch.${k}`),
    ];

    it("are in both languages", () => {
        expect(keys.length).toBeGreaterThan(30);
        for (const key of keys) {
            const english = lookup(en, key);
            const french = lookup(fr, key);
            expect(typeof english, key).toBe("string");
            expect(typeof french, key).toBe("string");
            expect(placeholders(french as string), key).toEqual(placeholders(english as string));
            expect(english as string, key).not.toMatch(/\b(mac|macos|finder|windows explorer)\b/i);
        }
    });
});

function flatten(node: any, prefix = ""): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(node ?? {})) {
        if (typeof v === "string") {
            out[prefix + k] = v;
        } else {
            Object.assign(out, flatten(v, `${prefix}${k}.`));
        }
    }
    return out;
}
