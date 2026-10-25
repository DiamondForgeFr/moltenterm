// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./release-setup-client", () => ({ setupRefine: vi.fn(), setupApply: vi.fn(), setupPrompt: vi.fn() }));

import { I18nModel } from "../i18n/i18n";
import type { SetupRefined } from "./release-setup-model";
import { AgentProposal, ProposalCards } from "./release-setup-proposal";

const refined: SetupRefined = {
    agent: "claude",
    agentname: "Claude Code",
    changes: [
        {
            key: "1",
            op: "add",
            channel: "public",
            id: "docs-build",
            after: "changelog-fr",
            step: { id: "docs-build", title: "Build the documentation", phase: "cut", run: "npm run docs:build" },
            why: "the docs must build before the cut",
            title: "Build the documentation",
            newtext: '{ "id": "docs-build" }',
        },
        { key: "2", op: "remove", channel: "rc", id: "sync-back", title: "Carry the release back", oldtext: "{}" },
        { key: "3", op: "versions", versions: { changelogs: ["docs/changelog.md"] }, oldtext: "{}", newtext: "{}" },
    ],
    rejected: [
        { text: '{"op":"ci"}', code: "outside", detail: "ci" },
        { text: '{"op":"versions","versions":{"notesagent":["sh"]}}', code: "command", detail: "notesagent" },
    ],
    proposed: "{}",
    errors: [],
    validatewarnings: [],
};

function cards(chosen: string[]) {
    return renderToStaticMarkup(
        <ProposalCards refined={refined} chosen={chosen} applying={false} onChoose={() => {}} onDrop={() => {}} />
    );
}

describe("the agent's step changes (#1099, FR-MC-039)", () => {
    afterEach(() => {
        I18nModel.getInstance().setLanguageSetting("en");
    });

    it("shows one card per change, ticked or not, and what was not offered with its reason", () => {
        const html = cards(["1", "3"]);
        expect(html).toContain("Agent proposal");
        expect(html).toContain("Claude Code proposes 3 changes.");
        expect(html).toContain("Ticked: 2 of 3.");
        expect(html).toContain("Build the documentation");
        expect(html).toContain("After changelog-fr");
        expect(html).toContain("the docs must build before the cut");
        expect(html).toContain("Files that carry the version");
        expect(html).toMatch(/data-testid="proposal-take-1"[^>]*checked=""|checked=""[^>]*data-testid="proposal-take-1"/);
        expect(html).not.toMatch(/checked=""[^>]*data-testid="proposal-take-2"/);
        expect(html).toContain("2 proposed changes are not offered");
        expect(html).toContain("Outside what the setup proposes (ci)");
        expect(html).toContain("notesagent names a program the release would run: change it yourself.");
        expect(html).toContain("Drop the proposal");
    });

    it("words the cards in French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const html = cards(["1"]);
        expect(html).toContain("Proposition de l’agent");
        expect(html).toContain("Claude Code propose 3 changements.");
        expect(html).toContain("Cochés : 1 sur 3.");
        expect(html).toContain("Après changelog-fr");
        expect(html).toContain("Ajoutée");
        expect(html).toContain("Retirée");
        expect(html).toContain("2 changements proposés ne sont pas retenus");
        expect(html).toContain("Écarter la proposition");
    });

    it("words a pasted answer as such, and says when nothing is proposed", () => {
        const html = renderToStaticMarkup(
            <ProposalCards
                refined={{ ...refined, agent: "", agentname: "", changes: [], rejected: [] }}
                chosen={[]}
                applying={false}
                onChoose={() => {}}
                onDrop={() => {}}
            />
        );
        expect(html).toContain("The pasted answer proposes no change to the draft.");
    });

    it("asks in the developer's words, and offers any other agent the same request", () => {
        const html = renderToStaticMarkup(
            <AgentProposal dir="/p" draftText="{}" onResult={() => {}} onBusy={() => {}} />
        );
        expect(html).toContain("Say it in your words");
        expect(html).toContain("Ask the agent for a proposal");
        expect(html).toContain("Read-only: it answers with step changes, never a whole file.");
        expect(html).toContain("Use another agent");
    });
});
