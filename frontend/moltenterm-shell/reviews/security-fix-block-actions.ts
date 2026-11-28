// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the security fix block's buttons do (FR-REV-036 AC10, AC13, AC17, #2591): launch the fix (the first time, with the
// developer's answer to the ask), stop it, and read the developer's consent to start it on its own. They go through the
// calls #2589 made (askSecurityFix, stopSecurityFix, recordSecurityFixAnswer), which wavesrv checks: nothing here decides
// that a fix starts.

import { ClientModel } from "@/app/store/client-model";
import { atoms, getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, Atom, useAtomValue } from "jotai";
import { t } from "../i18n/i18n";
import { errorPhrase, phrase, serverPhrase, type Phrase } from "../i18n/phrase";
import { askSecurityFix, stopSecurityFix, type ReviewSecurityFixResult } from "../review/review-client";
import { recordSecurityFixAnswer } from "./security-fix-actions";
import {
    SecurityFixAnswer,
    securityFixConsentOf,
    SecurityFixSettingKey,
    type SecurityFixConsent,
} from "./security-fix-model";

const NoClientAtom = atom(null) as Atom<Client>;

// The developer's answer about starting the fix on its own, as wavesrv reads it: the setting, and the confirmation in the
// client's meta that must come with it.
export function useSecurityFixConsent(): SecurityFixConsent {
    const setting = useAtomValue(getSettingsKeyAtom(SecurityFixSettingKey));
    const client = useAtomValue(ClientModel.getInstance().clientAtom ?? NoClientAtom);
    return securityFixConsentOf(setting ?? undefined, client?.meta as Record<string, unknown>);
}

// What a launch that did not start anything tells the developer, as a line under the block's buttons. Where the fix stands
// after one that did (started, joined, covered, waiting for a place, someone else's) is the block's own: it reads it from
// the answer.
export function securityFixProblem(result: ReviewSecurityFixResult): Phrase {
    switch (result?.status) {
        case "failed":
            if (result.reason === "blockgone") {
                return phrase("reviews.securityFix.problem.blockGone");
            }
            if (result.reason === "notshared") {
                return phrase("reviews.securityFix.problem.notShared");
            }
            return result.message
                ? serverPhrase(result.messagetext, result.message)
                : phrase("reviews.securityFix.problem.failed");
        case "busy":
            return phrase("reviews.securityFix.problem.busy");
    }
    return null;
}

export type SecurityFixLaunch = {
    dir: string;
    repo: string;
    trunk: string;
    fingerprint: string;
    // The first-time ask: "ask" launches this time only (and MoltenTerm only offers from then on), "always" records the
    // consent to start it on its own. Absent once the developer has answered.
    answer?: SecurityFixAnswer;
};

// The developer's click on Launch the fix: records the answer when it was asked, then starts the fix. null when it went
// through, the problem otherwise.
export async function launchSecurityFix(req: SecurityFixLaunch): Promise<Phrase> {
    try {
        if (req.answer != null) {
            await recordSecurityFixAnswer(req.answer);
        }
        const result = await askSecurityFix({
            dir: req.dir,
            repo: req.repo,
            trunk: req.trunk,
            fingerprint: req.fingerprint,
            workspaceid: globalStore.get(atoms.workspace)?.oid,
            tabname: t("reviews.securityFix.tab"),
        });
        return securityFixProblem(result);
    } catch (e) {
        return errorPhrase(e);
    }
}

// The developer's Stop, from the block or from the card of the fix's pull request: the same as the notification's.
export async function stopSecurityFixOf(dir: string, fingerprint: string): Promise<Phrase> {
    try {
        const result = await stopSecurityFix({ dir, fingerprint });
        return result?.status === "stopped" ? null : phrase("agentChoice.noSecurityFix");
    } catch (e) {
        return errorPhrase(e);
    }
}
