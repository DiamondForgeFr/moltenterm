// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The setup's agent board in the panel (FR-MC-045, #1163): the terminal agent's proposals show in place, live, as
// "proposed by" cards beside the channel they change; the sentences and the diagram mark the proposed step; once the
// developer accepts, the step reads as an ordinary one, and once declined it is gone.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { translate } from "../i18n/i18n-core";
import type { PipelineReleaseStep } from "./mission-model";
import type { SetupBoard } from "./release-setup-board";
import {
    acceptedBy,
    acceptedKeys,
    BoardItem,
    BoardState,
    boardSteps,
    channelItems,
    contextSignature,
    generalItems,
    keptFlags,
    previewDraft,
    stepMarks,
} from "./release-setup-board-model";
import type { SetupDraft, SetupOptions } from "./release-setup-model";
import { PlainFlowScreen } from "./release-setup-plain";
import { plainChannels } from "./release-setup-plain-model";
import type { SetupSurvey } from "./release-setup-stepper";

const release = {
    rc: [
        { id: "prepare", title: "Prepare", phase: "prepare", run: "molten release prepare {tag}" },
        { id: "tag", title: "Tag", phase: "cut", confirm: "Pushes {tag}.", run: "molten release tag {tag}" },
    ],
    public: [
        { id: "prepare", title: "Prepare", phase: "prepare", run: "molten release prepare {tag}" },
        { id: "tag", title: "Tag", phase: "cut", confirm: "Pushes {tag}.", run: "molten release tag {tag}" },
        { id: "close-milestone", title: "Close", phase: "publish", run: "molten release close-milestone {tag}" },
    ],
} as { rc: PipelineReleaseStep[]; public: PipelineReleaseStep[] };

const docsCheck = {
    id: "docs-check",
    title: "Check the documentation site",
    phase: "cut",
    manual: "Open the documentation site and check the new version's pages.",
};

const options = {
    kind: "on-premise",
    channels: ["rc", "public"],
    branchmodel: "promote",
    merge: "merge",
    tagprefix: "v",
    rcformat: "numeric",
    changelogs: [],
    ciworkflows: [],
    dispatch: [],
    notes: false,
    notespath: "",
    syncback: false,
    milestone: true,
    manual: [],
    environments: [],
    labels: [],
} as unknown as SetupOptions;

const survey = {
    apptype: "cli",
    kind: "on-premise",
    tags: { read: true, prefix: "v", count: 2, last: "v1.0.1", pre: 1, lastpublic: "v1.0.1" },
    pipeline: "complete",
} as unknown as SetupSurvey;

function pipelineText(rel: object): string {
    return JSON.stringify({ schema: 1, name: "fixture", versions: { tagprefix: "v" }, release: rel }, null, 2);
}

const draft = {
    provider: "moltenterm",
    warnings: [],
    facts: {
        name: "fixture",
        branches: { trunk: "develop", release: "main" },
        tagprefix: "v",
        changelogs: [],
        workflows: [],
        targets: [],
        labels: [],
    },
    defaults: options,
    options,
    tagworkflows: { rc: [], public: [] },
    tagci: { rc: [], public: [] },
    proposal: { sources: {} },
    current: pipelineText(release),
    base: "h",
    proposed: pipelineText(release),
    errors: [],
    validatewarnings: [],
    pr: null,
} as unknown as SetupDraft;

const withDocs = { ...release, public: [release.public[0], release.public[1], docsCheck, release.public[2]] };

const add: BoardItem = {
    key: "1",
    kind: "change",
    state: "open",
    by: "Olivia",
    at: 1,
    why: "Vous vérifiez le site à la main après chaque version.",
    change: { key: "1", op: "add", channel: "public", id: "docs-check", after: "tag", title: docsCheck.title },
};

const flag: BoardItem = {
    key: "2",
    kind: "flag",
    state: "open",
    by: "Olivia",
    at: 2,
    step: "public/tag",
    point: "Faut-il une approbation avant de marquer la version ?",
    answer: "Non, la confirmation suffit.",
};

