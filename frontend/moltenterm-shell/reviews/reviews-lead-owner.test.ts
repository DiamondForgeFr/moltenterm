// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #1779, FR-REV-022 AC19: Resume hands the work to the lead agent that owns it. Who owns it: the PR's signature, else
// the lead whose sub-agent built it, else nobody; the button names it, the menu keeps New agent.

import { describe, expect, it } from "vitest";
import { wordPhrase } from "../i18n/phrase";
import { CardInput, cardState, leadOf } from "./reviews-card-model";
import type { ReviewPr } from "./reviews-model";
import type { AgentBarFacts } from "./reviews-upcoming-model";

function draft(agents: ReviewPr["agents"] = []): ReviewPr {
    return {
        number: 1772,
        title: "Pinned views per project",
        url: "https://github.com/acme/app/pull/1772",
        branch: "feature/1760-pinned-views",
        base: "develop",
        headoid: "abc1234",
        createdat: "",
        updatedat: "",
        draft: true,
        merge: "clean",
        ci: { state: "success", success: 1, failure: 0, pending: 0, checks: [{ name: "Build", state: "success" }] },
        report: { state: "present" },
        unpublished: 0,
        agents,
    };
}

// A sub-agent of a lead, finished: it is the agent of the branch, not a live lead.
const SubOfArthur: AgentBarFacts = {
    kind: "subagent",
    agent: "claude",
    name: "",
    state: "done",
    since: 1,
    parentBlockId: "arthur-block",
    parentName: "Arthur",
};
const Jeanne: AgentBarFacts = { kind: "panel", blockId: "jeanne", name: "Jeanne", state: "idle", since: 1 };
const SignedByArthur = [{ firstname: "Arthur", agent: "Claude Code", model: "Opus 5.5" }];

function state(input: Partial<CardInput> & { pr: ReviewPr }) {
    return cardState({ agents: [], agentReadies: true, ...input });
}

describe("the lead agent that owns the work (#1779)", () => {
    it("is named by the PR's signature first", () => {
        expect(leadOf({ pr: draft(SignedByArthur), agents: [] })).toEqual({
            name: "Arthur",
            agent: undefined,
            agentName: "Claude Code",
            blockId: undefined,
            source: "signature",
        });
        const s = state({ pr: draft(SignedByArthur) });
        expect(s.kind).toBe("agent-finish");
        expect(wordPhrase(s.primary.label)).toBe("Resume Arthur");
        expect(s.lead?.name).toBe("Arthur");
        expect(s.menu.map((a) => `${a.id}:${wordPhrase(a.label)}`)).toContain("new-agent:New agent");
    });

    it("takes the newest signer with a first name, and skips an anonymous signature", () => {
        const agents = [{ agent: "Claude Code" }, { firstname: " Bruno ", agent: "Codex" }, ...SignedByArthur];
        expect(leadOf({ pr: draft(agents), agents: [] })).toMatchObject({ name: "Bruno", agentName: "Codex" });
        expect(leadOf({ pr: draft([{ agent: "Claude Code" }]), agents: [] })).toBeNull();
    });

    it("falls back to the lead whose sub-agent built it (the registry's parent session)", () => {
        const input = { pr: draft(), agents: [SubOfArthur] };
        expect(leadOf(input)).toEqual({ name: "Arthur", agent: "claude", blockId: "arthur-block", source: "subagent" });
        const s = state(input);
        expect(s.kind).toBe("agent-finish");
        expect(wordPhrase(s.primary.label)).toBe("Resume Arthur");
        const background: AgentBarFacts = { ...SubOfArthur, kind: "background", state: "background" };
        expect(leadOf({ pr: draft(), agents: [background] })).toMatchObject({ name: "Arthur", source: "subagent" });
    });

    it("keeps the signature's lead and adds the registry's terminal when it is the same lead", () => {
        expect(leadOf({ pr: draft(SignedByArthur), agents: [SubOfArthur] })).toEqual({
            name: "Arthur",
            agent: "claude",
            agentName: "Claude Code",
            blockId: "arthur-block",
            source: "signature",
        });
        const other = { ...SubOfArthur, parentBlockId: "bruno-block", parentName: "Bruno" };
        expect(leadOf({ pr: draft(SignedByArthur), agents: [other] })).toMatchObject({
            name: "Arthur",
            blockId: undefined,
            source: "signature",
        });
    });

    it("is nobody for a signed background agent, a panel agent or no agent at all", () => {
        const signed: AgentBarFacts = {
            kind: "background",
            name: "Salomé",
            state: "background",
            since: 1,
            signed: true,
        };
        expect(leadOf({ pr: draft(), agents: [signed, Jeanne] })).toBeNull();
        expect(leadOf({ pr: draft(), agents: [] })).toBeNull();
        const none = state({ pr: draft() });
        expect(none.lead).toBeNull();
        expect(wordPhrase(none.primary.label)).toBe("Resume an agent");
        expect(none.menu.map((a) => a.id)).not.toContain("new-agent");
    });

    it("is only Resume's: the other states name no lead", () => {
        const s = state({ pr: { ...draft(SignedByArthur), draft: false, merge: "conflicts" } });
        expect(s.kind).toBe("conflicts");
        expect(s.lead).toBeUndefined();
        expect(s.menu.map((a) => a.id)).not.toContain("new-agent");
    });
});
