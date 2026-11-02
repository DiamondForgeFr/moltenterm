// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Preferences › Notifications (FR-SHELL-106): what each subject may tell, and whether the notification panel opens
// for every message. Its one home: the bell's « Settings › » and a row's "Don't tell me again…" open this section,
// the second one with its subject lit, instead of a second editor behind the bell (FR-MC-019 rules unchanged).

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { useT } from "./i18n/i18n";
import { Delivery, DeliveryLabels, NotificationSubject, NotificationSubjects } from "./notification-rules";
import { MoltentermNotifications } from "./notifications-store";
import { openSettingsSection } from "./settings/settings-open";
import { PageCard, PageRowClass } from "./settings/settings-page";
import { suiteIcon } from "./suite/suite-icons";

const Deliveries: Delivery[] = ["notify", "quiet", "off"];

// The subject to light once the section shows, set by the bell before it opens Preferences.
export const NotificationSubjectHighlightAtom = jotai.atom(null) as jotai.PrimitiveAtom<NotificationSubject>;

const HighlightMs = 2400;

export function openNotificationSettings(subject?: NotificationSubject): void {
    globalStore.set(NotificationSubjectHighlightAtom, subject ?? null);
    fireAndForget(() => openSettingsSection("notifications"));
}

function DeliveryChoice({
    label,
    chosen,
    onChoose,
}: {
    label: string;
    chosen: Delivery;
    onChoose: (d: Delivery) => void;
}) {
    const t = useT();
    return (
        <div role="radiogroup" aria-label={label} className="flex shrink-0 rounded-4 border border-line-strong p-0.5">
            {Deliveries.map((delivery) => (
                <button
                    key={delivery}
                    type="button"
                    role="radio"
                    aria-checked={chosen === delivery}
                    onClick={() => onChoose(delivery)}
                    className={cn(
                        "cursor-pointer rounded-4 px-2 py-0.5 text-12 transition-colors duration-120 ease-mt",
                        chosen === delivery ? "bg-surface-2 text-primary" : "text-muted hover:text-primary"
                    )}
                >
                    {t(DeliveryLabels[delivery])}
                </button>
            ))}
        </div>
    );
}

export function NotificationSubjectsCard() {
    const t = useT();
    const model = MoltentermNotifications.getInstance();
    const prefs = useAtomValue(model.prefsAtom, { store: globalStore });
    const highlight = useAtomValue(NotificationSubjectHighlightAtom, { store: globalStore });
    useEffect(() => {
        if (highlight == null) {
            return;
        }
        document
            .querySelector(`[data-notification-subject="${highlight}"]`)
            ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        const timer = setTimeout(() => globalStore.set(NotificationSubjectHighlightAtom, null), HighlightMs);
        return () => clearTimeout(timer);
    }, [highlight]);
    return (
        <PageCard
            title={t("notif.settings.subjectsTitle")}
            hint={t("notif.settings.intro")}
            icon={suiteIcon("notifications")}
            scope="app"
            glow={highlight != null}
        >
            <div data-testid="notification-settings">
                {NotificationSubjects.map((subject) => (
                    <div
                        key={subject.id}
                        data-notification-subject={subject.id}
                        className={cn(
                            PageRowClass,
                            "transition-colors duration-240 ease-mt",
                            highlight === subject.id && "bg-surface-2"
                        )}
                    >
                        <span className="min-w-0 flex-1 truncate text-12 font-medium text-primary">
                            {t(subject.labelKey)}
                        </span>
                        <DeliveryChoice
                            label={t(subject.labelKey)}
                            chosen={prefs[subject.id] ?? "notify"}
                            onChoose={(d) => model.setDelivery(subject.id, d)}
                        />
                    </div>
                ))}
                <div className="px-5 pb-3 text-11 text-muted">{t("notif.settings.footer")}</div>
            </div>
        </PageCard>
    );
}

// Its own block: PageFlow gives each child its cell and gap, which a fragment would not get.
export function NotificationPanelCard() {
    const t = useT();
    const model = MoltentermNotifications.getInstance();
    const panelPolicy = useAtomValue(model.panelPolicyAtom, { store: globalStore });
    return (
        <PageCard title={t("notif.settings.panelTitle")} icon={suiteIcon("display")} scope="app">
            <div className={PageRowClass}>
                <div className="min-w-0 flex-1">
                    <div className="text-12 font-medium text-primary">{t("notif.settings.openPanel")}</div>
                    <div className="text-12 text-muted">{t("notif.settings.openPanelHint")}</div>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={panelPolicy === "all"}
                    aria-label={t("notif.settings.openPanel")}
                    data-testid="notification-panel-policy"
                    onClick={() => model.setPanelPolicy(panelPolicy === "all" ? "answers" : "all")}
                    className="inline-flex h-row shrink-0 cursor-pointer items-center rounded-4 px-1"
                >
                    <span className={cn("molten-cmdpanel-switch", panelPolicy === "all" && "is-on")} aria-hidden />
                </button>
            </div>
        </PageCard>
    );
}