const general: BoardItem = { key: "3", kind: "flag", state: "open", at: 3, point: "Le jalon est-il utilisé ?" };

function stateOf(items: BoardItem[], preview: string, explain?: BoardState["explain"]): BoardState {
    const marks: BoardState["marks"] = {};
    for (const it of items) {
        if (it.kind === "change" && it.state === "open" && it.change?.op !== "versions") {
            marks[`${it.change.channel}/${it.change.id}`] = { key: it.key, op: it.change.op as "add" };
        }
    }
    return { dir: "/p", open: true, steps: [], items, preview, marks, explain, seq: 1 };
}

function boardOf(state: BoardState, decided: string[] = []): SetupBoard {
    return {
        state,
        error: null,
        busy: null,
        publish: () => {},
        decide: (key, accept) => decided.push(`${key}:${accept}`),
        copy: (key) => decided.push(`${key}:copy`),
    };
}

function render(board: SetupBoard): string {
    return renderToStaticMarkup(
        <PlainFlowScreen
            survey={survey}
            draft={draft}
            projectName="fixture"
            onDescribe={() => {}}
            onAdjust={() => {}}
            onConfirm={() => {}}
            canConfirm
            board={board}
        />
    );
}

const fr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);

describe("the setup's agent board (FR-MC-045)", () => {
    it("shows an open proposal in place: the step marked in the sentences and the diagram, its card beside", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const state = stateOf([add, flag, general], pipelineText(withDocs));
        const html = render(boardOf(state));
        expect(html.match(/data-testid="plain-step-public-/g)).toHaveLength(4);
        expect(html).toMatch(
            /data-testid="plain-step-public-3"[^>]*data-mark="add"|data-mark="add"[^>]*data-testid="plain-step-public-3"/
        );
        expect(html).toContain("proposée");
        expect(html).toContain('data-testid="setup-diagram-proposed-add"');
        expect(html).toContain('data-testid="board-cards-public"');
        expect(html).toContain("Proposé par Olivia");
        expect(html).toContain('data-testid="plain-step-proposal"');
        expect(html).toContain("Vous vérifiez le site à la main après chaque version.");
        expect(html).toContain("Réponse proposée\u00a0: Non, la confirmation suffit.");
        expect(html).toContain("Étape 2");
        expect(html).toContain('data-testid="board-accept"');
        expect(html).toContain('data-testid="board-decline"');
        expect(html).toContain('data-testid="board-section"');
        expect(html).toContain("Le jalon est-il utilisé ?");
    });

    it("shows a step change as before and after on the step, with the agent's words and the other version's offer", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const manual = { id: "changelog-en", title: "Write the changelog", phase: "cut", manual: "Write it." };
        const auto = {
            id: "changelog-en",
            title: "Draft the changelog from the merged tickets",
            phase: "cut",
            confirm: "Check the note.",
            run: "molten release notes {tag}",
        };
        const withManual = {
            rc: [release.rc[0], manual, release.rc[1]],
            public: [release.public[0], manual, ...release.public.slice(1)],
        };
        const changed = { ...withManual, rc: [release.rc[0], auto, release.rc[1]] };
        const say =
            "La note est rédigée automatiquement à partir des tickets fusionnés ; vous la relisez et la validez.";
        const change: BoardItem = {
            key: "5",
            kind: "change",
            state: "open",
            by: "Marion",
            at: 5,
            why: "Vous ne l’écrivez plus vous-même.",
            say,
            who: "validate",
            change: { key: "5", op: "change", channel: "rc", id: "changelog-en", title: auto.title },
        };
        const state = { ...stateOf([change], pipelineText(changed)), base: pipelineText(withManual) };
        const decided: string[] = [];
        const html = render(boardOf(state, decided));
        expect(html).toContain('data-testid="plain-step-before"');
        expect(html).toMatch(/line-through[^>]*>Vous, à la main</);
        expect(html).toContain(say);
        expect(html).toContain("Vous validez");
        expect(html).toContain("Proposé par Marion");
        expect(html).toContain("Vous ne l’écrivez plus vous-même.");
        expect(html).toContain("Appliquer aussi à la version publique");
        expect(html).toContain('data-proposed="change"');
        expect(html).not.toContain('data-testid="board-card-5"');
        const accepted = { ...state, items: [{ ...change, state: "accepted" as const }], marks: {} };
        const after = render(boardOf(accepted));
        expect(after).toContain(say);
        expect(after).not.toContain('data-testid="plain-step-before"');
        expect(after).not.toContain("Appliquer aussi");
    });

    it("reads an accepted change as an ordinary step, and a declined one is gone", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const accepted = render(boardOf(stateOf([{ ...add, state: "accepted" }], pipelineText(withDocs))));
        expect(accepted.match(/data-testid="plain-step-public-/g)).toHaveLength(4);
        expect(accepted).not.toContain("data-mark=");
        expect(accepted).not.toContain("setup-diagram-proposed");
        expect(accepted).not.toContain("board-card-");
        const declined = render(boardOf(stateOf([{ ...add, state: "declined" }], pipelineText(release))));
        expect(declined.match(/data-testid="plain-step-public-/g)).toHaveLength(3);
        expect(declined).not.toContain("board-card-");
    });

    it("lights the explained step with the molten glow and the agent's words", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const state = stateOf([], pipelineText(release), {
            channel: "rc",
            n: 2,
            ids: ["tag"],
            note: "C’est ici que la candidate est marquée.",
            by: "Olivia",
            at: 1,
        });
        const html = render(boardOf(state));
        expect(html).toMatch(/class="[^"]*mt-glow[^"]*"[^>]*data-testid="plain-step-rc-2"/);
        expect(html).toContain("Olivia explique cette étape");
        expect(html).toContain("C’est ici que la candidate est marquée.");
        expect(html.match(/mt-glow/g).length).toBeGreaterThanOrEqual(2);
    });

    it("speaks English too", () => {
        I18nModel.getInstance().setLanguageSetting("en");
        const html = render(boardOf(stateOf([add, flag], pipelineText(withDocs))));
        expect(html).toContain("Proposed by Olivia");
        expect(html).toContain(">Accept<");
        expect(html).toContain("Proposed answer: Non, la confirmation suffit.");
        expect(html).toContain(">Accept<");
        I18nModel.getInstance().setLanguageSetting("fr");
    });

    it("models the board for the panel and the agent", () => {
        const state = stateOf([add, flag, general, { ...add, key: "4", state: "accepted", by: "Olivia" }], "x");
        expect(channelItems(state, "public").map((i) => i.key)).toEqual(["1", "2"]);
        expect(channelItems(state, "rc")).toEqual([]);
        expect(generalItems(state).map((i) => i.key)).toEqual(["3"]);
        expect(acceptedKeys(state)).toEqual(["4"]);
        expect(acceptedBy(state)).toBe("Olivia");
        expect(keptFlags({ ...state, items: [{ ...flag, state: "kept" }] })).toHaveLength(1);
        expect(previewDraft(draft, { ...state, items: [flag] })).toBe(draft);
        expect(previewDraft(draft, stateOf([add], "PREVIEW")).current).toBe("PREVIEW");
        const shown = previewDraft(draft, stateOf([add], pipelineText(withDocs)));
        const channels = plainChannels(survey, shown);
        const pub = channels.find((c) => c.channel === "public");
        expect([...stepMarks(pub, stateOf([add], "")).entries()]).toEqual([[3, { key: "1", op: "add" }]]);
        const steps = boardSteps(channels, fr);
        expect(steps.filter((s) => s.channel === "public").map((s) => `${s.n}:${s.ids.join(",")}`)).toEqual([
            "1:prepare",
            "2:tag",
            "3:docs-check",
            "4:close-milestone",
        ]);
        expect(steps.every((s) => s.text.length > 0)).toBe(true);
        const ctx = { dir: "/p", screen: "understand", text: "t", steps };
        expect(contextSignature(ctx)).toBe(contextSignature({ ...ctx, steps: [...steps] }));
        expect(contextSignature(ctx)).not.toBe(contextSignature({ ...ctx, screen: "prepare" }));
    });
});
