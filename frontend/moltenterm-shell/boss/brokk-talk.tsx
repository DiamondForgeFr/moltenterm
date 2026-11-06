// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The field at the foot of Brokk's panel (FR-BOSS-009, AC9 and AC15, #2003): the developer writes to him, and the message
// goes to his own terminal session (brokk-session.ts). He listens while the developer writes (onTyping) and speaks while
// his session answers. A message the agent could not take stays in the field, with a line saying why.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { BossBubbleModel } from "./boss-store";
import { BrokkSession } from "./brokk-session";
import { canSend, keepsText, MaxMessageLength, talkNoteKey } from "./brokk-talk-model";

export function BrokkTalk({ onTyping }: { onTyping: (typing: boolean) => void }) {
    const t = useT();
    const session = BrokkSession.getInstance();
    const name = useAtomValue(BossBubbleModel.getInstance().nameAtom, { store: globalStore });
    const state = useAtomValue(session.stateAtom, { store: globalStore });
    const [text, setText] = useState("");
    useEffect(() => onTyping(text.trim() !== ""), [text, onTyping]);
    useEffect(() => () => onTyping(false), [onTyping]);
    const noteKey = talkNoteKey(state);
    const send = async () => {
        if (!canSend(text, state)) {
            return;
        }
        const result = await session.say(text.trim());
        if (!keepsText(result)) {
            setText("");
        }
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
                        if (state.phase !== "idle" && state.phase !== "sending") {
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
                        "text-11",
                        state.phase === "sending" || state.phase === "sent" ? "text-muted" : "text-secondary"
                    )}
                >
                    {t(noteKey, { name, agent: state.agentName })}
                </div>
            ) : null}
        </form>
    );
}
