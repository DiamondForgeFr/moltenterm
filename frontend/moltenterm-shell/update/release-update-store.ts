// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The release notification in the renderer (#188): once the window is idle after start, and when it gets the focus,
// asks emain whether a newer release is out. emain asks GitHub at most once a day, answers from memory otherwise, and
// tells one window only to announce a release. The announcement goes to the notification center, once per release,
// and a status bar entry leads to its release page. No timer runs.

import { getApi, getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { GitHubReleaseLink } from "@/util/moltenterm-web-link";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";
import { getLocale, t } from "../i18n/i18n";
import {
    addMoltentermNotification,
    registerNotificationGesture,
    resolveMoltentermNotification,
} from "../notifications-store";
import { openWebLink } from "../open-web-link";
import { showToast } from "../toast-store";
import {
    isJustNow,
    notesAsText,
    ReleaseCandidatesSettingKey,
    ReleaseCheck,
    ReleaseCheckMode,
    releaseFeedEnabled,
    ReleaseOffer,
    UpdateCheckState,
    updateCheckStateOf,
} from "./release-feed";

export const ReleaseNotifySettingKey = "moltenterm:releasenotify";
const ReleaseDownloadGesture = "release:download";
// The first check waits for the window to settle, never long.
const FirstCheckIdleTimeoutMs = 10_000;
// One toast for the answers of Check for updates now (the latest version, a failure, a build that does not check).
const ReleaseCheckToastId = "release:check";
const RelativeUnits: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
];

// What the Check for updates action shows while it asks, then its answer (#1806).
export type UpdateCheckView = UpdateCheckState | { state: "checking" };

type ReleaseElectronApi = ElectronApi & { moltentermReleaseCheck: (mode?: ReleaseCheckMode) => Promise<ReleaseCheck> };

function releaseApi(): ReleaseElectronApi {
    return getApi() as ReleaseElectronApi;
}

function readBuild() {
    return typeof __MOLTENTERM_BUILD__ === "undefined" ? null : __MOLTENTERM_BUILD__;
}

export function releaseAvailableKey(tag: string): string {
    return `release:available:${tag}`;
}

// The age of a check in the interface language: "just now", or "5 minutes ago" (Intl gives the words of the age).
export function ageWords(checkedat: number, now: number): string {
    if (isJustNow(checkedat, now)) {
        return t("update.check.now");
    }
    const seconds = Math.round((checkedat - now) / 1000);
    const format = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
    const [unit, size] =
        RelativeUnits.find(([, s]) => Math.abs(seconds) >= s) ?? RelativeUnits[RelativeUnits.length - 1];
    return format.format(Math.round(seconds / size), unit);
}

// "checked just now", "checked 5 minutes ago".
export function checkedWhen(checkedat: number, now: number): string {
    return t("update.check.checkedAgo", { when: ageWords(checkedat, now) });
}

// Asks emain now, whatever the day's check said, and shows the answer in the app: the release notification when one is
// out, a toast for the latest version or a failure (with Try again). Never a native dialog (#1806).
export function checkForUpdatesNow() {
    ReleaseUpdateModel.getInstance().checkNow();
}

export function sameOffer(a: ReleaseOffer, b: ReleaseOffer): boolean {
    return a?.tag === b?.tag && a?.url === b?.url && a?.notes === b?.notes;
}

export function openReleasePage(url: string) {
    fireAndForget(() => openWebLink(url, GitHubReleaseLink));
}

export class ReleaseUpdateModel {
    private static instance: ReleaseUpdateModel = null;

    offerAtom = atom(null) as PrimitiveAtom<ReleaseOffer>;
    // Check for updates now (#1806): its state, the version running and the time of the last check (0: never).
    checkViewAtom = atom(null) as PrimitiveAtom<UpdateCheckView>;
    installedAtom = atom("") as PrimitiveAtom<string>;
    lastCheckedAtom = atom(0) as PrimitiveAtom<number>;
    started = false;
    checking = false;

    private constructor() {}

    static getInstance(): ReleaseUpdateModel {
        if (!ReleaseUpdateModel.instance) {
            ReleaseUpdateModel.instance = new ReleaseUpdateModel();
        }
        return ReleaseUpdateModel.instance;
    }

    // The build's own channel, as emain reads it: only builds of the release workflow look, never a gold or a dev build.
    isRelease(): boolean {
        return releaseFeedEnabled(readBuild()?.channel, !getApi().getIsDev());
    }

    notifyOn(): boolean {
        return globalStore.get(getSettingsKeyAtom(ReleaseNotifySettingKey as any)) !== false;
    }

