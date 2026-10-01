// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoltenTrustModel, MoltenTrustRequest } from "./molten-trust";

function request(id: string): MoltenTrustRequest {
    return { id, name: id, version: "1.0.0", description: "", capabilities: [], path: `/cfg/mods/${id}` };
}

let model: MoltenTrustModel;

beforeEach(() => {
    MoltenTrustModel.resetInstance();
    model = MoltenTrustModel.getInstance();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("MoltenTrustModel", () => {
    it("shows one prompt at a time and resolves each with the user's answer", async () => {
        const first = model.ask(request("a"));
        const second = model.ask(request("b"));
        expect(globalStore.get(model.currentAtom).request.id).toBe("a");

        model.answer("trusted");
        await expect(first).resolves.toBe("trusted");
        expect(globalStore.get(model.currentAtom).request.id).toBe("b");

        model.answer("declined");
        await expect(second).resolves.toBe("declined");
        expect(globalStore.get(model.currentAtom)).toBeNull();
    });

    it("answers timeout when the user does not answer, and closes the prompt", async () => {
        vi.useFakeTimers();
        const answer = model.ask(request("slow"), 1000);
        await vi.advanceTimersByTimeAsync(1001);
        await expect(answer).resolves.toBe("timeout");
        expect(globalStore.get(model.currentAtom)).toBeNull();
    });

    it("ignores an answer once the prompt is settled", async () => {
        const answer = model.ask(request("a"));
        model.answer("declined");
        model.answer("trusted");
        await expect(answer).resolves.toBe("declined");
    });
});
