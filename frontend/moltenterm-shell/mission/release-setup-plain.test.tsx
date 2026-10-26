// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Your way of publishing" (FR-MC-044, #1151): SaaSFoundryAI's committed pipeline (a copy of its .molten/project.json
// release block), a single-branch project and a custom step, told in plain words; the diagram's numbers are the
// sentences'; no sentence holds a path, a command or a placeholder.

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { translate } from "../i18n/i18n-core";
import type { PipelineReleaseStep } from "./mission-model";
import type { SetupCheck, SetupDraft, SetupOptions } from "./release-setup-model";
import { PlainFlowScreen } from "./release-setup-plain";
import {
    plainChanges,
    plainChannel,
    plainChannels,
    plainExamples,
    plainFlowModel,
    PlainStep,
    stepText,
} from "./release-setup-plain-model";
import type { SetupSurvey } from "./release-setup-stepper";

// The release block of SaaSFoundryAI's .molten/project.json (read-only copy, 2026-10-26).
const saasFoundryRelease = {
    rc: [
        {
            id: "prepare",
            title: "Bump the version and draft the notes on rc-X.Y.Z, made from develop",
            phase: "prepare",
            run: "molten release prepare {tag} --pr",
        },
        {
            id: "changelog-en",
            title: "Write the {version} section of docs/changelog.md",
            phase: "cut",
            manual: "In the release worktree (../SaaSFoundry-release, prepared on the RC branch rc-X.Y.Z made from develop), write the {version} section of docs/changelog.md. The cut commits it with the version.",
        },
        {
            id: "changelog-fr",
            title: "Write the {version} section of docs/fr/changelog.md",
            phase: "cut",
            manual: "In the release worktree (../SaaSFoundry-release, prepared on the RC branch rc-X.Y.Z made from develop), write the {version} section of docs/fr/changelog.md. The cut commits it with the version.",
        },
        {
            id: "tag",
            title: "Commit the candidate on rc-X.Y.Z and tag it there",
            phase: "cut",
            confirm:
                "Pushes rc-X.Y.Z with the release commit of {tag} and the tag on its head. No publish workflow starts on the tag (test.yml runs on it), and nothing reaches master or develop.",
            run: "molten release tag {tag} --rc-branch",
        },
    ],
    public: [
        {
            id: "prepare",
            title: "Bump the version and draft the notes on rc-X.Y.Z, made from develop",
            phase: "prepare",
            run: "molten release prepare {tag} --pr",
        },
        {
            id: "reconcile",
            title: "Reconcile master into rc-X.Y.Z when they diverged (merge -s ours; nothing to do otherwise)",
            phase: "prepare",
            run: "molten release reconcile {tag}",
        },
        {
            id: "changelog-en",
            title: "Write the {version} section of docs/changelog.md",
            phase: "cut",
            manual: "In the release worktree (../SaaSFoundry-release, prepared on the RC branch rc-X.Y.Z made from develop), write the {version} section of docs/changelog.md. The cut commits it with the version.",
        },
        {
            id: "changelog-fr",
            title: "Write the {version} section of docs/fr/changelog.md",
            phase: "cut",
            manual: "In the release worktree (../SaaSFoundry-release, prepared on the RC branch rc-X.Y.Z made from develop), write the {version} section of docs/fr/changelog.md. The cut commits it with the version.",
        },
        {
            id: "open-pr",
            title: "Commit the release on rc-X.Y.Z and open its pull request to master",
            phase: "cut",
            confirm: "Pushes rc-X.Y.Z with the release commit of {tag} and opens its pull request to master.",
            run: "molten release open-pr {tag}",
        },
        {
            id: "merge-pr",
            title: "Merge the pull request into master once CI / Required gate is green",
            phase: "cut",
            confirm:
                "Merges the pull request of {tag} into master with a merge commit once CI / Required gate is green.",
            run: "molten release merge-pr {tag} --method merge",
        },
        {
            id: "tag",
            title: "Tag the merge commit and push the tag: publish-stable.yml starts on the tag",
            phase: "cut",
            confirm:
                "{tag} is public once pushed: publish-stable.yml starts on the tag, and the environment npm-production asks for an approval on GitHub.",
            run: "molten release tag {tag}",
        },
        {
            id: "close-milestone",
            title: "Close the milestone once the release is published",
            phase: "publish",
            run: "molten release close-milestone {tag}",
        },
        {
            id: "dispatch-deploy-docs",
            title: "Run Deploy Documentation at {tag}",
            phase: "publish",
            run: "molten release dispatch deploy-docs.yml --ref {tag}",
        },
        {
            id: "sync-back",
            title: "Merge master back into develop with a merge commit",
            phase: "back",
            confirm:
                "Opens the pull request of master (at {tag}) into develop and merges it with a merge commit once its checks are green, never squash or rebase: master must become part of develop's history, or the branches diverge again.",
            run: "molten release sync-back {tag} --merge",
        },
    ],
} as { rc: PipelineReleaseStep[]; public: PipelineReleaseStep[] };

