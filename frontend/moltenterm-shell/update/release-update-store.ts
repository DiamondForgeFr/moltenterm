// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The release notification in the renderer (#188): once the window is idle after start, and when it gets the focus,
// asks emain whether a newer release is out. emain asks GitHub at most once a day, answers from memory otherwise, and
// tells one window only to announce a release. The announcement goes to the notification center, once per release,
// and a status bar entry leads to it. No timer runs.
//
// The in-app update (#1860, Notulia's flow): the notification and Settings › About offer the release, and only the
// user's click on Update starts anything. Electron main downloads, verifies and stages it and keeps the state; this
// side follows that state (pushed to every window) and tells the user where it stands: ready to restart, downloaded for
// a hand install, or refused with its reason.

import { ClientModel } from "@/app/store/client-model";
import { getApi, getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
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
import { ReleaseNotesModel } from "../releases/release-notes-store";
import { openSettingsSection } from "../settings/settings-open";
import { showToast } from "../toast-store";
import {
    isJustNow,
    notesAsText,
    ReleaseCandidatesSettingKey,
    ReleaseCheck,
    ReleaseCheckMode,
    releaseFeedEnabled,
    ReleaseOffer,
    updateCheckStateOf,
} from "./release-feed";
import {
    IdleInstallState,
    isReleaseInstallState,
    ReleaseApplyWhen,
    ReleaseInstallPlan,
    ReleaseInstallResult,
    ReleaseInstallState,
    ReleaseSwapStatus,
    upgradedFrom,
} from "./release-install";
import {
    announcementOf,
    releaseDownloadedKey,
    releaseFailedKey,
    releaseReadyKey,
    UpdateCheckView,
} from "./release-install-view";

export type { UpdateCheckView } from "./release-install-view";

export const ReleaseNotifySettingKey = "moltenterm:releasenotify";
const ReleaseDownloadGesture = "release:download";
const ReleaseInstallGesture = "release:install";
const ReleaseRestartGesture = "release:restart";
const ReleaseLaterGesture = "release:later";
const ReleaseRevealGesture = "release:reveal";
const ReleaseWhatsNewGesture = "release:whatsnew";
// The first check waits for the window to settle, never long.
const FirstCheckIdleTimeoutMs = 10_000;
// One toast for the answers of Check for updates now (the latest version, a failure, a build that does not check).
const ReleaseCheckToastId = "release:check";
const RelativeUnits: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
];

type ReleaseElectronApi = ElectronApi & {
    moltentermReleaseCheck: (mode?: ReleaseCheckMode) => Promise<ReleaseCheck>;
    moltentermReleaseInstallState: () => Promise<{ state: ReleaseInstallState; plan: ReleaseInstallPlan }>;
    moltentermReleaseInstallStart: (tag: string) => Promise<ReleaseInstallResult>;
    moltentermReleaseInstallApply: (when: ReleaseApplyWhen) => Promise<ReleaseInstallResult>;
    moltentermReleaseInstallReveal: () => Promise<ReleaseInstallResult>;
    moltentermReleaseInstallLast: () => Promise<ReleaseSwapStatus>;
    onMoltentermReleaseInstall: (callback: (state: ReleaseInstallState) => void) => () => void;
};

function releaseApi(): ReleaseElectronApi {
    return getApi() as ReleaseElectronApi;
}

function readBuild() {
    return typeof __MOLTENTERM_BUILD__ === "undefined" ? null : __MOLTENTERM_BUILD__;
}

// The version of the last run, in the client's meta, which every window shares.
const LastRunVersionMetaKey = "molten:update:lastversion";

function clientMetaString(key: string): string {
    const value = (globalStore.get(ClientModel.getInstance().clientAtom)?.meta as Record<string, any>)?.[key];
    return typeof value === "string" ? value : "";
}

