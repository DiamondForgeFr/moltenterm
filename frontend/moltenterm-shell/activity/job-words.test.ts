// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a sub-agent waits for, in plain words (#2502): every kind wavesrv names has its words in both languages, and a
// kind a window does not know is "a command".

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enLocale from "../i18n/locales/en.json";
import frLocale from "../i18n/locales/fr.json";
import {
    jobCategory,
    JobKinds,
    jobLabel,
    jobLine,
    jobsView,
    subagentTaskTitle,
    subagentTicket,
    waitingWords,
} from "./job-words";

const fakeT = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}${JSON.stringify(vars)}` : key);
// Read at collection time, where a loaded machine costs no test its 5 s.
const GoSource = readFileSync(new URL("../../../pkg/molten/agentwork.go", import.meta.url), "utf8");

function wordsOf(dict: any, key: string): string {
    return key.split(".").reduce((node, part) => node?.[part], dict.activity);
}

describe("the words of a job", () => {
    it("has words for every kind wavesrv names, in both languages, and for what a sub-agent waits on", () => {
        const keys = [
            ...JobKinds.map((kind) => `job.${kind}`),
            "job.npmrunArg",
            "sub.waiting.tests",
            "sub.waiting.build",
            "sub.waiting.ci",
            "sub.waiting.command",
            "sub.waitingWork",
            "sub.working",
            "sub.since",
            "sub.jobMore",
            "sub.untitled",
        ];
        for (const dict of [enLocale, frLocale]) {
            for (const key of keys) {
                expect(typeof wordsOf(dict, key), key).toBe("string");
            }
        }
        expect(wordsOf(enLocale, "job.npmrunArg")).toContain("{script}");
        expect(wordsOf(frLocale, "job.npmrunArg")).toContain("{script}");
        expect(wordsOf(enLocale, "sub.since")).toContain("{age}");
        expect(wordsOf(enLocale, "sub.jobMore")).toContain("{count}");
    });

    it("keeps the kinds in step with pkg/molten/agentwork.go", () => {
        const goKinds = [...GoSource.matchAll(/^\s+Job\w+\s+=\s+"([a-z]+)"$/gm)].map((m) => m[1]).sort();
        expect(goKinds).toEqual([...JobKinds].sort());
    });

    it("names a job by its kind, a script with its name, and an unknown kind a command", () => {
        expect(jobLabel(fakeT, { kind: "vitest" })).toBe("activity.job.vitest");
        expect(jobLabel(fakeT, { kind: "buildbackend" })).toBe("activity.job.buildbackend");
        expect(jobLabel(fakeT, { kind: "npmrun", arg: "lint" })).toBe('activity.job.npmrunArg{"script":"lint"}');
        expect(jobLabel(fakeT, { kind: "npmrun" })).toBe("activity.job.npmrun");
        expect(jobLabel(fakeT, { kind: "from-a-newer-wavesrv" })).toBe("activity.job.command");
        expect(jobLabel(fakeT, { kind: "" })).toBe("activity.job.command");
    });

    it("says what a sub-agent waits for from its job: tests, a build, the CI, else a command", () => {
        expect(["vitest", "gotest", "tests", "affected", "check"].map(jobCategory)).toEqual(Array(5).fill("tests"));
        expect(["buildfrontend", "buildbackend", "build", "perf"].map(jobCategory)).toEqual(Array(4).fill("build"));
        expect(jobCategory("moltenci")).toBe("ci");
        expect(["npmrun", "command", "other"].map(jobCategory)).toEqual(Array(3).fill("command"));
        expect(waitingWords(fakeT, "tests")).toBe("activity.sub.waiting.tests");
        expect(waitingWords(fakeT, "build")).toBe("activity.sub.waiting.build");
        expect(waitingWords(fakeT, null)).toBe("activity.sub.waitingWork");
    });

    it("names the oldest job of a sub-agent and counts the others", () => {
        expect(jobsView(fakeT, [])).toBeNull();
        expect(jobsView(fakeT, undefined)).toBeNull();
        const view = jobsView(fakeT, [
            { kind: "gotest", since: 5 },
            { kind: "build", since: 9 },
        ]);
        expect(view).toEqual({ label: "activity.job.gotest", since: 5, more: 1, category: "tests" });
        expect(jobLine(fakeT, view)).toBe('activity.sub.jobMore{"job":"activity.job.gotest","count":1}');
        expect(jobLine(fakeT, jobsView(fakeT, [{ kind: "perf" }]))).toBe("activity.job.perf");
    });

    it("reads a sub-agent's ticket and title from its task, and never takes a #N from the middle of it", () => {
        expect(subagentTicket("#2496 tree scans")).toBe(2496);
        expect(subagentTicket("  #7: fix")).toBe(7);
        expect(subagentTicket("Port the fix from #2391")).toBe(0);
        expect(subagentTicket("")).toBe(0);
        expect(subagentTicket(undefined)).toBe(0);
        expect(subagentTaskTitle("#2496 tree scans")).toBe("tree scans");
        expect(subagentTaskTitle("#2496: tree scans")).toBe("tree scans");
        expect(subagentTaskTitle("Port the fix from #2391")).toBe("Port the fix from #2391");
        expect(subagentTaskTitle(undefined)).toBe("");
    });
});

describe("the words keep the project's rules", () => {
    it("never names the machine or the system in a job's words, and the French colons take a no-break space", () => {
        const texts = ["job", "sub", "load"].flatMap((group) => {
            const node = (enLocale as any).activity[group];
            return JSON.stringify(node);
        });
        expect(texts.join(" ")).not.toMatch(/\b(Mac|macOS|Finder|Windows)\b/);
        const fr = JSON.stringify((frLocale as any).activity.sub) + JSON.stringify((frLocale as any).activity.load);
        expect(fr).not.toMatch(/\S :/);
    });
});