const options: SetupOptions = {
    kind: "on-premise",
    channels: ["rc", "public"],
    branchmodel: "rcpr",
    merge: "merge",
    tagprefix: "v",
    rcformat: "numeric",
    changelogs: ["docs/changelog.md", "docs/fr/changelog.md"],
    ciworkflows: [],
    dispatch: [{ workflow: "deploy-docs.yml", channel: "public" }],
    notes: false,
    notespath: "releases/{tag}.md",
    syncback: true,
    milestone: true,
    manual: [],
    environments: [],
    reconcile: true,
    labels: [],
};

const survey: SetupSurvey = {
    apptype: "cli",
    apptypeevidence: [],
    kind: "on-premise",
    tags: { read: true, prefix: "v", count: 8, last: "v1.0.1", pre: 3, lastpublic: "v1.0.1", lastmerge: true },
    releases: { ongithub: true, read: true, count: 2, last: "v1.0.1" },
    publish: [],
    changelogs: [],
    pipeline: "complete",
    missing: [],
    ships: true,
    recommended: "analyse",
    base: "h",
};

function makeDraft(over: Partial<SetupDraft> = {}, release: object = saasFoundryRelease): SetupDraft {
    return {
        provider: "moltenterm",
        warnings: [],
        facts: {
            name: "SaaSFoundryAI",
            haspipeline: true,
            missing: [],
            branches: { trunk: "develop", release: "master" },
            rcbranchpattern: "rc-{version}",
            tagprefix: "v",
            versionsdeclared: true,
            versionsource: { code: "versionsDeclared" },
            notesdeclared: false,
            notespath: "releases/{tag}.md",
            notesfound: true,
            changelogs: [
                { path: "docs/changelog.md", lang: "en" },
                { path: "docs/fr/changelog.md", lang: "fr" },
            ],
            workflows: [
                { file: "test.yml", push: true, pullrequest: true, dispatch: false, role: "ci" },
                {
                    file: "publish-stable.yml",
                    push: true,
                    dispatch: false,
                    environments: ["npm-production"],
                    role: "publish",
                    ships: ["npm", "githubrelease"],
                },
                {
                    file: "deploy-docs.yml",
                    name: "Deploy Documentation",
                    push: false,
                    dispatch: true,
                    role: "docs",
                    ships: ["pages"],
                },
            ],
            targets: [],
            ongithub: true,
            kind: "on-premise",
            kindevidence: [],
            saasfoundry: true,
            ticketbranches: true,
            releaseworktree: "../SaaSFoundry-release",
            currentversion: "1.0.1",
            labels: [],
            protection: {
                branch: "master",
                read: true,
                pullrequest: true,
                requiredchecks: ["CI / Required gate"],
                strict: true,
                noforcepush: true,
                restrictupdates: false,
                mergemethods: ["merge"],
                bypass: "never",
                sources: [],
            },
        },
        defaults: options,
        options,
        rcformats: [],
        branchmodels: [],
        merges: [],
        deploytargets: [],
        tagworkflows: { rc: [], public: [{ file: "publish-stable.yml", environments: ["npm-production"] }] },
        tagci: { rc: ["test.yml"], public: ["test.yml"] },
        proposal: { sources: { "public/tag": { code: "finalizeWorkflows", path: "publish-stable.yml" } } },
        current: JSON.stringify({ schema: 1, name: "SaaSFoundryAI", versions: { tagprefix: "v" }, release }),
        base: "h",
        proposed: "",
        errors: [],
        validatewarnings: [],
        pr: null,
        ...over,
    };
}

const fr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

function summary(steps: PlainStep[]) {
    return steps.map((s) => `${s.n}:${s.kind}:${s.who}${s.ifNeeded ? ":ifNeeded" : ""}${s.yours ? ":yours" : ""}`);
}

const Forbidden = [
    /\{[^}]*\}/,
    /molten release/,
    /\.(yml|yaml|json|md)\b/,
    /[\w.-]+\/[\w.-]+\//,
    /npm-production/,
    /X\.Y\.Z/,
];

