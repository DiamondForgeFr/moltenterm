// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What typing into an agent, Update terminal and Restart with current settings did, in the interface language (#656).
// wavesrv's results carry a code beside their English (pkg/molten/termupdate/texts.go); a permission mode travels as
// its id and shows with the command panel's label for it.

import { hasKey } from "../i18n/i18n-core";
import { t } from "../i18n/i18n";
import { serverText, ServerText } from "../i18n/server-text";

const ModeVars = ["mode", "target"];

export type TermupdateTextResult = {
    message?: string;
    messagetext?: ServerText;
};

function withModeLabels(text: ServerText): ServerText {
    if (text?.vars == null) {
        return text;
    }
    const vars = { ...text.vars };
    for (const name of ModeVars) {
        const id = vars[name];
        if (id && hasKey(`cmdpanel.mode.${id}`)) {
            vars[name] = t(`cmdpanel.mode.${id}`);
        }
    }
    return { ...text, vars };
}

// termupdateMessage words an AgentInputResult or an Outcome; its English shows for a code this window does not know.
export function termupdateMessage(result: TermupdateTextResult): string {
    if (result == null) {
        return "";
    }
    return serverText(withModeLabels(result.messagetext), result.message ?? "");
}
