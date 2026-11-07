// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

/* global process, URL, console */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    compareVersions,
    evaluate,
    inRange,
    IssueLabel,
    IssueTitle,
    main,
    parseAdvisories,
    parseFeed,
    parseVersion,
    readPin,
    renderMarkdown,
    reportKey,
    StalenessInputError,
    syncIssue,
    validateExceptions,
} from "./electron-staleness.mjs";

const DayMs = 86400_000;
const repoFile = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const script = new URL("./electron-staleness.mjs", import.meta.url).pathname;
const now = new Date("2026-11-07T00:00:00Z");
const release = (version, fullDate, chrome = "156.0.8078.80") => ({
    version,
    date: fullDate.slice(0, 10),
    fullDate,
    chrome,
});
const feedJson = () => [
    release("47.0.0-nightly.20261106", "2026-11-06T14:00:00.000Z", "159.0.8140.0"),
    release("46.0.0-beta.1", "2026-10-30T12:00:00.000Z", "157.0.0.1"),
    release("45.2.3", "2026-11-04T16:53:18.000Z"),
    release("45.2.2", "2026-11-03T19:31:31.000Z"),
    release("45.2.1", "2026-10-30T20:58:42.000Z", "156.0.8078.75"),
    release("45.2.0", "2026-10-30T10:00:00.000Z", "156.0.8078.49"),
    release("44.10.2", "2026-11-03T10:00:00.000Z", "154.0.1"),
    release("43.8.7", "2026-11-03T10:00:00.000Z", "152.0.1"),
    release("42.11.18", "2026-10-21T10:00:00.000Z", "150.0.1"),
    release("41.10.7", "2026-08-24T10:00:00.000Z", "148.0.1"),
];
const lifecycleOf = (pinned, tentativeEndOfSupport = "2027-04-27") => ({ version: pinned, tentativeEndOfSupport });
const advisoryJson = (extra = {}) => ({
    ghsa_id: "GHSA-aaaa-bbbb-cccc",
    severity: "high",
    summary: "A bug",
    html_url: "https://github.com/electron/electron/security/advisories/GHSA-aaaa-bbbb-cccc",
    published_at: "2026-10-22T04:37:15Z",
    state: "published",
    withdrawn_at: null,
    vulnerabilities: [
        {
            package: { ecosystem: "npm", name: "electron" },
            vulnerable_version_range: ">= 45.0.0-alpha.1, < 45.2.3",
            patched_versions: "45.2.3",
        },
    ],
    ...extra,
});
function check({
    pinned = "45.2.3",
    feed = feedJson(),
    advisories = [],
    exceptions = [],
    when = now,
    maxAgeDays,
    endOfSupport,
} = {}) {
    return evaluate({
        pinned,
        feed: parseFeed(feed),
        advisories: parseAdvisories(advisories),
        lifecycle: lifecycleOf(pinned, endOfSupport),
        exceptions,
        now: when,
        maxAgeDays,
    });
}
const codes = (report) => report.flags.map((flag) => `${flag.code}:${flag.id}`);
const exception = (extra = {}) => ({
    code: "newer-release",
    id: "45.2.3",
    version: "45.2.0",
    reason: "requalification is booked",
    owner: "AGachet",
    control: "No build ships before it",
    reviewedBy: "AGachet",
    approval: "https://github.com/DiamondForgeFr/moltenterm/issues/1983#issuecomment-1",
    createdAt: "2026-11-06T00:00:00Z",
    expiresAt: "2026-11-13T00:00:00Z",
    ...extra,
});
const rejects = (fn, pattern) =>
    assert.throws(fn, (error) => error instanceof StalenessInputError && pattern.test(error.message), String(pattern));

test("versions: a prerelease sorts below its release, numeric identifiers numerically, alpha below beta", () => {
    const order = [
        "45.0.0-alpha.9",
        "45.0.0-alpha.10",
        "45.0.0-beta.1",
        "45.0.0-beta.6",
        "45.0.0",
        "45.0.1",
        "45.1.0",
        "46.0.0-alpha.1",
    ];
    for (let i = 1; i < order.length; i++) {
        assert.equal(compareVersions(order[i - 1], order[i]), -1, `${order[i - 1]} < ${order[i]}`);
        assert.equal(compareVersions(order[i], order[i - 1]), 1);
    }
    assert.equal(compareVersions("45.2.3", "45.2.3"), 0);
    assert.equal(parseVersion("12", true).minor, 0);
    rejects(() => parseVersion("latest"), /Not an Electron version/);
    rejects(() => parseVersion("12"), /Not an Electron version/);
});

