// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { translate } from "../i18n/i18n-core";
import { DescribeStep } from "./release-setup-describe";
import type { SetupDraft, SetupOptions } from "./release-setup-model";
import { TemplateChoices, TemplateSave, TemplateStep } from "./release-setup-template";
import {
    canSaveTemplate,
    defaultNameParts,
    flowSummary,
    flowToSave,
    needText,
    orderedFits,
    rcOf,
    SetupTemplateFit,
    templateBlanks,
} from "./release-setup-template-model";

const base: SetupOptions = {
    kind: "on-premise",
    channels: ["rc", "public"],
    branchmodel: "promote",
    merge: "merge",
    tagprefix: "v",
    rcformat: "numeric",
    changelogs: ["CHANGELOG.md"],
    ciworkflows: ["test.yml"],
    dispatch: [],
    notes: false,
    notespath: "releases/{tag}.md",
    syncback: true,
    milestone: true,
    manual: [{ id: "check-store", title: "Check the store page", text: "Open the store." }],
    environments: [],
    reconcile: false,
    labels: [],
};

function draftOf(options: SetupOptions, extra?: Partial<SetupDraft>): SetupDraft {
    return {
        provider: "moltenterm",
        warnings: [],
        facts: {
            name: "invoice-cli",
            haspipeline: false,
            missing: ["rc", "public"],
            branches: { trunk: "develop", release: "main" },
            tagprefix: "v",
            versionsdeclared: false,
            versionsource: { code: "versionPackage", path: "package.json" },
            notesdeclared: false,
            notespath: "releases/{tag}.md",
            notesfound: false,
            changelogs: [{ path: "CHANGELOG.md", lang: "en" }],
            workflows: [
                { file: "publish.yml", push: true, tags: ["v*"], dispatch: false, role: "publish", ships: ["npm"] },
            ],
            targets: [{ id: "npm", packager: "npm", source: { code: "targetNpm", path: "package.json" } }],
            ongithub: true,
            kind: "on-premise",
            kindevidence: [],
            saasfoundry: false,
            ticketbranches: false,
            releaseworktree: "../invoice-cli-release",
            labels: [],
        },
        defaults: base,
        options,
        rcformats: [],
        branchmodels: [],
        merges: [],
        deploytargets: [],
        tagworkflows: {
            rc: [{ file: "publish.yml", environments: [] }],
            public: [{ file: "publish.yml", environments: [] }],
        },
        proposal: {
            release: {
                rc: [{ id: "finalize", title: "Cut", phase: "cut", run: "molten release finalize {tag}" }],
                public: [{ id: "finalize", title: "Cut", phase: "cut", run: "molten release finalize {tag}" }],
            },
            sources: {},
        },
        current: "",
        base: "",
        proposed: "{}\n",
        errors: [],
        validatewarnings: [],
        files: [],
        branchnames: ["develop", "main"],
        pr: {
            git: true,
            ref: "origin/develop",
            commit: "abc",
            target: "develop",
            ongithub: true,
            ticketrequired: false,
            branch: "chore/release-pipeline",
            subject: "chore: set up the release pipeline",
            tickettitle: "",
            uncommitted: false,
            included: false,
            localbase: "",
        },
        ...extra,
    };
}

function form(extra?: Partial<TemplateSave>): TemplateSave {
    return {
        name: "CLI, promoted to main",
        setName: () => {},
        keepManual: true,
        setKeepManual: () => {},
        keepPublish: true,
        setKeepPublish: () => {},
        type: "cli",
        setType: () => {},
        saving: false,
        saved: null,
        error: null,
        canSave: true,
        save: () => {},
        ...extra,
    };
}

const fit: SetupTemplateFit = {
    template: {
        id: "0123456789abcdef",
        name: "npm CLI, PR to master",
        apptype: "cli",
        from: "SaaSFoundryAI",
        savedat: Date.UTC(2026, 9, 25),
        flow: {
            branchmodel: "rcpr",
            single: false,
            release: "master",
            merge: "merge",
            tagprefix: "v",
            rcformat: "numeric",
            rc: "published",
            notes: true,
            syncback: true,
            milestone: true,
            publish: ["npm", "githubrelease"],
            manual: [{ id: "check-store", title: "Check the store page", text: "Open the store." }],
        },
    },
    needs: [
        { code: "type", ok: true, value: "cli" },
        { code: "branches", ok: true, value: "main" },
        { code: "protected", ok: false, value: "main" },
        { code: "workflow", ok: true, target: "npm", value: "publish.yml" },
        { code: "workflow", ok: false, target: "githubrelease" },
    ],
    met: 3,
    total: 5,
    sametype: true,
    options: { ...base, rc: "published", trunk: "develop", release: "main", publish: ["npm", "githubrelease"] },
};

