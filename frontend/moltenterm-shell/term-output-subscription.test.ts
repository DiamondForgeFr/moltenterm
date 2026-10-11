// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

// Terminal output fan-out (FR-PERF-010, #456): getFileSubject in frontend/app/store/wps.ts subscribes the tab view to
// its block's output only while a terminal holds the subject.

const rpc = vi.hoisted(() => ({ subs: [] as any[], unsubs: [] as string[] }));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        EventSubCommand: (_client: any, req: SubscriptionRequest) => rpc.subs.push(structuredClone(req)),
        EventUnsubCommand: (_client: any, eventType: string) => rpc.unsubs.push(eventType),
    },
}));

import { getFileSubject, handleWaveEvent } from "@/app/store/wps";

function lastBlockFileSub(): SubscriptionRequest {
    return rpc.subs.filter((s) => s.event === "blockfile").at(-1);
}

function appendEvent(blockId: string, filename: string, text: string): WaveEvent {
    return {
        event: "blockfile",
        scopes: [`block:${blockId}`],
        data: { zoneid: blockId, filename, fileop: "append", data64: text },
    } as WaveEvent;
}

describe("block file subscription", () => {
    beforeEach(() => {
        rpc.subs.length = 0;
        rpc.unsubs.length = 0;
    });

    it("subscribes to the block's scope only, never to all scopes", () => {
        const a = getFileSubject("aaa", "term");
        const b = getFileSubject("bbb", "term");
        const sub = lastBlockFileSub();
        expect(sub.allscopes).toBe(false);
        expect(sub.scopes.sort()).toEqual(["block:aaa", "block:bbb"]);
        a.release();
        expect(lastBlockFileSub().scopes).toEqual(["block:bbb"]);
        b.release();
        expect(rpc.unsubs).toContain("blockfile");
    });

    it("delivers a block's output to its subject only, filtered by file name", () => {
        const term = getFileSubject("ccc", "term");
        const cache = getFileSubject("ccc", "cache:term:full");
        const other = getFileSubject("ddd", "term");
        const seen: string[] = [];
        term.subscribe((d) => seen.push("term:" + d.data64));
        cache.subscribe((d) => seen.push("cache:" + d.data64));
        other.subscribe((d) => seen.push("other:" + d.data64));
        handleWaveEvent(appendEvent("ccc", "term", "x"));
        handleWaveEvent(appendEvent("ddd", "term", "y"));
        expect(seen).toEqual(["term:x", "other:y"]);
        term.release();
        cache.release();
        other.release();
    });

    it("keeps the subscription while another terminal still holds the subject", () => {
        const first = getFileSubject("eee", "term");
        const second = getFileSubject("eee", "term");
        expect(first).toBe(second);
        const seen: string[] = [];
        second.subscribe((d) => seen.push(d.data64));
        first.release();
        expect(lastBlockFileSub().scopes).toContain("block:eee");
        handleWaveEvent(appendEvent("eee", "term", "still"));
        expect(seen).toEqual(["still"]);
        second.release();
        handleWaveEvent(appendEvent("eee", "term", "after"));
        expect(seen).toEqual(["still"]);
    });
});
