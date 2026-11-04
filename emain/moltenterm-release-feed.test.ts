// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Check for updates now (#1806), run against the release feed's request with a fake session, a fake preference and an
// injected clock: the day's check keeps its once-a-day rule, the action asks at once and records its time, the channel
// rule and the candidates preference hold, a failed request is reported, and the IPC mode is read.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { updateCheckStateOf } from "../frontend/moltenterm-shell/update/release-feed";

const mocks = vi.hoisted(() => ({
    fetch: vi.fn(),
    config: vi.fn(),
    handle: vi.fn(),
    isPackaged: true,
    version: "1.0.0-7",
    dataDir: "",
}));

vi.mock("electron", () => ({
    app: {
        get isPackaged() {
            return mocks.isPackaged;
        },
        getVersion: () => mocks.version,
    },
    session: { fromPartition: () => ({ fetch: (...args: unknown[]) => mocks.fetch(...args) }) },
}));
vi.mock("../frontend/app/store/wshclientapi", () => ({
    RpcApi: { GetFullConfigCommand: (...args: unknown[]) => mocks.config(...args) },
}));
vi.mock("./emain-wsh", () => ({ ElectronWshClient: {} }));
vi.mock("./emain-platform", () => ({ getWaveDataDir: () => mocks.dataDir }));
vi.mock("./moltenterm-privileged-ipc", () => ({ handleAppIpc: (...args: unknown[]) => mocks.handle(...args) }));

type Feed = typeof import("./moltenterm-release-feed");

const Hour = 60 * 60 * 1000;
const Day = 24 * Hour;
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);
const Repo = "https://github.com/DiamondForgeFr/moltenterm";

const Installed = {
    tag_name: "v1.0.0-7",
    prerelease: true,
    draft: false,
    html_url: `${Repo}/releases/tag/v1.0.0-7`,
    body: "",
    published_at: "2026-11-03T10:47:00Z",
};
const PublicNew = {
    tag_name: "v1.0.0",
    prerelease: false,
    draft: false,
    html_url: `${Repo}/releases/tag/v1.0.0`,
    body: "## New\n- Check for updates now",
    published_at: "2026-11-03T18:00:00Z",
};
const CandidateNew = {
    tag_name: "v1.0.0-8",
    prerelease: true,
    draft: false,
    html_url: `${Repo}/releases/tag/v1.0.0-8`,
    body: "",
    published_at: "2026-11-03T18:00:00Z",
};

let now = T0;
let feed: Feed;

function feedResponse(list: unknown[], status = 200) {
    return {
        ok: status < 300,
        status,
        headers: { get: () => null },
        text: async () => JSON.stringify(list),
    };
}

function cacheFile(): string {
    return path.join(mocks.dataDir, "molten", "update", "release-check.json");
}

function setChannel(channel: string, packaged: boolean) {
    vi.stubGlobal("__MOLTENTERM_CHANNEL__", channel);
    mocks.isPackaged = packaged;
}

beforeAll(async () => {
    await import("./moltenterm-release-feed");
}, 60_000);