describe("step 4: save the pipeline as a template (FR-MC-042)", () => {
    it("keeps the flow, and the hand steps and targets only when ticked", () => {
        const draft = draftOf(base);
        expect(canSaveTemplate(draft, base)).toBe(true);
        expect(canSaveTemplate(draft, { ...base, kind: "saas" })).toBe(false);
        expect(canSaveTemplate(draftOf(base, { errors: ["bad"] }), base)).toBe(false);
        expect(rcOf(draft, base)).toBe("published");
        expect(rcOf(draftOf(base, { tagworkflows: { rc: [], public: [] } }), base)).toBe("internal");
        expect(rcOf(draft, { ...base, channels: ["public"] })).toBe("none");
        const flow = flowToSave(draft, base, true, true);
        expect(flow).toMatchObject({ single: false, release: "main", rc: "published", publish: ["npm"] });
        expect(flow.manual).toHaveLength(1);
        const bare = flowToSave(draft, base, false, false);
        expect(bare.manual).toEqual([]);
        expect(bare.publish).toEqual([]);
        const single = flowToSave(
            draft,
            { ...base, trunk: "main", release: "main", rc: "none", publish: [] },
            true,
            true
        );
        expect(single).toMatchObject({ single: true, branchmodel: "single", syncback: false, release: undefined });
    });

    it("lists the project's blanks and names the template in both languages", () => {
        const draft = draftOf(base);
        const blanks = templateBlanks(draft, base).map((b) => translate("en", b.key, b.vars));
        expect(blanks).toEqual([
            "everyday branch (here develop)",
            "published branch (here main)",
            "changelogs (1 here)",
            "version files",
            "CI workflows (1 here)",
            "notes folder",
            "publish workflow",
        ]);
        const parts = defaultNameParts(draft, { ...base, branchmodel: "rcpr" }, "cli");
        for (const lang of ["en", "fr"]) {
            const name = translate(lang, "mc.setup.template.defaultName", {
                type: translate(lang, parts.type),
                flow: translate(lang, parts.flow.key, parts.flow.vars),
            });
            expect(name).toBe(lang === "en" ? "CLI, PR to main" : "CLI, PR vers main");
        }
        expect(flowSummary(fit.template.flow).map((l) => l.key)).toEqual([
            "mc.setup.template.flow.rcpr",
            "mc.setup.template.rc.published",
            "mc.setup.template.publishes",
            "mc.setup.template.hand",
        ]);
        const need = needText({ code: "workflow", ok: false, target: "npm" });
        expect(translate("fr", need.key, { ...need.vars, target: "npm" })).toBe(
            "Aucun workflow ne publie encore sur npm au tag : l’étape 3 propose molten-publish.yml."
        );
    });

    it("renders the step with the kept parts, the blanks, the diagram and the saved state", () => {
        const draft = draftOf(base);
        const html = renderToStaticMarkup(
            <TemplateStep draft={draft} options={base} projectName="invoice-cli" form={form()} />
        );
        expect(html).toContain("Save as a template");
        expect(html).toContain("CLI, promoted to main");
        expect(html).toContain("Steps by hand and their instructions");
        expect(html).toContain("Check the store page");
        expect(html).toContain("npm; a missing publish workflow is proposed on the next project");
        expect(html).toContain("everyday branch (here develop)");
        expect(html).toContain("On this computer");
        expect(html).toContain("1 step by hand");
        expect(html.match(/data-testid="setup-diagram"/g)).toHaveLength(2);
        expect(html).not.toContain("setup-template-saved");
        const saved = renderToStaticMarkup(
            <TemplateStep draft={draft} options={base} projectName="invoice-cli" form={form({ saved: fit.template })} />
        );
        expect(saved).toContain("is saved on this computer");
        const saas = renderToStaticMarkup(
            <TemplateStep draft={draft} options={{ ...base, kind: "saas" }} projectName="x" form={form()} />
        );
        expect(saas).toContain("cannot be saved as a template yet");
    });
});

describe("step 2b: the saved templates offered (FR-MC-042)", () => {
    it("puts the templates of this type first", () => {
        const other = { ...fit, sametype: false, template: { ...fit.template, id: "fedcba9876543210" } };
        expect(orderedFits([other, fit]).map((f) => f.template.id)).toEqual(["0123456789abcdef", "fedcba9876543210"]);
        expect(orderedFits(null)).toBeNull();
    });

    it("renders each template with its fit and what is missing, first in Start from", () => {
        const html = renderToStaticMarkup(
            <TemplateChoices fits={[fit]} selected="0123456789abcdef" onChoose={() => {}} onForget={async () => {}} />
        );
        expect(html).toContain("My template “npm CLI, PR to master”");
        expect(html).toContain("3/5");
        expect(html).toContain(
            "PR to master · release candidates published · published to npm, GitHub Release with the notes · 1 step by hand"
        );
        expect(html).toContain("main asks for no pull request here");
        expect(html).toContain("No workflow publishes to GitHub Release with the notes on the tag yet");
        expect(html).not.toContain("already publishes");
        expect(html).toContain("saved from SaaSFoundryAI on");
        expect(html).toContain("Forget this template");
        expect(
            renderToStaticMarkup(
                <TemplateChoices fits={[]} selected="" onChoose={() => {}} onForget={async () => {}} />
            )
        ).toBe("");

        const o = fit.options;
        const step = renderToStaticMarkup(
            <DescribeStep
                draft={draftOf(o)}
                options={o}
                from="template"
                models={[]}
                model=""
                words=""
                appType="cli"
                templates={[fit]}
                template="0123456789abcdef"
                onChange={() => {}}
                onFrom={() => {}}
                onWords={() => {}}
            />
        );
        expect(step.indexOf("My template")).toBeGreaterThan(-1);
        expect(step.indexOf("My template")).toBeLessThan(step.indexOf("MoltenTerm&#x27;s standard pipeline"));
    });
});