function textOf(html: string): string {
    return html
        .replace(/<title>[\s\S]*?<\/title>/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&amp;/g, "&");
}

describe("Your way of publishing (FR-MC-044)", () => {
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    const draft = makeDraft();
    const [rc, pub] = plainChannels(survey, draft);

    it("uses the next real version in the project's numbering", () => {
        expect(plainExamples(survey, draft)).toEqual({ prefix: "v", version: "1.1.0", candidate: "1.1.0-1" });
        const rcdot = makeDraft({ options: { ...options, rcformat: "rcdot" } });
        expect(plainExamples(survey, rcdot).candidate).toBe("1.1.0-rc.1");
    });

    it("tells SaaSFoundryAI's release candidate in three steps", () => {
        expect(rc.channel).toBe("rc");
        expect(summary(rc.steps)).toEqual(["1:prepare:molten", "2:changelog:you", "3:tag:confirm"]);
        expect(rc.steps[1].ids).toEqual(["changelog-en", "changelog-fr"]);
        expect(rc.steps.map((s) => stepText(fr, s))).toEqual([
            "On part de develop et on crée la version candidate, par exemple 1.1.0-1, avec le nouveau numéro partout où il apparaît.",
            "Vous écrivez ce qui change dans le journal des changements, en anglais et en français.",
            "On marque la version candidate, v1.1.0-1. Rien n’est publié : ni master ni develop ne bougent.",
        ]);
    });

    it("tells SaaSFoundryAI's public release in eight steps", () => {
        expect(summary(pub.steps)).toEqual([
            "1:prepare:molten",
            "2:reconcile:molten:ifNeeded",
            "3:changelog:you",
            "4:validation:confirm",
            "5:tag:approve",
            "6:milestone:molten",
            "7:docs:molten",
            "8:syncback:confirm",
        ]);
        expect(pub.steps[3].ids).toEqual(["open-pr", "merge-pr"]);
        const said = pub.steps.map((s) => stepText(fr, s));
        expect(said[3]).toBe(
            "La version est proposée à master par une demande de validation. Elle n’est acceptée qu’une fois toutes les vérifications obligatoires passées."
        );
        expect(said[4]).toBe(
            "On marque la version publique, v1.1.0. C’est ce qui lance la publication sur npm et GitHub Release, qui attend votre approbation."
        );
        expect(said[6]).toBe("Le site de documentation est mis en ligne pour cette version.");
        expect(said[7]).toBe(
            "master revient dans develop, pour que la prochaine version parte de ce qui a été publié."
        );
        expect(stepText(en, pub.steps[2])).toBe("You write what is new in the changelog, in English and in French.");
    });

    it("numbers the diagram's nodes with the steps, the publication beside its step", () => {
        const ctx = { draft, examples: plainExamples(survey, draft) };
        for (const plain of [rc, pub]) {
            const model = plainFlowModel(plain, ctx, fr);
            const badges = model.nodes.filter((n) => n.badge != null).map((n) => n.badge);
            expect(badges).toEqual(plain.steps.map((s) => s.n));
            for (const node of model.nodes) {
                expect(node.point).toMatch(/^step-\d+$/);
            }
        }
        const model = plainFlowModel(pub, ctx, fr);
        const targets = model.nodes.filter((n) => n.kind === "target");
        expect(targets.map((n) => [n.label, n.point, n.approval])).toEqual([
            ["npm", "step-5", "yes"],
            ["GitHub Release", "step-5", "yes"],
        ]);
        expect(model.viaPr).toBe(true);
        expect(model.rcBranch).toBe("rc-1.1.0");
        expect(model.nodes.find((n) => n.badge === 4).kind).toBe("pr");
        expect(model.nodes.find((n) => n.badge === 4).label).toBe("validation");
    });

    it("tells a single-branch project and a custom step", () => {
        const steps = [
            { id: "prepare", title: "Bump the version", phase: "prepare", run: "molten release prepare {tag}" },
            { id: "changelog-en", title: "Write CHANGELOG.md", manual: "Write the {version} section of CHANGELOG.md." },
            { id: "smoke", title: "Run the smoke test on {tag}", phase: "cut", run: "./scripts/smoke.sh {tag}" },
            { id: "check-store", title: "Check the store listing for {version}", manual: "Open the store and look." },
            {
                id: "finalize",
                title: "Commit, tag and push",
                phase: "cut",
                confirm: "Pushes {tag}.",
                run: "molten release finalize {tag}",
            },
        ] as PipelineReleaseStep[];
        const single = makeDraft(
            {
                options: { ...options, branchmodel: "single", channels: ["public"] },
                facts: {
                    ...makeDraft().facts,
                    branches: { trunk: "main", release: "main" },
                    changelogs: [{ path: "CHANGELOG.md", lang: "en" }],
                },
                tagworkflows: { rc: [], public: [] },
            },
            { public: steps }
        );
        const channels = plainChannels(survey, single);
        expect(channels.map((c) => c.channel)).toEqual(["public"]);
        const [plain] = channels;
        expect(summary(plain.steps)).toEqual([
            "1:prepare:molten",
            "2:changelog:you",
            "3:custom:molten:yours",
            "4:custom:you:yours",
            "5:tag:confirm",
        ]);
        expect(plain.steps.map((s) => stepText(fr, s))).toEqual([
            "Sur main, on prépare la version, par exemple 1.1.0, avec le nouveau numéro partout où il apparaît.",
            "Vous écrivez les nouveautés dans le journal des changements, en anglais.",
            "Run the smoke test on v1.1.0",
            "Check the store listing for 1.1.0",
            "On enregistre la version et on la marque, v1.1.0.",
        ]);
        const model = plainFlowModel(plain, { draft: single, examples: plainExamples(survey, single) }, fr);
        expect(model.single).toBe(true);
        expect(model.nodes.map((n) => n.badge)).toEqual([1, 2, 3, 4, 5]);
        expect(model.nodes[3].kind).toBe("manual");
    });

    it("says what changed since last time in sentences", () => {
        const check = {
            state: "update",
            changes: [
                {
                    key: "public/sync-back",
                    channel: "public",
                    id: "sync-back",
                    kind: "added",
                    after: JSON.stringify(saasFoundryRelease.public[9]),
                    customised: false,
                    take: true,
                },
                { key: "versions", kind: "versions", before: "{}", after: "{}", customised: false, take: true },
            ],
        } as unknown as SetupCheck;
        const changes = plainChanges(check, survey, draft);
        expect(changes.map((c) => c.kind)).toEqual(["added", "versions"]);
        expect(stepText(fr, changes[0].step)).toBe(
            "master revient dans develop, pour que la prochaine version parte de ce qui a été publié."
        );
        expect(plainChanges({ ...check, state: "uptodate" }, survey, draft)).toEqual([]);
    });

    for (const lang of ["fr", "en"]) {
        it(`renders no path, command or placeholder, technical details closed (${lang})`, () => {
            I18nModel.getInstance().setLanguageSetting(lang);
            const html = renderToStaticMarkup(
                <PlainFlowScreen
                    survey={survey}
                    draft={draft}
                    projectName="SaaSFoundryAI"
                    onDescribe={() => {}}
                    onAdjust={() => {}}
                    onConfirm={() => {}}
                    canConfirm
                    allChoices={<span>ALL-CHOICES</span>}
                />
            );
            const text = textOf(html);
            for (const re of Forbidden) {
                expect(text).not.toMatch(re);
            }
            expect(html).not.toContain("ALL-CHOICES");
            expect(html).toContain('data-testid="plain-technical"');
            expect(html).not.toMatch(/<details[^>]*open/);
            expect(text).toContain(lang === "fr" ? "Votre façon de publier" : "Your way of publishing");
            expect(text).toContain(lang === "fr" ? "Voir les détails techniques" : "Show the technical details");
            expect(text).toContain(lang === "fr" ? "C’est bien ça" : "That's right");
            expect(html.match(/data-testid="plain-step-rc-/g)).toHaveLength(3);
            expect(html.match(/data-testid="plain-step-public-/g)).toHaveLength(8);
        });
    }

    it("hands each step to the Question slot with its number, topic and sentence", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const asked: string[] = [];
        renderToStaticMarkup(
            <PlainFlowScreen
                survey={survey}
                draft={draft}
                projectName="SaaSFoundryAI"
                onDescribe={() => {}}
                onAdjust={() => {}}
                onConfirm={() => {}}
                canConfirm
                question={(s) => {
                    asked.push(`${s.channel}/${s.number}/${s.kind}`);
                    return null;
                }}
            />
        );
        expect(asked).toContain("rc/1/rc");
        expect(asked).toContain("public/5/approval");
        expect(asked).toContain("public/8/syncback");
    });

    it("tells a step alone the same way", () => {
        const ctx = { draft, examples: plainExamples(survey, draft) };
        const alone = plainChannel([saasFoundryRelease.public[7]], "public", ctx);
        expect(stepText(fr, alone.steps[0])).toBe("Le jalon de la version est fermé.");
    });
});