test("ranges: the forms GitHub writes for Electron, alternatives, prereleases and bounds", () => {
    const table = [
        ["< 42.11.16", "42.11.15", true],
        ["< 42.11.16", "42.11.16", false],
        [">= 45.0.0-alpha.1, < 45.0.0-beta.6", "45.0.0-beta.5", true],
        [">= 45.0.0-alpha.1, < 45.0.0-beta.6", "45.0.0-beta.6", false],
        [">= 45.0.0-alpha.1, < 45.0.0-beta.6", "45.2.3", false],
        ["< 35.7.5 || >= 36.0.0-alpha.1 < 36.8.1 || >= 37.0.0-alpha.1 < 37.3.1", "36.8.0", true],
        ["< 35.7.5 || >= 36.0.0-alpha.1 < 36.8.1 || >= 37.0.0-alpha.1 < 37.3.1", "36.8.1", false],
        [">= 7.0.0-beta < =7.2.3", "7.2.3", true],
        ["<= 6", "45.2.3", false],
        [">= 40.0.0-alpha.1", "45.2.3", true],
        ["45.2.3", "45.2.3", true],
    ];
    for (const [range, version, expected] of table) {
        assert.equal(inRange(version, range), expected, `${version} in ${range}`);
    }
    for (const range of ["", "latest", ">= x.y", "< 1.0.0 ||"]) {
        rejects(() => inRange("45.2.3", range), /range/);
    }
});

test("a pin on the newest release of its major, in a supported major, is current", () => {
    const report = check();
    assert.equal(report.status, "current");
    assert.deepEqual(report.flags, []);
    assert.deepEqual(report.pending, []);
    assert.equal(report.latest.version, "45.2.3");
    assert.equal(report.chromium, "156.0.8078.80");
    assert.ok(renderMarkdown(report).includes("is current"));
    assert.ok(!renderMarkdown(report).includes("electron-staleness:"));
});

test("a newer release is pending for 7 days and a finding after, counted from the first release after the pin", () => {
    // 45.2.1, the first release after 45.2.0, came out 2026-10-30T20:58:42Z.
    const due = Date.parse("2026-10-30T20:58:42Z") + 7 * DayMs;
    const at = (stamp) => check({ pinned: "45.2.0", when: new Date(stamp) });
    const exactly = at(due);
    assert.deepEqual(exactly.flags, []);
    assert.equal(exactly.pending.length, 1);
    assert.equal(exactly.pending[0].dueBy, due);
    const after = at(due + 1);
    assert.deepEqual(codes(after), ["newer-release:45.2.3"]);
    assert.match(after.flags[0].detail, /45\.2\.1.*2026-10-30.*3 releases/);
    assert.match(after.flags[0].title, /Chromium 156\.0\.8078\.80/);
    assert.equal(after.status, "stale");
    // The window follows --max-age-days: 3 days make the same pin a finding earlier.
    assert.deepEqual(
        codes(check({ pinned: "45.2.0", when: new Date(Date.parse("2026-11-03T00:00:00Z")), maxAgeDays: 3 })),
        ["newer-release:45.2.3"]
    );
    assert.deepEqual(check({ pinned: "45.2.0", when: new Date(Date.parse("2026-11-03T00:00:00Z")) }).flags, []);
});

test("a release of another major, or a prerelease, is not a newer release", () => {
    assert.equal(check({ pinned: "45.2.3", when: new Date("2026-12-01T00:00:00Z") }).flags.length, 0);
    const feed = feedJson();
    feed.unshift(release("45.3.0-beta.1", "2026-10-01T00:00:00.000Z"));
    assert.equal(check({ pinned: "45.2.3", feed, when: new Date("2026-11-20T00:00:00Z") }).flags.length, 0);
});

test("an advisory whose range holds the pin is a finding with the policy's deadline from the fixing release", () => {
    const table = [
        ["critical", 3],
        ["high", 7],
        ["moderate", 30],
        ["low", 30],
        ["weird", 30],
    ];
    for (const [severity, days] of table) {
        const report = check({
            pinned: "45.2.0",
            when: new Date("2026-10-31T00:00:00Z"),
            advisories: [advisoryJson({ severity })],
        });
        const flag = report.flags.find((entry) => entry.code === "advisory");
        assert.equal(flag.id, "GHSA-aaaa-bbbb-cccc");
        assert.equal(flag.dueBy, Date.parse("2026-11-04T16:53:18Z") + days * DayMs, severity);
        assert.match(flag.title, new RegExp(`\\(${severity}\\) affects 45\\.2\\.0`));
        assert.match(flag.detail, /fixed in 45\.2\.3/);
    }
    assert.deepEqual(codes(check({ pinned: "45.2.3", advisories: [advisoryJson()] })), []);
});