    start(): () => void {
        if (this.started || !this.isRelease()) {
            return () => {};
        }
        this.started = true;
        // The Download button opens the offer emain made, never a link stored with the notification.
        const unregister = registerNotificationGesture(ReleaseDownloadGesture, async () => {
            openReleasePage(globalStore.get(this.offerAtom)?.url);
            return { ok: true };
        });
        const idle = requestIdleCallback(() => this.check(), { timeout: FirstCheckIdleTimeoutMs });
        const onFocus = () => this.check();
        window.addEventListener("focus", onFocus);
        const unsubscribe = globalStore.sub(getSettingsKeyAtom(ReleaseNotifySettingKey as any), () => this.check());
        // The preference applies at once: emain picks the offer again, withdrawing one no longer made (#948).
        const unsubscribeCandidates = globalStore.sub(getSettingsKeyAtom(ReleaseCandidatesSettingKey as any), () =>
            this.check()
        );
        return () => {
            cancelIdleCallback(idle);
            window.removeEventListener("focus", onFocus);
            unsubscribe();
            unsubscribeCandidates();
            unregister();
            this.started = false;
        };
    }

    setOffer(offer: ReleaseOffer) {
        if (!sameOffer(globalStore.get(this.offerAtom), offer)) {
            globalStore.set(this.offerAtom, offer);
        }
    }

    check() {
        if (this.checking || document.visibilityState !== "visible") {
            return;
        }
        if (!this.notifyOn()) {
            this.setOffer(null);
            return;
        }
        this.checking = true;
        fireAndForget(async () => {
            try {
                this.applyCheck(await releaseApi().moltentermReleaseCheck("due"), false);
            } finally {
                this.checking = false;
            }
        });
    }

    // The installed version and the last check's time are read without a request, for Settings.
    readLastCheck() {
        fireAndForget(async () => {
            const check = await releaseApi().moltentermReleaseCheck("read");
            globalStore.set(this.installedAtom, check?.version ?? "");
            globalStore.set(this.lastCheckedAtom, check?.checkedat ?? 0);
        });
    }

    checkNow() {
        if (globalStore.get(this.checkViewAtom)?.state === "checking") {
            return;
        }
        globalStore.set(this.checkViewAtom, { state: "checking" });
        fireAndForget(async () => {
            let check: ReleaseCheck;
            try {
                check = await releaseApi().moltentermReleaseCheck("now");
            } catch (e) {
                check = { enabled: true, error: String(e?.message ?? e) };
            }
            this.applyCheck(check, true);
            const view = updateCheckStateOf(check);
            globalStore.set(this.checkViewAtom, view);
            this.tellCheck(view);
        });
    }

    // The answer's offer, the withdrawn release and the time of the check. announceAlways: a manual check puts the
    // release in the notification center even when it was announced before (the center keeps one open entry).
    private applyCheck(check: ReleaseCheck, announceAlways: boolean) {
        if (check?.version) {
            globalStore.set(this.installedAtom, check.version);
        }
        if (check?.checkedat) {
            globalStore.set(this.lastCheckedAtom, check.checkedat);
        }
        if (!check?.enabled) {
            this.setOffer(null);
            return;
        }
        this.setOffer(check.offer ?? null);
        if (check.withdraw) {
            resolveMoltentermNotification(releaseAvailableKey(check.withdraw));
        }
        if (check.offer != null && (check.announce || announceAlways)) {
            this.announce(check.offer);
        }
    }

    // A release out is shown by its notification; the other answers are a toast, which the next check replaces.
    private tellCheck(view: UpdateCheckState) {
        if (view.state === "available") {
            return;
        }
        if (view.state === "disabled") {
            showToast({ kind: "info", id: ReleaseCheckToastId, title: t("update.check.disabled") });
            return;
        }
        if (view.state === "error") {
            showToast({
                kind: "error",
                id: ReleaseCheckToastId,
                title: t("update.check.error"),
                actions: [{ id: "retry", label: t("update.check.retry"), run: () => this.checkNow() }],
            });
            return;
        }
        showToast({
            kind: "info",
            id: ReleaseCheckToastId,
            title: t("update.check.latest", {
                version: view.version,
                checked: checkedWhen(view.checkedat, Date.now()),
            }),
        });
    }

    announce(offer: ReleaseOffer) {
        addMoltentermNotification({
            key: releaseAvailableKey(offer.tag),
            source: "moltenterm",
            global: true,
            kind: "info",
            title: t("update.release.title", { version: offer.version }),
            message: notesAsText(offer.notes) || t("update.release.seeNotes"),
            actions: [
                {
                    id: "download",
                    label: t("update.release.download"),
                    kind: "gesture",
                    gesture: ReleaseDownloadGesture,
                },
            ],
        });
    }
}
