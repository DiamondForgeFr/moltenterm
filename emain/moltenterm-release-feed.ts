// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The release notification's request (#188): asks the repository's GitHub Releases at most once a day for every
// window together, and keeps the releases it read in <data>/molten/update/release-check.json so a restart does not ask
// again. The offer is picked from them at every answer, for the version and channel running then: an upgrade or a
// channel change never shows an offer made for another build. The request is anonymous, from a session of its own,
// and carries nothing about the user; nothing is downloaded.

import * as electron from "electron";
import { handleAppIpc } from "./moltenterm-privileged-ipc";
import fs from "fs";
import path from "path";
import { MoltentermRepoUrl } from "../frontend/util/moltenterm-identity";
import {
    dueForCheck,
    feedReleasesOf,
    MoltentermReleaseCheckChannel,
    pickReleaseOffer,
    ReleaseCheck,
    ReleaseCheckCache,
    releaseFeedEnabled,
    ReleaseFeedTimeoutMs,
    releaseFeedUrl,
} from "../frontend/moltenterm-shell/update/release-feed";
import { getWaveDataDir } from "./emain-platform";

declare const __MOLTENTERM_CHANNEL__: string;

const MaxFeedBytes = 4 << 20;
// Releases below the first public version's candidates are not the project's (pkg/molten/versions).
const Rules = { tagprefix: "v", firstpublic: "1.0.0" };
// An in-memory session: no cookie of the browser panel's github.com sign-in can ride along.
const FeedPartition = "moltenterm-release-feed";

let inflight: Promise<ReleaseCheckCache> = null;
// The cache file, read once; afterwards the answers come from memory, with no disk access on the main thread.
let memo: ReleaseCheckCache = undefined;

function cacheFile(): string {
    return path.join(getWaveDataDir(), "molten", "update", "release-check.json");
}

async function readReleaseCache(file: string): Promise<ReleaseCheckCache> {
    try {
        const cache = JSON.parse(await fs.promises.readFile(file, "utf8"));
        if (cache == null || typeof cache !== "object" || !Number.isFinite(cache.checkedat)) {
            return null;
        }
        return {
            checkedat: cache.checkedat,
            releases: feedReleasesOf(cache.releases),
            notifiedtag: typeof cache.notifiedtag === "string" ? cache.notifiedtag : undefined,
            error: typeof cache.error === "string" ? cache.error : undefined,
            failed: cache.failed === true,
        };
    } catch {
        return null;
    }
}

async function writeReleaseCache(file: string, cache: ReleaseCheckCache) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(cache, null, 2) + "\n");
    await fs.promises.rename(tmp, file);
}

function saveSoon(cache: ReleaseCheckCache) {
    writeReleaseCache(cacheFile(), cache).catch((e) => {
        console.log("[release-feed] could not save the check:", e?.message ?? e);
    });
}

async function fetchReleases(url: string) {
    const session = electron.session.fromPartition(FeedPartition);
    const response = await session.fetch(url, {
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        signal: AbortSignal.timeout(ReleaseFeedTimeoutMs),
        credentials: "omit",
    });
    if (!response.ok) {
        throw new Error(`GitHub answered ${response.status}`);
    }
    if (Number(response.headers.get("content-length") ?? 0) > MaxFeedBytes) {
        throw new Error("the release list is too large");
    }
    const text = await response.text();
    if (text.length > MaxFeedBytes) {
        throw new Error("the release list is too large");
    }
    const releases = JSON.parse(text);
    if (!Array.isArray(releases)) {
        throw new Error("unexpected release list");
    }
    return feedReleasesOf(releases);
}

// The releases known for today: from memory or the cache file, asked of GitHub when the day's check is due.
async function currentReleases(): Promise<ReleaseCheckCache> {
    if (memo === undefined) {
        memo = await readReleaseCache(cacheFile());
    }
    const now = Date.now();
    if (!dueForCheck(memo, now)) {
        return memo;
    }
    const previous = memo;
    let next: ReleaseCheckCache;
    try {
        const releases = await fetchReleases(releaseFeedUrl(MoltentermRepoUrl, process.env));
        next = { checkedat: now, releases, notifiedtag: previous?.notifiedtag };
    } catch (e) {
        // A failed request keeps what was read before and is tried again an hour later, not at every focus.
        next = {
            checkedat: now,
            releases: previous?.releases ?? [],
            notifiedtag: previous?.notifiedtag,
            error: String(e?.message ?? e),
            failed: true,
        };
        console.log("[release-feed] check failed:", next.error);
    }
    memo = next;
    saveSoon(next);
    return next;
}

// The offer for the build running now. The first window to hear of a release announces it; a release no longer
// offered (installed since, or replaced by a newer one) is withdrawn from the notification center.
function answer(cache: ReleaseCheckCache, channel: string): ReleaseCheck {
    const offer = pickReleaseOffer(cache.releases, channel, electron.app.getVersion(), Rules);
    const rtn: ReleaseCheck = { enabled: true, offer, checkedat: cache.checkedat, error: cache.error };
    if (offer != null && cache.notifiedtag !== offer.tag) {
        rtn.announce = true;
        rtn.withdraw = cache.notifiedtag;
        cache.notifiedtag = offer.tag;
        saveSoon(cache);
    } else if (offer == null && cache.notifiedtag) {
        rtn.withdraw = cache.notifiedtag;
        cache.notifiedtag = undefined;
        saveSoon(cache);
    }
    return rtn;
}

// Every window asks; one request runs at a time and they share it. Each window's answer is made after it, one after
// the other on the main thread, so only the first one is told to announce a release.
export async function checkReleaseFeed(): Promise<ReleaseCheck> {
    const channel = __MOLTENTERM_CHANNEL__;
    if (!releaseFeedEnabled(channel, electron.app.isPackaged)) {
        return { enabled: false };
    }
    if (inflight == null) {
        inflight = currentReleases().finally(() => {
            inflight = null;
        });
    }
    return answer(await inflight, channel);
}

export function initMoltentermReleaseFeed() {
    handleAppIpc(MoltentermReleaseCheckChannel, () => checkReleaseFeed());
}
