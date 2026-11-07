// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the buttons of Brokk's panels do (FR-BOSS-003, AC4; FR-BOSS-009, AC16 and AC19, #2032): the doors the app already
// has, behind one hook so that every panel runs them the same way, shows the same busy state and the same problem line,
// and tells his expressions what the developer handled (a nod, a smile). The rows' buttons are the #2003 panel's, with
// the settling of #2026, moved here whole.

import { fireAndForget } from "@/util/util";
import { useState } from "react";
import { serverErrorText } from "../i18n/server-text";
import { DurableSessions } from "../sessions/sessions-store";
import {
    answerHandoff,
    answerNotice,
    goToLocation,
    locateSession,
    markNoticeDone,
    openIntegrationPr,
    openNotice,
    openPrPage,
    rerunPrChecks,
} from "./boss-card-actions";
import { BossBubbleModel } from "./boss-store";
import { ToHandleAction, ToHandleItem } from "./boss-to-handle-model";
import { handledKindOf } from "./brokk-ask-model";
import { BrokkExpressionsModel } from "./brokk-expressions";

export type BrokkActions = {
    // The key of the button that runs, null when none does.
    busyId: string;
    // The line under a panel when a button failed.
    problem: string;
    goToSession: (sessionId: string, busyKey: string, settle?: () => void) => void;
    runTodo: (item: ToHandleItem, action: ToHandleAction) => void;
    reconnect: (sessionId: string) => void;
};

// onLeave: an action took the developer somewhere else, so the group closes and leaves the focus where it went.
export function useBrokkActions(onLeave: () => void): BrokkActions {
    const model = BossBubbleModel.getInstance();
    const [busyId, setBusyId] = useState<string>(null);
    const [problem, setProblem] = useState("");

    // The row was acted on or ignored (FR-BOSS-009, AC16): it leaves, and so does the notification it stands for. A row
    // that is a notification is settled by the notification itself.
    const settleItem = (item: ToHandleItem, settleNotice = true) => {
        if (!item.key.startsWith("notif:")) {
            model.settleRow(item);
        }
        if (settleNotice && item.notice != null) {
            fireAndForget(() => markNoticeDone(item.notice));
        }
    };

    const goToSession = (sessionId: string, busyKey: string, settle?: () => void) => {
        if (busyId != null) {
            return;
        }
        setBusyId(busyKey);
        setProblem("");
        fireAndForget(async () => {
            try {
                const loc = await locateSession(sessionId);
                settle?.();
                onLeave();
                goToLocation(loc);
            } catch (e) {
                setProblem(serverErrorText(e));
            } finally {
                setBusyId(null);
            }
        });
    };

    // A To handle button runs the door it names; a row leaves the list once the fact it shows is gone, never by a click.
    const runTodo = (item: ToHandleItem, action: ToHandleAction) => {
        const run = action.run;
        const busyKey = `${item.key}|${action.id}`;
        if (run.kind === "later") {
            model.park(item.key);
            return;
        }
        if (run.kind === "ignore") {
            settleItem(item);
            return;
        }
        if (run.kind === "goto") {
            if (action.disabled) {
                return;
            }
            goToSession(run.sessionId, busyKey, () => settleItem(item));
            return;
        }
        if (run.kind === "integration") {
            settleItem(item);
            onLeave();
            fireAndForget(() => openIntegrationPr(run.dir, run.number));
            return;
        }
        if (run.kind === "external") {
            settleItem(item);
            fireAndForget(() => openPrPage(run.url));
            return;
        }
        if (run.kind === "open") {
            onLeave();
            fireAndForget(() => openNotice(run.entry));
            return;
        }
        if (run.kind === "brief") {
            return;
        }
        const work: () => Promise<unknown> =
            run.kind === "rerun"
                ? () => rerunPrChecks(run.dir, run.number)
                : run.kind === "handoff"
                  ? () => answerHandoff(run.requestid, run.decision)
                  : run.kind === "done"
                    ? () => markNoticeDone(run.entry)
                    : () => answerNotice(run.entry, run.action);
        setBusyId(busyKey);
        setProblem("");
        fireAndForget(async () => {
            try {
                const ok = await work();
                if (ok !== false && (run.kind === "rerun" || run.kind === "answer")) {
                    settleItem(item, run.kind === "rerun");
                }
                const handled = handledKindOf(run);
                if (handled != null) {
                    BrokkExpressionsModel.getInstance().noteHandled(handled);
                }
            } catch (e) {
                setProblem(serverErrorText(e));
            } finally {
                setBusyId(null);
            }
        });
    };

    const reconnect = (sessionId: string) => {
        if (busyId != null) {
            return;
        }
        setBusyId(`reconnect|${sessionId}`);
        setProblem("");
        fireAndForget(async () => {
            try {
                await DurableSessions.getInstance().reconnect(sessionId);
            } catch (e) {
                setProblem(serverErrorText(e));
            } finally {
                setBusyId(null);
            }
        });
    };

    return { busyId, problem, goToSession, runTodo, reconnect };
}
