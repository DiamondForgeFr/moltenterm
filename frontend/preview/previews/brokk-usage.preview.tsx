// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The usage block under Brokk's square (#2565, FR-BOSS-009 AC114 to AC118), on invented readings, drawn by the real block:
// a weekly Claude row, a monthly Kimi row (its week and controls in the line under it), and a Codex row that was not used
// lately, so the line under the grid shows its count and its chevron.
// ?lang=fr the interface language, ?w=400 the card's width (Brokk's real card is about 310 px wide), ?sessions=1 gives
// both providers a session window, which the block must never draw, ?lost=1 gives Kimi a measured session worth, so its
// line also tells the share lost.

import { globalStore } from "@/app/store/jotaiStore";
import { useEffect, useState } from "react";
import { UsageReadingsAtom, UsageUseAtom } from "../../moltenterm-shell/boss/boss-usage";
import { UsageBlock } from "../../moltenterm-shell/boss/brokk-usage-block";
import { UsageWindow } from "../../moltenterm-shell/companion/companion-gauges-model";
import { I18nModel } from "../../moltenterm-shell/i18n/i18n";

const query = new URLSearchParams(globalThis.location?.search);
if (query.get("lang")) {
    I18nModel.getInstance().setLanguageSetting(query.get("lang"));
}
const Width = Number(query.get("w")) || 400;
const WithSessions = query.get("sessions") === "1";
const WithLost = query.get("lost") === "1";

const Min = 60 * 1000;
const Hour = 60 * Min;
const Day = 24 * Hour;

// The next Tuesday at 09:00 after `from`: Claude's week resets then.
function nextTuesday(from: number): number {
    const d = new Date(from);
    d.setHours(9, 0, 0, 0);
    do {
        d.setDate(d.getDate() + 1);
    } while (d.getDay() !== 2);
    return d.getTime();
}

// The first of next month at 00:00: Kimi's month resets then.
function nextMonth(from: number): number {
    const d = new Date(from);
    return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

// How much of the month Kimi used so that it is five days late: the days gone since the 1st, less five, of the month.
function fiveDaysLate(now: number): number {
    const d = new Date(now);
    const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const gone = (now - new Date(d.getFullYear(), d.getMonth(), 1).getTime()) / Day;
    return Math.max(0, ((gone - 5) / days) * 100);
}

function seed(now: number) {
    const session = (used: number): UsageWindow[] =>
        WithSessions
            ? [{ id: "session", label: "Current session", usedpercent: used, resetsat: now + 2 * Hour, windowmins: 300 }]
            : [];
    globalStore.set(UsageReadingsAtom, {
        claude: {
            agent: "claude",
            source: "preview",
            readat: now - 2 * Min,
            windows: [
                ...session(40),
                { id: "week", label: "This week", usedpercent: 27, resetsat: nextTuesday(now), windowmins: 10080 },
            ],
        },
        kimi: {
            agent: "kimi",
            source: "preview",
            readat: now - 2 * Min,
            windows: [
                ...session(15),
                {
                    id: "month",
                    label: "This month",
                    usedpercent: fiveDaysLate(now),
                    resetsat: nextMonth(now),
                    ...(WithLost ? { sessionworth: 0.4, sessionmins: 300 } : {}),
                },
            ],
        },
        codex: {
            agent: "codex",
            source: "preview",
            plan: "free",
            readat: now - 10 * Day,
            windows: [
                {
                    id: "window:43200",
                    label: "30-day",
                    usedpercent: 100,
                    resetsat: now + 20 * Day,
                    windowmins: 43200,
                },
            ],
        },
    });
    globalStore.set(UsageUseAtom, {
        claude: { workms: 90 * Min, sessions: 4, lastat: now - Hour },
        kimi: { workms: 20 * Min, sessions: 1, lastat: now - 3 * Hour },
    });
}

export default function BrokkUsagePreview() {
    const [now] = useState(() => Date.now());
    // The preview has no app start to await the interface language: its texts are loaded before the card is drawn.
    const [ready, setReady] = useState(false);
    useEffect(() => {
        seed(now);
        I18nModel.getInstance()
            .whenReady()
            .then(() => setReady(true));
    }, [now]);
    if (!ready) {
        return null;
    }
    return (
        <div className="flex flex-col gap-4 px-6 pb-10 pt-4" data-testid="brokk-usage-preview">
            <div
                className="rounded border border-border bg-panel px-3.5 pb-2.5 pt-3.5 text-12 text-secondary"
                style={{ width: Width }}
            >
                <div data-testid="brokk-usage">
                    <UsageBlock now={now} />
                </div>
            </div>
        </div>
    );
}