beforeEach(async () => {
    vi.resetModules();
    feed = await import("./moltenterm-release-feed");
    now = T0;
    mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mt1806-feed-"));
    mocks.isPackaged = true;
    mocks.version = "1.0.0-7";
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(feedResponse([Installed]));
    mocks.config.mockReset();
    mocks.config.mockResolvedValue({ settings: {} });
    mocks.handle.mockReset();
    vi.stubGlobal("__MOLTENTERM_CHANNEL__", "public");
    vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(async () => {
    if (mocks.fetch.mock.calls.length > 0) {
        await vi.waitFor(
            () => {
                expect(fs.existsSync(cacheFile())).toBe(true);
                const tmp = fs.readdirSync(path.dirname(cacheFile())).filter((f) => f.endsWith(".tmp"));
                expect(tmp).toEqual([]);
            },
            { timeout: 30_000 }
        );
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(mocks.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("Check for updates now (#1806)", () => {
    it("asks GitHub at once, whatever the day's check said, and records the time of the check", async () => {
        now = T0;
        await feed.checkReleaseFeed("due");
        expect(mocks.fetch).toHaveBeenCalledTimes(1);

        now = T0 + Hour;
        await feed.checkReleaseFeed("due");
        expect(mocks.fetch).toHaveBeenCalledTimes(1);

        now = T0 + 2 * Hour;
        const forced = await feed.checkReleaseFeed("now");
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(forced.checkedat).toBe(T0 + 2 * Hour);
        expect(forced.version).toBe("1.0.0-7");
        expect(updateCheckStateOf(forced)).toEqual({ state: "latest", version: "1.0.0-7", checkedat: T0 + 2 * Hour });
    });

    it("counts the day's check from the last check made, a forced one included", async () => {
        now = T0;
        await feed.checkReleaseFeed("now");
        expect(mocks.fetch).toHaveBeenCalledTimes(1);

        now = T0 + 23 * Hour;
        await feed.checkReleaseFeed("due");
        expect(mocks.fetch).toHaveBeenCalledTimes(1);

        now = T0 + Day + 2 * Hour;
        await feed.checkReleaseFeed("due");
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });

    it("reads the time of the last check without a request", async () => {
        now = T0;
        const before = await feed.checkReleaseFeed("read");
        expect(before.checkedat).toBeUndefined();
        expect(mocks.fetch).not.toHaveBeenCalled();

        now = T0 + Hour;
        await feed.checkReleaseFeed("now");
        now = T0 + 5 * Hour;
        const after = await feed.checkReleaseFeed("read");
        expect(after).toMatchObject({ enabled: true, version: "1.0.0-7", checkedat: T0 + Hour });
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });

    it("answers with the release out, and a manual check puts it in the notification center again", async () => {
        mocks.fetch.mockResolvedValue(feedResponse([PublicNew, Installed]));
        now = T0;
        const first = await feed.checkReleaseFeed("now");
        expect(first.offer?.version).toBe("1.0.0");
        expect(first.announce).toBe(true);
        expect(updateCheckStateOf(first).state).toBe("available");

        now = T0 + Hour;
        const second = await feed.checkReleaseFeed("now");
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(second.offer?.version).toBe("1.0.0");
        expect(second.announce).toBeFalsy();
        expect(second.withdraw).toBeUndefined();
    });

    it("follows the candidates preference at the answer: off, a candidate is not offered; on, it is", async () => {
        mocks.fetch.mockResolvedValue(feedResponse([CandidateNew, Installed]));
        mocks.config.mockResolvedValue({ settings: { "moltenterm:releasecandidates": false } });
        now = T0;
        const off = await feed.checkReleaseFeed("now");
        expect(off.offer).toBeFalsy();
        expect(updateCheckStateOf(off).state).toBe("latest");

        mocks.config.mockResolvedValue({ settings: { "moltenterm:releasecandidates": true } });
        now = T0 + Hour;
        const on = await feed.checkReleaseFeed("now");
        expect(on.offer?.tag).toBe("v1.0.0-8");
        expect(updateCheckStateOf(on).state).toBe("available");
    });

    it("never asks from a gold, a dev build or an unpackaged one, and says the build does not check", async () => {
        for (const [channel, packaged] of [
            ["gold", true],
            ["dev", true],
            ["public", false],
        ] as const) {
            setChannel(channel, packaged);
            const check = await feed.checkReleaseFeed("now");
            expect(check.enabled).toBe(false);
            expect(check.version).toBe("1.0.0-7");
            expect(updateCheckStateOf(check)).toEqual({ state: "disabled" });
        }
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it("reports a failed request with its error, records the time, and tries again an hour later", async () => {
        mocks.fetch.mockResolvedValueOnce(feedResponse([], 503));
        now = T0;
        const failed = await feed.checkReleaseFeed("now");
        expect(failed.error).toBe("GitHub answered 503");
        expect(failed.checkedat).toBe(T0);
        expect(updateCheckStateOf(failed)).toEqual({ state: "error", error: "GitHub answered 503" });

        now = T0 + 30 * 60 * 1000;
        await feed.checkReleaseFeed("due");
        expect(mocks.fetch).toHaveBeenCalledTimes(1);

        now = T0 + 61 * 60 * 1000;
        const retried = await feed.checkReleaseFeed("due");
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(retried.error).toBeUndefined();
    });

    it("the IPC handler takes the mode from the renderer, and asks for the day's check when the mode is unknown", async () => {
        feed.initMoltentermReleaseFeed();
        expect(mocks.handle).toHaveBeenCalledWith("moltenterm-release-check", expect.any(Function));
        const handler = mocks.handle.mock.calls[0][1];

        now = T0;
        await handler({}, "now");
        expect(mocks.fetch).toHaveBeenCalledTimes(1);

        await handler({}, "due");
        await handler({}, "anything else");
        expect(mocks.fetch).toHaveBeenCalledTimes(1);

        now = T0 + 2 * Hour;
        await handler({}, "anything else");
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });
});
