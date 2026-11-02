// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// wavesrv's companion, keep-awake and browser agent sentences in the interface language (#656): the code wavesrv
// sends beside its English words them, and the English shows without one.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlBarView, permissionBarView, type AgentTab } from "./browser/browser-agent";
import {
    integrationItemText,
    integrationProblem,
    statusMessage,
    type CompanionView,
} from "./companion/companion-model";
import { I18nModel } from "./i18n/i18n";
import { approvalReasonText, coffeeReason, type KeepAwakeCoffee } from "./keepawake-model";

describe("server sentences in French", () => {
    beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    it("words the companion's status and integration", () => {
        const view = {
            blockid: "b",
            version: 1,
            status: "searching",
            agentname: "Claude Code",
            message: "This terminal's folder is not known yet.",
            messagetext: { code: "companion.foldernotknown" },
        } as CompanionView;
        expect(statusMessage(view).detail).toBe("Le dossier de ce terminal n'est pas encore connu.");
        const item = {
            kind: "sessionlink",
            name: "Session link",
            nametext: { code: "integration.name.sessionlink" },
            reason: "already yours, in ~/.claude/settings.json",
            reasontext: { code: "integration.reason.alreadyyours", vars: { where: "~/.claude/settings.json" } },
        };
        expect(integrationItemText(item)).toEqual({
            name: "Lien de session",
            reason: "déjà présent chez vous, dans ~/.claude/settings.json",
        });
        const stepped = {
            ...view,
            integration: {
                agent: "claude",
                realpath: "/x",
                stepaside: "started by a running agent",
                stepasidetext: { code: "integration.stepaside.nested" },
            },
        } as CompanionView;
        expect(integrationProblem(stepped)).toBe(
            "MoltenTerm n'a rien ajouté à cette exécution\u00a0: lancé par un agent en cours."
        );
    });

    it("words keep-awake reasons", () => {
        const coffee: KeepAwakeCoffee = {
            workspaceid: "w",
            since: 1,
            working: true,
            reasons: ["Claude Code: working", "Command: npm test"],
            reasonstext: [
                { code: "keepawake.why.working", vars: { agent: "Claude Code" } },
                { code: "keepawake.why.command", vars: { command: "npm test" } },
            ],
        };
        expect(coffeeReason(coffee)).toBe("Claude Code\u00a0: au travail, Commande\u00a0: npm test");
        expect(
            approvalReasonText({ reason: "reads the keychain", reasontext: { code: "keepawake.deny.keychain" } })
        ).toBe("lit le trousseau");
    });

    it("words the browser agent bars", () => {
        const tab: AgentTab = {
            browsertabid: "t",
            agentname: "Claude",
            origin: "opened",
            state: "active",
            action: "Went to example.com",
            actiontext: { code: "browser.action.navigate", vars: { site: "example.com" } },
            permission: {
                requestid: "r",
                site: "",
                kind: "action",
                action: "open a file chooser",
                actiontext: { code: "browser.prompt.filechooser" },
            },
        } as AgentTab;
        expect(controlBarView({ ...tab, permission: undefined }).detail).toBe("Est allé sur example.com");
        expect(permissionBarView(tab).title).toContain("ouvrir un sélecteur de fichiers");
    });
});

describe("without a code", () => {
    it("shows wavesrv's English", () => {
        expect(integrationItemText({ kind: "browser", name: "MoltenTerm browser", reason: "something new" })).toEqual({
            name: "MoltenTerm browser",
            reason: "something new",
        });
        expect(approvalReasonText({ reason: "a new reason" })).toBe("a new reason");
        expect(approvalReasonText({})).toBe("");
    });
});