function setClientMeta(meta: Record<string, any>) {
    const clientId = ClientModel.getInstance().clientId;
    if (clientId == null) {
        return;
    }
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("client", clientId), meta: meta as MetaType })
    );
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
    // The in-app update (#1860): the installer's state, kept by Electron main, and what it can do for this install.
    installAtom = atom(IdleInstallState) as PrimitiveAtom<ReleaseInstallState>;
    planAtom = atom(null) as PrimitiveAtom<ReleaseInstallPlan>;
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
        return (
            releaseFeedEnabled(readBuild()?.channel, !getApi().getIsDev()) ||
            !!getApi().getEnv("MOLTENTERM_RELEASE_FEED_URL")
        );
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
        const unregister = [
            registerNotificationGesture(ReleaseDownloadGesture, async () => {
                openReleasePage(globalStore.get(this.offerAtom)?.url);
                return { ok: true };
            }),
            registerNotificationGesture(ReleaseInstallGesture, async () => {
                await this.install();
                return { ok: true };
            }),
            registerNotificationGesture(ReleaseRestartGesture, async () => {
                await this.apply("now");
                return { ok: true };
            }),
            registerNotificationGesture(ReleaseLaterGesture, async () => ({ ok: true, resolve: true })),
            registerNotificationGesture(ReleaseRevealGesture, async () => {
                await releaseApi().moltentermReleaseInstallReveal();
                return { ok: true };
            }),
            registerNotificationGesture(ReleaseWhatsNewGesture, async (args) => {
                ReleaseNotesModel.getInstance().open(typeof args?.version === "string" ? args.version : undefined);
                return { ok: true, resolve: true };
            }),
        ];
        const stopFollowing = this.follow();
        this.announceInstalled();
        this.reportLastSwap();
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
            unregister.forEach((u) => u());
            stopFollowing();
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
                this.reportLastSwap();
                await this.readInstall();
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
            await this.readInstall();
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
                await this.readInstall();
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

    // What the installer is doing and what it can do here, from Electron main.
    async readInstall() {
        try {
            const answer = await releaseApi().moltentermReleaseInstallState();
            if (answer?.plan != null) {
                globalStore.set(this.planAtom, answer.plan);
            }
            if (isReleaseInstallState(answer?.state)) {
                this.setInstall(answer.state);
            }
        } catch (e) {
            console.log("[release-update] could not read the install state:", e?.message ?? e);
        }
    }

    // Main pushes every change to every window: they all show the same update.
    follow(): () => void {
        const api = releaseApi();
        if (typeof api.onMoltentermReleaseInstall !== "function") {
            return () => {};
        }
        fireAndForget(() => this.readInstall());
        return api.onMoltentermReleaseInstall((state) => {
            if (isReleaseInstallState(state)) {
                this.setInstall(state);
            }
        });
    }

    private setInstall(next: ReleaseInstallState) {
        const prev = globalStore.get(this.installAtom);
        if (JSON.stringify(prev) === JSON.stringify(next)) {
            return;
        }
        globalStore.set(this.installAtom, next);
        const announcement = announcementOf(prev, next, releaseAvailableKey);
        announcement.resolve.forEach((key) => resolveMoltentermNotification(key));
        if (announcement.tell != null) {
            this.tellInstall(announcement.tell);
        }
    }

    // The user's click on Update: the only way anything is downloaded.
    async install(): Promise<void> {
        const offer = globalStore.get(this.offerAtom);
        if (offer == null) {
            return;
        }
        const result = await releaseApi().moltentermReleaseInstallStart(offer.tag);
        if (!result?.ok) {
            this.setInstall({
                phase: "error",
                tag: offer.tag,
                version: offer.version,
                error: result?.error ?? { kind: "unsupported" },
            });
        }
    }

    async apply(when: ReleaseApplyWhen): Promise<void> {
        const result = await releaseApi().moltentermReleaseInstallApply(when);
        if (!result?.ok) {
            const state = globalStore.get(this.installAtom);
            this.setInstall({
                phase: "error",
                tag: state.tag,
                version: state.version,
                error: result?.error ?? { kind: "stale" },
            });
        }
    }

    // "Later": the update stays armed for the quit; only its message goes.
    later() {
        const tag = globalStore.get(this.installAtom).tag;
        if (tag != null) {
            resolveMoltentermNotification(releaseReadyKey(tag));
        }
    }

    async reveal(): Promise<void> {
        await releaseApi().moltentermReleaseInstallReveal();
    }

    // The status bar entry and the notification's name lead to the update's own page when it can be done here.
    openUpdate(offer: ReleaseOffer) {
        const plan = globalStore.get(this.planAtom);
        if (plan == null || plan.mode === "none") {
            openReleasePage(offer.url);
            return;
        }
        fireAndForget(() => openSettingsSection("about"));
    }

    // The new build says what it is: it runs a later version than the last that ran. The swap's own status comes only
    // after the new build has stayed open, so it cannot say this at the first start (the gold does the same, #64).
    private announceInstalled() {
        fireAndForget(async () => {
            let version: string;
            try {
                version = (await releaseApi().moltentermReleaseCheck("read"))?.version;
            } catch {
                return;
            }
            const last = clientMetaString(LastRunVersionMetaKey);
            if (!version || last === version) {
                return;
            }
            setClientMeta({ [LastRunVersionMetaKey]: version });
            resolveMoltentermNotification(releaseAvailableKey(`v${version}`));
            resolveMoltentermNotification(releaseReadyKey(`v${version}`));
            if (!upgradedFrom(last, version)) {
                return;
            }
            addMoltentermNotification({
                key: `release:installed:${version}`,
                source: "moltenterm",
                global: true,
                kind: "success",
                title: t("update.install.notice.installedTitle", { version }),
                message: t("update.install.notice.installedMessage"),
                actions: [
                    {
                        id: "whatsnew",
                        label: t("update.install.notice.whatsNew"),
                        kind: "gesture",
                        gesture: ReleaseWhatsNewGesture,
                        args: { version },
                    },
                ],
            });
        });
    }

    // A swap that did not go through, told once: the build that did not stay open (MoltenTerm went back to the previous
    // one, which reads this at its start) or a swap that failed before moving anything. An installed swap says nothing
    // here (announceInstalled does), and the file is consumed by the read either way.
    private reportLastSwap() {
        fireAndForget(async () => {
            let last: ReleaseSwapStatus;
            try {
                last = await releaseApi().moltentermReleaseInstallLast();
            } catch {
                return;
            }
            if (last == null || last.state === "installed") {
                return;
            }
            if (last.state === "rolledback") {
                addMoltentermNotification({
                    source: "moltenterm",
                    global: true,
                    kind: "warning",
                    title: t("update.install.notice.rolledBackTitle", { version: last.version }),
                    message: t("update.install.notice.rolledBackMessage"),
                });
                return;
            }
            addMoltentermNotification({
                source: "moltenterm",
                global: true,
                kind: "error",
                title: t("update.install.notice.swapFailedTitle"),
                message: t("update.install.notice.swapFailedMessage", { detail: last.detail ?? "" }),
            });
        });
    }

    private tellInstall(tell: NonNullable<ReturnType<typeof announcementOf>["tell"]>) {
        const version = tell.version;
        if (tell.kind === "ready") {
            addMoltentermNotification({
                key: releaseReadyKey(tell.tag),
                source: "moltenterm",
                global: true,
                kind: "info",
                title: t("update.install.notice.readyTitle", { version }),
                message: t("update.install.notice.readyMessage"),
                actions: [
                    {
                        id: "restart",
                        label: t("update.install.restart"),
                        kind: "gesture",
                        gesture: ReleaseRestartGesture,
                    },
                    { id: "later", label: t("update.install.later"), kind: "gesture", gesture: ReleaseLaterGesture },
                ],
            });
            return;
        }
        if (tell.kind === "downloaded") {
            const reason = globalStore.get(this.planAtom)?.reason;
            addMoltentermNotification({
                key: releaseDownloadedKey(tell.tag),
                source: "moltenterm",
                global: true,
                kind: "success",
                title: t("update.install.notice.downloadedTitle", { version }),
                message: t("update.install.notice.downloadedMessage", {
                    why: reason != null ? t(`update.install.why.${reason}`) : "",
                }).trim(),
                actions: [
                    {
                        id: "reveal",
                        label: t("update.install.showInFolder"),
                        kind: "gesture",
                        gesture: ReleaseRevealGesture,
                    },
                ],
            });
            return;
        }
        const actions = [];
        if (tell.retry) {
            actions.push({
                id: "retry",
                label: t("update.check.retry"),
                kind: "gesture" as const,
                gesture: ReleaseInstallGesture,
            });
        }
        actions.push({
            id: "page",
            label: t("update.install.releasePage"),
            kind: "gesture" as const,
            gesture: ReleaseDownloadGesture,
        });
        addMoltentermNotification({
            key: releaseFailedKey(tell.tag),
            source: "moltenterm",
            global: true,
            kind: "error",
            title: t("update.install.notice.failedTitle", { version }),
            message: t(`update.install.error.${tell.error?.kind ?? "unsupported"}`),
            actions,
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
    private tellCheck(view: ReturnType<typeof updateCheckStateOf>) {
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

    // Nothing is downloaded by the announcement: Update (or Download, where the app cannot replace itself) starts the
    // install, and the notes are one click away.
    announce(offer: ReleaseOffer) {
        const plan = globalStore.get(this.planAtom);
        const actions =
            plan == null || plan.mode === "none"
                ? [
                      {
                          id: "download",
                          label: t("update.release.download"),
                          kind: "gesture" as const,
                          gesture: ReleaseDownloadGesture,
                      },
                  ]
                : [
                      {
                          id: "install",
                          label: plan.mode === "swap" ? t("update.release.update") : t("update.release.download"),
                          kind: "gesture" as const,
                          gesture: ReleaseInstallGesture,
                      },
                      {
                          id: "notes",
                          label: t("update.release.notes"),
                          kind: "gesture" as const,
                          gesture: ReleaseDownloadGesture,
                      },
                  ];
        addMoltentermNotification({
            key: releaseAvailableKey(offer.tag),
            source: "moltenterm",
            global: true,
            kind: "info",
            title: t("update.release.title", { version: offer.version }),
            message: notesAsText(offer.notes) || t("update.release.seeNotes"),
            actions,
        });
    }
}
