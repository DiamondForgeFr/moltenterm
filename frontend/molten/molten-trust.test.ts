// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoltenClaudeCodePartWarning, MoltenTrustModel, MoltenTrustRequest, moltenTrustWording } from "./molten-trust";

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

describe("moltenTrustWording", () => {
    const part = { folder: "agents/claude-code", targetVersion: "2.1.289" };

    it("keeps the mod wording for a mod without a Claude Code part", () => {
        const wording = moltenTrustWording(request("a"));
        expect(wording.title).toBe("Trust the mod “a”?");
        expect(wording.intro).not.toContain("Claude Code");
        expect(wording.okLabel).toBe("Trust and enable");
    });

    it("tells that a Claude Code part runs inside Claude Code", () => {
        const wording = moltenTrustWording({ ...request("band"), claudeCodePart: part });
        expect(wording.title).toBe("Trust the mod “band”?");
        expect(wording.intro).toContain(MoltenClaudeCodePartWarning);
    });

    it("asks about the part alone for a mod trusted before it had one", () => {
        const wording = moltenTrustWording({ ...request("band"), claudeCodePart: part, partsOnly: true });
        expect(wording.title).toBe("Trust the Claude Code part of “band”?");
        expect(wording.intro).toContain("Declining keeps the rest of the mod running");
        expect(wording.okLabel).toBe("Trust the part");
    });
});