test("an advisory is ignored when withdrawn, a draft, for another package, or fixed at or below the pin's version", () => {
    const base = advisoryJson();
    const ignored = [
        advisoryJson({ withdrawn_at: "2026-10-23T00:00:00Z" }),
        advisoryJson({ state: "draft" }),
        advisoryJson({
            vulnerabilities: [
                {
                    package: { ecosystem: "npm", name: "electron-updater" },
                    vulnerable_version_range: "< 99.0.0",
                    patched_versions: "99.0.0",
                },
            ],
        }),
        advisoryJson({
            vulnerabilities: [
                {
                    package: { ecosystem: "pip", name: "electron" },
                    vulnerable_version_range: "< 99.0.0",
                    patched_versions: "99.0.0",
                },
            ],
        }),
        advisoryJson({ vulnerabilities: [] }),
    ];
    assert.equal(base.state, "published");
    assert.deepEqual(codes(check({ pinned: "45.2.0", advisories: ignored })), ["newer-release:45.2.3"]);
});

test("GHSA-vv43's shape is not a finding for a version above its fixes; an advisory with no fix at all stays open", () => {
    // GitHub kept ">= 40.0.0-alpha.1" with no patched version beside the fixed 39, 41 and 42 branches, and the text names
    // 42.0.0-beta.2 as fixed: 45.2.3 holds that fix.
    const vv43 = advisoryJson({
        ghsa_id: "GHSA-vv43-5jgx-7qv8",
        vulnerabilities: [
            {
                package: { ecosystem: "npm", name: "electron" },
                vulnerable_version_range: "< 39.8.10",
                patched_versions: "39.8.10",
            },
            {
                package: { ecosystem: "npm", name: "electron" },
                vulnerable_version_range: ">= 40.0.0-alpha.1",
                patched_versions: "",
            },
            {
                package: { ecosystem: "npm", name: "electron" },
                vulnerable_version_range: ">= 41.0.0-alpha.1, < 41.10.5",
                patched_versions: "41.10.5",
            },
            {
                package: { ecosystem: "npm", name: "electron" },
                vulnerable_version_range: ">= 42.0.0-alpha.1, < 42.0.0-beta.2",
                patched_versions: "42.0.0-beta.2",
            },
        ],
    });
    assert.deepEqual(check({ advisories: [vv43] }).flags, []);
    // Below its highest fix, the open-ended range still counts: 41.10.7 is fixed in 41.10.5 but 40.x never was.
    const unfixed = advisoryJson({
        vulnerabilities: [
            {
                package: { ecosystem: "npm", name: "electron" },
                vulnerable_version_range: ">= 45.0.0-alpha.1",
                patched_versions: "",
            },
        ],
    });
    const report = check({ advisories: [unfixed] });
    assert.deepEqual(codes(report), ["advisory:GHSA-aaaa-bbbb-cccc"]);
    assert.match(report.flags[0].detail, /fixed in no release yet/);
    assert.equal(report.flags[0].dueBy, Date.parse("2026-10-22T04:37:15Z") + 7 * DayMs);
});

test("end of support is a finding from 30 days before it, and after", () => {
    const start = Date.parse("2027-04-27T00:00:00Z") - 30 * DayMs;
    assert.deepEqual(check({ when: new Date(start - 1) }).flags, []);
    const report = check({ when: new Date(start) });
    assert.deepEqual(codes(report), ["end-of-support:45"]);
    assert.equal(report.flags[0].dueBy, start);
    assert.match(report.flags[0].title, /ends support on 2027-04-27/);
    assert.match(
        check({ when: new Date("2027-05-01T00:00:00Z") }).flags.find((flag) => flag.code === "end-of-support").title,
        /ended support/
    );
});

test("a major outside the latest three stable ones is a finding", () => {
    // The stable majors of the fixture are 45, 44, 43, 42, 41.
    assert.deepEqual(codes(check({ pinned: "42.11.18" })), ["unsupported-line:42"]);
    assert.deepEqual(codes(check({ pinned: "43.8.7" })), []);
    // A prerelease of a newer major does not count as a stable major.
    assert.deepEqual(
        codes(
            check({
                pinned: "43.8.7",
                feed: [
                    ...feedJson(),
                    release("47.0.0", "2026-11-01T00:00:00.000Z"),
                    release("46.0.0", "2026-10-30T00:00:00.000Z"),
                ],
            })
        ),
        ["unsupported-line:43"]
    );
});

