// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The field at the foot of Brokk's panel (FR-BOSS-009, AC9 and AC15, #2003): the developer writes to him, and the message
// goes to his own terminal session (brokk-session.ts). He listens while the developer writes (onTyping) and speaks while
// his session answers. His answer comes back under the field (#2028). A message the agent could not take stays in the
// field, with a line saying why and a way out: choose an agent, try again, or open his terminal.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { showPane } from "../sessions/pane-focus";
import { openSettingsSection } from "../settings/settings-open";
import { DominoLoader } from "../suite/suite";
import { BossBubbleModel } from "./boss-store";
import { BrokkSession } from "./brokk-session";
import {
    canSend,
    keepsText,
    MaxMessageLength,
    onItsWay,
    TalkState,
    talkNoteKey,
    talkWaits,
    TalkWayOut,
    talkWayOut,
    talkWayOutKey,
} from "./brokk-talk-model";

// What the developer was writing when the panel hid: it comes back with the panel, so Escape never costs a message.
let draft = "";

// A failure's note goes once the developer writes again; his answer stays until the next message.
function clearsOnTyping(state: TalkState): boolean {
    return state.phase !== "idle" && !onItsWay(state) && keepsText(state);
}

export function BrokkTalk({ onTyping }: { onTyping: (typing: boolean) => void }) {
    const t = useT();
    const session = BrokkSession.getInstance();
    const name = useAtomValue(BossBubbleModel.getInstance().nameAtom, { store: globalStore });
    const state = useAtomValue(session.stateAtom, { store: globalStore });
    const [text, setTextState] = useState(draft);
    const setText = (value: string) => {
        draft = value;
        setTextState(value);
    };
    useEffect(() => onTyping(text.trim() !== ""), [text, onTyping]);
    useEffect(() => () => onTyping(false), [onTyping]);
    const noteKey = talkNoteKey(state);
    const wayOut = talkWayOut(state);
    const send = async () => {
        if (!canSend(text, state)) {
            return;
        }
        const result = await session.say(text.trim());
        if (!keepsText(result)) {
            setText("");
        }
    };
    const takeWayOut = (way: TalkWayOut) => {
        if (way === "chooseAgent") {
            fireAndForget(() => openSettingsSection("agents"));
            return;
        }
        if (way === "openTerminal" && state.where != null) {
            showPane(state.where);
            return;
        }
        void send();
    };
    return (
        <form
            className="flex flex-col gap-1 border-t border-line-strong px-3 py-2"
            data-testid="brokk-talk"
            onSubmit={(e) => {
                e.preventDefault();
                void send();
            }}
        >
            {state.reply !== "" ? (
                <div
                    data-testid="brokk-talk-reply"
                    data-phase={state.phase}
                    aria-label={t("boss.panel.talk.replyLabel", { name })}
                    className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-4 bg-surface-2 px-2 py-1.5 text-12 text-primary"
                >
                    {state.reply}
                </div>
            ) : null}
            <div className="flex items-center gap-2">
                <input
                    type="text"
                    value={text}
                    maxLength={MaxMessageLength}
                    placeholder={t("boss.panel.talk.placeholder", { name })}
                    aria-label={t("boss.panel.talk.label", { name })}
                    data-testid="brokk-talk-input"
                    className="min-w-0 flex-1 rounded-4 border border-border bg-surface-2 px-2 py-1 text-12 text-primary placeholder:text-muted"
                    onChange={(e) => {
                        setText(e.target.value);
                        if (clearsOnTyping(state)) {
                            session.clearNote();
                        }
                    }}
                />
                <button
                    type="submit"
                    disabled={!canSend(text, state)}
                    data-testid="brokk-talk-send"
                    className="molten-btn inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-6 px-3 py-1 text-12 font-medium"
                >
                    {t("boss.panel.talk.send")}
                    <MoltenWave />
                </button>
            </div>
            {noteKey != null ? (
                <div
                    role="status"
                    data-testid="brokk-talk-note"
                    data-phase={state.phase}
                    className={cn(
                        "flex flex-wrap items-center gap-x-2 text-11",
                        talkWaits(state) ? "text-muted" : "text-secondary"
                    )}
                >
                    <span>
                        {talkWaits(state) ? <DominoLoader className="mr-1.5" /> : null}
                        {t(noteKey, { name, agent: state.agentName })}
                    </span>
                    {wayOut != null ? (
                        <button
                            type="button"
                            data-testid="brokk-talk-wayout"
                            data-way={wayOut}
                            onClick={() => takeWayOut(wayOut)}
                            className="cursor-pointer rounded-4 border border-border px-1.5 py-0.5 text-11 text-primary hover:bg-hover"
                        >
                            {t(talkWayOutKey(wayOut), { name })}
                        </button>
                    ) : null}
                </div>
            ) : null}
        </form>
    );
}
