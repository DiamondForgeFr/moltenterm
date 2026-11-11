// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The messages of Brokk's conversation window (FR-BOSS-009, AC23 and AC24, #2033): the developer's on the right, his on
// the left, and under his last complete answer the replies it offers as buttons. A reply that is an authorisation asks
// once more, in place of the buttons: what would be sent, Confirmer and Annuler. The text of every message is plain text,
// never HTML. State and sending are brokk-talk.tsx's; the rules are brokk-exchange-model.ts's.
//
// His latest answer is revealed as he says it (AC87, #2259, brokk-speech.ts): the words not said yet keep their place,
// unseen, so that the window does not grow at every step; the message is busy for screen readers until it is whole, so
// that they read it once; and its replies show once it is.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { ExchangeItem, InlineAction, offersActions } from "./brokk-exchange-model";
import { BrokkSpeech, Shown } from "./brokk-speech";

function revealedOf(item: ExchangeItem, shown: Shown): number {
    if (item.role !== "brokk" || shown.id !== item.id || shown.count >= item.text.length) {
        return null;
    }
    return shown.count;
}

export type ExchangeViewProps = {
    items: ExchangeItem[];
    // His name, for the words only a screen reader hears.
    name: string;
    // The reply waiting for its confirmation, or null.
    confirming: InlineAction;
    // A message is on its way: the buttons wait.
    busy: boolean;
    onPick: (action: InlineAction) => void;
    onConfirm: () => void;
    onCancel: () => void;
};

export function ExchangeView({ items, name, confirming, busy, onPick, onConfirm, onCancel }: ExchangeViewProps) {
    const t = useT();
    const shown = useAtomValue(BrokkSpeech.getInstance().shownAtom, { store: globalStore });
    return (
        <>
            {items.map((item) => {
                const revealed = revealedOf(item, shown);
                return (
                    <div
                        key={`${item.role}-${item.id}`}
                        className="mt-brokk-msg"
                        data-role={item.role}
                        data-testid="brokk-msg"
                        aria-busy={revealed != null ? "true" : undefined}
                    >
                        <span className="sr-only">{item.role === "you" ? t("boss.panel.talk.you") : name}: </span>
                        <div className="mt-brokk-msg-text" data-testid="brokk-msg-text">
                            {revealed == null ? (
                                item.text
                            ) : (
                                <>
                                    {item.text.slice(0, revealed)}
                                    <span className="text-transparent" data-testid="brokk-msg-unsaid">
                                        {item.text.slice(revealed)}
                                    </span>
                                </>
                            )}
                        </div>
                        {item.role === "brokk" && revealed == null && offersActions(items, item) ? (
                            <div
                                className="mt-brokk-acts"
                                role="group"
                                aria-label={t("boss.panel.talk.actionsLabel", { name })}
                                data-testid="brokk-acts"
                            >
                                {confirming != null ? (
                                    <>
                                        <div className="mt-brokk-ask" role="status" data-testid="brokk-ask">
                                            {t("boss.panel.talk.confirmAsk", { text: confirming.label })}
                                        </div>
                                        <button
                                            type="button"
                                            className="molten-btn cursor-pointer rounded-6 px-2 py-0.5 text-11"
                                            data-testid="brokk-act-confirm"
                                            onClick={onConfirm}
                                        >
                                            {t("boss.panel.talk.confirm")}
                                            <MoltenWave />
                                        </button>
                                        <button
                                            type="button"
                                            className="mt-brokk-act"
                                            data-testid="brokk-act-cancel"
                                            onClick={onCancel}
                                        >
                                            {t("boss.panel.talk.cancel")}
                                        </button>
                                    </>
                                ) : (
                                    item.actions.map((action) => (
                                        <button
                                            key={action.label}
                                            type="button"
                                            className="mt-brokk-act"
                                            data-testid="brokk-act"
                                            data-authorise={action.authorise ? "true" : undefined}
                                            disabled={busy}
                                            onClick={() => onPick(action)}
                                        >
                                            {action.label}
                                        </button>
                                    ))
                                )}
                            </div>
                        ) : null}
                    </div>
                );
            })}
        </>
    );
}