test("an exception covers exactly one finding of one pin until it expires", () => {
    const at = new Date("2026-11-07T01:00:00Z");
    const covered = check({ pinned: "45.2.0", when: at, exceptions: [exception()] });
    assert.deepEqual(covered.flags, []);
    assert.equal(covered.status, "current");
    assert.equal(covered.excepted[0].exception.reviewedBy, "AGachet");
    assert.ok(renderMarkdown(covered).includes("reviewed exception"));
    for (const other of [{ id: "45.2.4" }, { version: "45.2.1" }, { code: "advisory" }]) {
        assert.deepEqual(
            codes(check({ pinned: "45.2.0", when: at, exceptions: [exception(other)] })),
            ["newer-release:45.2.3"],
            JSON.stringify(other)
        );
    }
    const expired = check({ pinned: "45.2.0", when: new Date("2026-11-13T00:00:00Z"), exceptions: [exception()] });
    assert.deepEqual(codes(expired), ["newer-release:45.2.3"]);
    assert.equal(expired.flags[0].expiredException.expiresAt, "2026-11-13T00:00:00Z");
    assert.match(renderMarkdown(expired), /the exception expired 2026-11-13T00:00:00Z/);
});

test("a malformed exception fails the run instead of covering anything", () => {
    const bad = [
        [{ reviewedBy: "claude" }, /human approval/],
        [{ reviewedBy: "AI" }, /human approval/],
        [{ approval: undefined }, /human approval/],
        [{ approval: "https://example.test/ok" }, /human approval/],
        [{ control: "" }, /reason, an owner and a control/],
        [{ owner: undefined }, /reason, an owner and a control/],
        [{ id: "45.*" }, /wildcard/],
        [{ version: "45.2.?" }, /scope/],
        [{ code: "anything" }, /scope/],
        [{ expiresAt: "2026-11-06T00:00:00Z" }, /bounded/],
        [{ expiresAt: "2027-02-05T00:00:00Z" }, /bounded/],
        [{ createdAt: "2026-02-30T00:00:00Z" }, /exact valid/],
        [{ expiresAt: "2026-11-13" }, /ISO UTC/],
        [{ createdAt: "2026-11-08T00:00:00Z", expiresAt: "2026-11-10T00:00:00Z" }, /future/],
    ];
    for (const [extra, pattern] of bad) {
        rejects(() => check({ pinned: "45.2.0", exceptions: [exception(extra)] }), pattern);
    }
    rejects(() => validateExceptions({}, now), /list/);
    rejects(() => validateExceptions([exception(), exception()], now), /Ambiguous/);
    assert.equal(validateExceptions([exception(), exception({ id: "45.2.4" })], now).length, 2);
    assert.equal(
        validateExceptions([exception({ expiresAt: "2027-02-05T00:00:00Z", createdAt: "2026-11-07T00:00:00Z" })], now)
            .length,
        1
    );
});

test("what cannot be established fails the run: the pin, the feed, the lifecycle review, the option", () => {
    rejects(() => check({ pinned: "45.9.9" }), /not in the release feed/);
    rejects(() => check({ pinned: "45.2.3-beta.1" }), /stable version/);
    rejects(
        () =>
            evaluate({
                pinned: "45.2.3",
                feed: parseFeed(feedJson()),
                advisories: [],
                lifecycle: lifecycleOf("45.2.0"),
                now,
            }),
        /lifecycle review/
    );
    rejects(
        () =>
            evaluate({
                pinned: "45.2.3",
                feed: parseFeed(feedJson()),
                advisories: [],
                lifecycle: { version: "45.2.3" },
                now,
            }),
        /lifecycle review/
    );
    rejects(
        () =>
            evaluate({
                pinned: "45.2.3",
                feed: parseFeed(feedJson()),
                advisories: [],
                lifecycle: lifecycleOf("45.2.3", "2027-02-30"),
                now,
            }),
        /end of support/
    );
    rejects(
        () =>
            evaluate({
                pinned: "45.2.3",
                feed: parseFeed(feedJson()),
                advisories: [],
                lifecycle: lifecycleOf("45.2.3"),
                now: new Date("nope"),
            }),
        /current time/
    );
    for (const maxAgeDays of [0, 31, 1.5, NaN]) {
        rejects(() => check({ maxAgeDays }), /max-age-days/);
    }
    rejects(() => parseFeed({}), /not a list/);
    rejects(() => parseFeed([]), /not a list/);
    rejects(() => parseFeed([release("45.0.0-beta.1", "2026-10-01T00:00:00.000Z")]), /no stable release/);
    rejects(() => parseFeed([{ version: "45.2.3", date: "someday" }]), /valid date/);
    rejects(() => parseAdvisories({}), /not a list/);
    rejects(() => parseAdvisories([{ summary: "no id" }]), /no identifier/);
    rejects(
        () =>
            check({
                advisories: [
                    advisoryJson({
                        vulnerabilities: [
                            {
                                package: { ecosystem: "npm", name: "electron" },
                                vulnerable_version_range: "sometimes",
                                patched_versions: "",
                            },
                        ],
                    }),
                ],
            }),
        /range/
    );
});

