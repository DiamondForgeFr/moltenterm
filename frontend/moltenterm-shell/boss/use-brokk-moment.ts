// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The moment of a kind colleague that Brokk says under his square (FR-BOSS-009, AC72, #2203): the one the group shows when
// it opens, in the language of the app. A moment shows once: it is kept as it was when the group showed it, so that the
// words never change under the developer's eyes, and it is gone once the group has closed on it (momentStep).

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useT } from "../i18n/i18n";
import { currentMoment, Moment, momentLine, momentStep } from "./brokk-colleague";
import { BrokkColleagueModel } from "./brokk-colleague-store";

export type MomentView = { id: string; text: string };

// `shown`: the group is on screen. Null when there is nothing to say.
export function useBrokkMoment(shown: boolean): MomentView {
    const model = BrokkColleagueModel.getInstance();
    const t = useT();
    const moments = useAtomValue(model.momentsAtom, { store: globalStore });
    const [kept, setKept] = useState<Moment>(null);
    const current = currentMoment(moments);

    useEffect(() => {
        const step = momentStep(kept, current, shown);
        if (step.kept !== kept) {
            setKept(step.kept);
        }
        if (step.shown != null) {
            model.noteShown(step.shown);
        }
        if (step.seen != null) {
            model.noteSeen(step.seen);
        }
    }, [model, shown, kept, current]);

    const moment = kept ?? current;
    if (moment == null) {
        return null;
    }
    const line = momentLine(moment);
    return { id: moment.id, text: line.text ?? t(line.key) };
}
