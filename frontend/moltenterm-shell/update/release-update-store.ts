// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The release notification in the renderer (#188): once the window is idle after start, and when it gets the focus,
// asks emain whether a newer release is out. emain asks GitHub at most once a day, answers from memory otherwise, and
// tells one window only to announce a release. The announcement goes to the notification center, once per release,
// and a status bar entry leads to its release page. No timer runs.

import { getApi, getSettingsKeyAtom, openLink } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";
import { t } from "../i18n/i18n";
import {
    addMoltentermNotification,
    registerNotificationGesture,
    resolveMoltentermNotification,
} from "../notifications-store";
import { isSafeReleaseUrl, notesAsText, ReleaseCheck, releaseFeedEnabled, ReleaseOffer } from "./release-feed";

export const ReleaseNotifySettingKey = "moltenterm:releasenotify";
const ReleaseDownloadGesture = "release:download";
// The first check waits for the window to settle, never long.
const FirstCheckIdleTimeoutMs = 10_000;

type ReleaseElectronApi = ElectronApi & { moltentermReleaseCheck: () => Promise<ReleaseCheck> };

function releaseApi(): ReleaseElectronApi {
    return getApi() as ReleaseElectronApi;
}

function readBuild() {
    return typeof __MOLTENTERM_BUILD__ === "undefined" ? null : __MOLTENTERM_BUILD__;
}

export function releaseAvailableKey(tag: string): string {
    return `release:available:${tag}`;
}

export function sameOffer(a: ReleaseOffer, b: ReleaseOffer): boolean {
    return a?.tag === b?.tag && a?.url === b?.url && a?.notes === b?.notes;
}

export function openReleasePage(url: string) {
    if (!isSafeReleaseUrl(url)) {
        return;
    }
    fireAndForget(() => openLink(url));
}

export class ReleaseUpdateModel {
    private static instance: ReleaseUpdateModel = null;

    offerAtom = atom(null) as PrimitiveAtom<ReleaseOffer>;
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
        return () => {
            cancelIdleCallback(idle);
            window.removeEventListener("focus", onFocus);
            unsubscribe();
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
                const result = await releaseApi().moltentermReleaseCheck();
                if (!result?.enabled) {
                    this.setOffer(null);
                    return;
                }
                this.setOffer(result.offer ?? null);
                if (result.withdraw) {
                    resolveMoltentermNotification(releaseAvailableKey(result.withdraw));
                }
                if (result.announce && result.offer != null) {
                    this.announce(result.offer);
                }
            } finally {
                this.checking = false;
            }
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