function writeRoot(directory, { pinned = "45.2.3", locked = pinned, reviewed = pinned, exceptions } = {}) {
    fs.mkdirSync(path.join(directory, "security"), { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ devDependencies: { electron: pinned } }));
    fs.writeFileSync(
        path.join(directory, "package-lock.json"),
        JSON.stringify({
            packages: { "": { devDependencies: { electron: locked } }, "node_modules/electron": { version: locked } },
        })
    );
    const policy = {
        electronLifecycle: { version: reviewed, tentativeEndOfSupport: "2027-04-27" },
        ...(exceptions ? { electronExceptions: exceptions } : {}),
    };
    fs.writeFileSync(path.join(directory, "security/dependencies.json"), JSON.stringify(policy));
}

test("the pin must be exact and agree across package.json, the lock and the lifecycle review", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mt-electron-pin-"));
    try {
        writeRoot(directory);
        assert.equal(readPin(directory).pinned, "45.2.3");
        assert.deepEqual(readPin(directory).exceptions, []);
        for (const options of [{ locked: "45.2.0" }, { pinned: "^45.2.3" }]) {
            writeRoot(directory, options);
            rejects(() => readPin(directory), /pin|lock/);
        }
        fs.rmSync(path.join(directory, "package.json"));
        rejects(() => readPin(directory), /Could not read package\.json/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("the repository's own pin, lock and lifecycle review agree", () => {
    const root = new URL("../../", import.meta.url).pathname;
    const { pinned, lifecycle } = readPin(root);
    assert.equal(lifecycle.version, pinned);
});

function run(args, root) {
    const result = spawnSync(process.execPath, [script, "--root", root, ...args], {
        encoding: "utf8",
        timeout: 60_000,
        env: { PATH: process.env.PATH },
    });
    return { status: result.status, out: result.stdout, err: result.stderr };
}

test("the command exits 0 when current, 1 for findings only under --enforce, 2 when it cannot tell", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mt-electron-cli-"));
    try {
        const feed = path.join(directory, "feed.json");
        const advisories = path.join(directory, "advisories.json");
        fs.writeFileSync(feed, JSON.stringify(feedJson()));
        fs.writeFileSync(advisories, JSON.stringify([advisoryJson()]));
        const root = path.join(directory, "root");
        const common = ["--feed", feed, "--advisories", advisories, "--now", now.toISOString()];
        writeRoot(root);
        const current = run([...common, "--enforce"], root);
        assert.equal(current.status, 0, current.err);
        assert.match(current.out, /45\.2\.3 is current/);

        writeRoot(root, { pinned: "45.2.0" });
        const stale = run([...common, "--enforce"], root);
        assert.equal(stale.status, 1, stale.err);
        assert.match(stale.out, /needs an update/);
        assert.match(stale.out, /::error title=Electron engine::Electron 45\.2\.3 is out/);
        assert.match(stale.out, /scripts\/moltenterm-qualify-packaged\.mjs/);
        const report = run([...common, "--json"], root);
        assert.equal(report.status, 0, "findings alone do not fail a report");
        assert.deepEqual(
            JSON.parse(report.out)
                .flags.map((flag) => flag.code)
                .sort(),
            ["advisory", "newer-release"]
        );

        writeRoot(root, {
            pinned: "45.2.0",
            exceptions: [
                exception({ createdAt: "2026-11-05T00:00:00Z" }),
                exception({ code: "advisory", id: "GHSA-aaaa-bbbb-cccc" }),
            ],
        });
        assert.equal(run([...common, "--enforce"], root).status, 0, "reviewed exceptions release it");

        fs.writeFileSync(feed, "not json");
        const unreadable = run([...common, "--enforce"], root);
        assert.equal(unreadable.status, 2);
        assert.match(unreadable.err, /Could not read the release feed/);
        assert.equal(run(["--unknown"], root).status, 2);
        assert.equal(run(["--now"], root).status, 2);
        assert.equal(run([...common, "--max-age-days", "0"], root).status, 2);
        assert.equal(run([...common, "--issue", "--repo", "not a repo"], root).status, 2);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("main reports through its output, the step summary and the issue sync", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mt-electron-main-"));
    try {
        const feed = path.join(directory, "feed.json");
        const advisories = path.join(directory, "advisories.json");
        const summary = path.join(directory, "summary.md");
        fs.writeFileSync(feed, JSON.stringify(feedJson()));
        fs.writeFileSync(advisories, "[]");
        const root = path.join(directory, "root");
        writeRoot(root, { pinned: "45.2.0" });
        const lines = [];
        const calls = [];
        const fake = (args) => {
            calls.push(args);
            return args[0] === "issue" && args[1] === "list" ? "[]" : args[0] === "label" ? "[]" : "";
        };
        const code = await main(
            [
                "--root",
                root,
                "--feed",
                feed,
                "--advisories",
                advisories,
                "--now",
                now.toISOString(),
                "--issue",
                "--repo",
                "DiamondForgeFr/moltenterm",
            ],
            { GITHUB_STEP_SUMMARY: summary },
            { run: fake, out: (line) => lines.push(line) }
        );
        assert.equal(code, 0);
        assert.ok(fs.readFileSync(summary, "utf8").includes("needs an update"));
        assert.ok(calls.some((args) => args[0] === "issue" && args[1] === "create"));
        assert.ok(lines.includes(`Issue "${IssueTitle}": created`));
        const failing = await main(
            [
                "--root",
                root,
                "--feed",
                feed,
                "--advisories",
                advisories,
                "--now",
                now.toISOString(),
                "--issue",
                "--repo",
                "DiamondForgeFr/moltenterm",
            ],
            {},
            {
                run: () => {
                    throw new Error("gh failed");
                },
                out: () => {},
            }
        );
        assert.equal(failing, 2, "a failed gh call is not a pass");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("the network reads are retried, paged and authenticated, and a read that keeps failing is never a pass", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mt-electron-net-"));
    const realFetch = globalThis.fetch;
    const realError = console.error;
    try {
        writeRoot(directory, { pinned: "45.2.0" });
        const args = ["--root", directory, "--json", "--now", now.toISOString()];
        const quiet = { out: () => {}, retryDelayMs: 1 };
        const messages = [];
        console.error = (message) => messages.push(String(message));

        const attempts = [];
        globalThis.fetch = async (url) => {
            attempts.push(url);
            throw new Error("offline");
        };
        assert.equal(await main(args, {}, quiet), 2);
        assert.equal(attempts.length, 3, "three attempts at the release feed, then it gives up");
        assert.match(
            messages.join("\n"),
            /Could not read https:\/\/releases\.electronjs\.org\/releases\.json: offline/
        );

        let calls = 0;
        const seen = [];
        const other = (index) =>
            advisoryJson({
                ghsa_id: `GHSA-0000-0000-${String(index).padStart(4, "0")}`,
                vulnerabilities: [
                    {
                        package: { ecosystem: "npm", name: "left-pad" },
                        vulnerable_version_range: "< 99.0.0",
                        patched_versions: "99.0.0",
                    },
                ],
            });
        const respond = (body) => ({ ok: true, status: 200, json: async () => body });
        globalThis.fetch = async (url, init) => {
            seen.push({ url, authorization: init.headers.Authorization });
            calls++;
            if (calls === 1) {
                return { ok: false, status: 503, json: async () => ({}) };
            }
            if (url.startsWith("https://releases.electronjs.org/")) {
                return respond(feedJson());
            }
            return respond(
                url.endsWith("page=1")
                    ? Array.from({ length: 100 }, (_, index) => other(index))
                    : [advisoryJson({ severity: "critical" })]
            );
        };
        const lines = [];
        assert.equal(
            await main(args, { GH_TOKEN: "token-from-env" }, { ...quiet, out: (line) => lines.push(line) }),
            0
        );
        const urls = seen.map((entry) => entry.url);
        assert.deepEqual(
            urls.slice(0, 2),
            ["https://releases.electronjs.org/releases.json", "https://releases.electronjs.org/releases.json"],
            "a 503 is retried"
        );
        assert.deepEqual(
            urls.slice(2),
            [
                "https://api.github.com/repos/electron/electron/security-advisories?per_page=100&page=1",
                "https://api.github.com/repos/electron/electron/security-advisories?per_page=100&page=2",
            ],
            "a full page asks for the next"
        );
        assert.deepEqual(
            seen.map((entry) => entry.authorization),
            [undefined, undefined, "Bearer token-from-env", "Bearer token-from-env"],
            "the token goes to GitHub only"
        );
        assert.deepEqual(
            JSON.parse(lines[0])
                .flags.map((flag) => flag.code)
                .sort(),
            ["advisory", "newer-release"]
        );

        messages.length = 0;
        globalThis.fetch = async (url) =>
            url.startsWith("https://releases.electronjs.org/")
                ? respond(feedJson())
                : { ok: false, status: 403, json: async () => ({}) };
        assert.equal(await main(args, {}, quiet), 2, "advisories that cannot be read are not 'no advisory'");
        assert.match(messages.join("\n"), /security-advisories.*HTTP 403/);
    } finally {
        globalThis.fetch = realFetch;
        console.error = realError;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("the report keeps advisory text from marking up the issue, breaking its table or mentioning anyone", () => {
    const hostile = advisoryJson({
        severity: "critical",
        summary: "x | y <img src=x onerror=alert(1)> `code` @someone\nnext",
    });
    const markdown = renderMarkdown(
        check({ pinned: "45.2.0", when: new Date("2026-10-31T00:00:00Z"), advisories: [hostile] })
    );
    assert.ok(!markdown.includes("<img"));
    assert.ok(markdown.includes("&lt;img"));
    assert.ok(markdown.includes("x &#124; y"));
    assert.ok(!markdown.includes("@someone"));
    assert.ok(!/`code`/.test(markdown));
    const row = markdown.split("\n").find((line) => line.includes("GHSA-aaaa-bbbb-cccc"));
    assert.equal(row.split(/(?<!&#124;)\|/).length, 5, "a row keeps its three cells");
    assert.match(markdown, /<!-- electron-staleness:[0-9a-f]{16} -->/);
});

function fakeGh({ issues = [], labels = [{ name: IssueLabel }] } = {}) {
    const calls = [];
    const run = (args) => {
        calls.push(args);
        const [group, action] = args;
        if (group === "issue" && action === "list") {
            return JSON.stringify(issues);
        }
        if (group === "label" && action === "list") {
            return JSON.stringify(labels);
        }
        return "";
    };
    const did = (group, action) => calls.filter((args) => args[0] === group && args[1] === action);
    return { calls, run, did };
}
const staleReport = () => check({ pinned: "45.2.0", when: new Date("2026-11-07T01:00:00Z") });
const repo = "DiamondForgeFr/moltenterm";

test("the issue is opened once, left alone while the findings are the same, updated when they change, closed when none is left", () => {
    const report = staleReport();
    const markdown = renderMarkdown(report);

    const opened = fakeGh({ labels: [] });
    assert.equal(syncIssue(report, markdown, { run: opened.run, repo }), "created");
    assert.equal(opened.did("label", "create").length, 1, "the security label is created when missing");
    const [create] = opened.did("issue", "create");
    assert.ok(create.includes(IssueTitle) && create.includes(IssueLabel) && create.includes(markdown));
    assert.ok(
        opened.calls.every((args) => args.join(" ").endsWith(`--repo ${repo}`)),
        "every gh call names the repository"
    );

    const open = { number: 7, title: IssueTitle, body: markdown, labels: [{ name: IssueLabel }] };
    const same = fakeGh({ issues: [open] });
    assert.equal(syncIssue(report, markdown, { run: same.run, repo }), "unchanged");
    assert.equal(
        same.did("issue", "edit").length + same.did("issue", "comment").length + same.did("issue", "create").length,
        0
    );

    const changed = fakeGh({ issues: [{ ...open, body: "old\n<!-- electron-staleness:0000000000000000 -->" }] });
    assert.equal(syncIssue(report, markdown, { run: changed.run, repo }), "updated");
    assert.equal(changed.did("issue", "edit").length, 1);
    assert.equal(changed.did("issue", "comment").length, 1);

    const unlabelled = fakeGh({ issues: [{ ...open, labels: [] }] });
    assert.equal(syncIssue(report, markdown, { run: unlabelled.run, repo }), "unchanged");
    assert.ok(unlabelled.did("issue", "edit")[0].includes("--add-label"));

    const current = check({ pinned: "45.2.3" });
    const closing = fakeGh({ issues: [open] });
    assert.equal(syncIssue(current, renderMarkdown(current), { run: closing.run, repo }), "closed");
    assert.equal(closing.did("issue", "comment").length, 1);
    assert.deepEqual(closing.did("issue", "close")[0].slice(0, 4), ["issue", "close", "7", "--reason"]);
    assert.equal(syncIssue(current, renderMarkdown(current), { run: fakeGh().run, repo }), "none");
});

test("only the issue with the exact title is touched, the oldest if several", () => {
    const report = staleReport();
    const markdown = renderMarkdown(report);
    const gh = fakeGh({
        issues: [
            { number: 3, title: `${IssueTitle} (copy)`, body: "", labels: [] },
            { number: 9, title: IssueTitle, body: "", labels: [{ name: IssueLabel }] },
            { number: 5, title: IssueTitle, body: "", labels: [{ name: IssueLabel }] },
        ],
    });
    assert.equal(syncIssue(report, markdown, { run: gh.run, repo }), "updated");
    assert.equal(gh.did("issue", "edit")[0][2], "5");
    const current = check({ pinned: "45.2.3" });
    const none = fakeGh({ issues: [{ number: 3, title: `${IssueTitle} (copy)`, body: "", labels: [] }] });
    assert.equal(syncIssue(current, renderMarkdown(current), { run: none.run, repo }), "none");
    assert.equal(none.did("issue", "close").length, 0);
    rejects(() => syncIssue(report, markdown, { run: gh.run }), /--repo/);
    rejects(() => syncIssue(report, markdown, { run: gh.run, repo: "--repo evil" }), /--repo/);
});

test("the issue key follows the pin and the findings, not their wording or the clock", () => {
    const first = staleReport();
    const later = check({ pinned: "45.2.0", when: new Date("2026-11-08T05:00:00Z") });
    assert.equal(reportKey(first), reportKey(later));
    assert.notEqual(
        reportKey(first),
        reportKey(check({ pinned: "45.2.0", when: new Date("2026-11-07T01:00:00Z"), advisories: [advisoryJson()] }))
    );
    assert.notEqual(reportKey(first), reportKey(check({ pinned: "45.2.1", when: new Date("2026-11-20T00:00:00Z") })));
});

test("workflow contracts: the daily check raises the issue, the release enforces, nothing else is stopped, no secret is used", () => {
    const daily = repoFile(".github/workflows/electron-staleness.yml");
    assert.match(daily, /^ {4}schedule:\n {8}- cron: "\d+ \d+ \* \* \*"$/m, "daily");
    assert.match(daily, /^ {4}workflow_dispatch:$/m);
    assert.match(daily, /^ {4}issues: write$/m);
    assert.match(daily, /^ {4}contents: read$/m);
    assert.ok(
        daily.includes("ISSUE: ${{ github.event_name != 'pull_request' && '--issue' || '' }}"),
        "a pull request opens nothing"
    );
    assert.ok(daily.includes('node scripts/security/electron-staleness.mjs --max-age-days "$MAX_AGE_DAYS" $ISSUE'));
    assert.ok(!daily.includes("--enforce"), "the daily run reports, only the release stops");
    assert.ok(!/\$\{\{[^}]*\bsecrets\./.test(daily));

    const scan = repoFile(".github/workflows/security-scan.yml");
    const step =
        scan.match(/ {12}- name: Electron engine staleness \(release only\)\n([\s\S]*?)(?=\n {12}- |\n*$)/)?.[1] ?? "";
    assert.ok(step.includes("run: node scripts/security/electron-staleness.mjs --enforce"));
    const condition = step.match(/^ {14}if: (.*)$/m)?.[1] ?? "";
    assert.ok(condition.includes("github.ref_type == 'tag'"), condition);
    assert.ok(
        condition.includes("github.event_name == 'workflow_dispatch'") &&
            condition.includes("'.github/workflows/release.yml@'"),
        condition
    );
    assert.ok(!condition.includes("pull_request") && !condition.includes("schedule"), condition);
    assert.ok(
        condition.includes("!cancelled()"),
        "it runs even when the scan before it failed, so a release sees both"
    );
    assert.ok(step.includes("GH_TOKEN: ${{ github.token }}"));
    assert.ok(!/\$\{\{[^}]*\bsecrets\./.test(scan) && !scan.includes("npm ci"));
    assert.ok(scan.includes("scripts/security/electron-staleness-check.mjs"), "the release job runs this file");

    const release = repoFile(".github/workflows/release.yml");
    assert.match(release, /^ {8}tags: \["v\*"\]$/m);
    assert.match(release, /^ {4}workflow_dispatch:$/m);
    assert.ok(
        /^ {4}security:\n {8}name: Dependency security\n {8}uses: \.\/\.github\/workflows\/security-scan\.yml$/m.test(
            release
        )
    );
    assert.match(
        repoFile("Taskfile.yml"),
        /security:test:[\s\S]*?cmd: node --test scripts\/security\/policy-check\.mjs scripts\/security\/electron-staleness-check\.mjs/
    );
});

test("the policy document names the deadlines, the checks, the exceptions and the packaged-build requalification", () => {
    const policy = repoFile("security/ELECTRON.md");
    for (const needle of [
        "scripts/moltenterm-qualify-packaged.mjs",
        "scripts/moltenterm-check-fuses.mjs",
        "scripts/security/electron-staleness.mjs",
        "electron-staleness.yml",
        "electronExceptions",
        "electronLifecycle",
        "3 days",
        "7 days",
        "30 days",
        "latest three stable majors",
        "newer-release",
        "advisory",
        "end-of-support",
        "unsupported-line",
    ]) {
        assert.ok(policy.includes(needle), needle);
    }
    assert.ok(repoFile("security/README.md").includes("ELECTRON.md"), "the dependency security README points to it");
    assert.ok(repoFile("security/UPGRADES.md").includes("ELECTRON.md"));
});
