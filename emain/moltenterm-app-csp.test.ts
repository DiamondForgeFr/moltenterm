// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    AppCspAllowances,
    AppCspDeps,
    AppCspSession,
    buildAppCsp,
    configureAppCsp,
    CspHeader,
    cspModeFromEnv,
    CspReportOnlyHeader,
    CspViolationLog,
    isAppResponse,
    parseCspViolation,
    withAppCsp,
} from "./moltenterm-app-csp";

const Web = "http://127.0.0.1:41234";
const Ws = "ws://127.0.0.1:41235";
const DevOrigin = "http://localhost:5173";

function directivesOf(policy: string): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const part of policy.split(";")) {
        const [name, ...values] = part.trim().split(/\s+/);
        if (name) result.set(name, values);
    }
    return result;
}

function policy(extra: Partial<Parameters<typeof buildAppCsp>[0]> = {}): string {
    return buildAppCsp({ webEndpoint: Web, wsEndpoint: Ws, ...extra });
}

describe("app page policy", () => {
    it("denies everything it does not name, and forbids plug-ins, framing and forms", () => {
        const directives = directivesOf(policy());
        expect(directives.get("default-src")).toEqual(["'none'"]);
        expect(directives.get("object-src")).toEqual(["'none'"]);
        expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
        expect(directives.get("form-action")).toEqual(["'none'"]);
        expect(directives.get("base-uri")).toEqual(["'self'"]);
    });

    it("runs only the app's own scripts and its mods: no inline, no eval, no remote origin", () => {
        const script = directivesOf(policy()).get("script-src");
        expect(script).toEqual(["'self'", "'wasm-unsafe-eval'", "blob:"]);
        expect(policy()).not.toContain("'unsafe-eval'");
        expect(policy()).not.toContain("'strict-dynamic'");
    });

    it("lets the mod host import a mod from a blob URL, the way a mod is loaded", () => {
        expect(directivesOf(policy()).get("script-src")).toContain("blob:");
        expect(directivesOf(policy()).get("img-src")).toContain("blob:");
        // Nothing else starts from a blob URL.
        expect(directivesOf(policy()).get("worker-src")).toEqual(["'self'"]);
        expect(directivesOf(policy()).get("connect-src")).not.toContain("blob:");
    });

    it("lets the page reach its own backend and nothing else", () => {
        const connect = directivesOf(policy()).get("connect-src");
        expect(connect).toEqual([Web, Ws]);
        expect(directivesOf(policy()).get("frame-src")).toEqual([Web]);
    });

    it("opens no directive to a wildcard, and only images to a whole scheme", () => {
        for (const [name, values] of directivesOf(policy())) {
            for (const value of values) {
                expect(value, name).not.toBe("*");
                if (name === "img-src") continue;
                for (const scheme of ["http:", "https:", "ws:", "wss:", "data:", "blob:", "file:"]) {
                    if (name === "font-src" && scheme === "data:") continue;
                    if (name === "script-src" && scheme === "blob:") continue;
                    expect(value, name).not.toBe(scheme);
                }
            }
        }
        expect(directivesOf(policy()).get("img-src")).toEqual(["'self'", "data:", "blob:", "http:", "https:"]);
        expect(directivesOf(policy()).get("font-src")).toEqual(["'self'", "data:"]);
    });

    it("drops frame-ancestors from a report-only policy, where it would only warn", () => {
        expect(policy({ reportOnly: true })).not.toContain("frame-ancestors");
        expect(policy({ reportOnly: false })).toContain("frame-ancestors 'none'");
    });

    it("leaves a backend that cannot be read out of every directive, rather than allowing everything", () => {
        const text = buildAppCsp({ webEndpoint: "", wsEndpoint: "not a url" });
        expect(directivesOf(text).get("connect-src")).toEqual([]);
        expect(directivesOf(text).get("frame-src")).toEqual([]);
        expect(text).not.toContain("undefined");
    });

    it("gives the dev server what its hot reload needs, and only in dev", () => {
        const dev = directivesOf(policy({ devOrigin: DevOrigin }));
        expect(dev.get("script-src")).toContain("'unsafe-inline'");
        expect(dev.get("connect-src")).toEqual(expect.arrayContaining([DevOrigin, "ws://localhost:5173"]));
        const prod = directivesOf(policy());
        expect(prod.get("script-src")).not.toContain("'unsafe-inline'");
        expect(prod.get("connect-src")).not.toContain(DevOrigin);
    });

    it("lets only the builder window reach the app it builds on this computer", () => {
        expect(directivesOf(policy({ builder: true })).get("connect-src")).toContain("http://localhost:*");
        expect(policy()).not.toContain("localhost");
    });

    it("lists every allowance beyond 'self' with its reason, and no allowance without one", () => {
        const expand = (value: string) => (value === Web ? "<backend>" : value === Ws ? "<backend>" : value);
        const built = new Set<string>();
        for (const [name, values] of directivesOf(policy())) {
            if (["default-src", "object-src", "frame-ancestors", "form-action", "base-uri"].includes(name)) continue;
            for (const value of values) built.add(`${name} ${expand(value)}`);
        }
        const listed = new Set(AppCspAllowances.map(([name, value]) => `${name} ${value}`));
        expect([...built].filter((entry) => !listed.has(entry))).toEqual([]);
        expect([...listed].filter((entry) => !built.has(entry))).toEqual([]);
        for (const [, , reason] of AppCspAllowances) expect(reason.length).toBeGreaterThan(10);
    });
});

describe("the page the policy protects", () => {
    it("has no inline script, event handler attribute or javascript: address that the policy would block", () => {
        const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
        expect(scripts.length).toBeGreaterThan(0);
        for (const [, attributes, body] of scripts) {
            expect(attributes).toMatch(/\bsrc=/);
            expect(body.trim()).toBe("");
        }
        expect(html).not.toMatch(/\son[a-z]+\s*=/i);
        expect(html).not.toMatch(/javascript:/i);
    });
});

describe("headers of an app response", () => {
    it("sets the policy and removes any other policy, whatever the case of its name", () => {
        const headers = withAppCsp(
            {
                "content-security-policy": ["script-src *"],
                "Content-Security-Policy-Report-Only": ["default-src *"],
                "Content-Type": ["text/html"],
            },
            "default-src 'none'",
            false
        );
        expect(headers).toEqual({ "Content-Type": ["text/html"], [CspHeader]: ["default-src 'none'"] });
    });

    it("uses the report-only header in report-only mode, and no enforced one", () => {
        const headers = withAppCsp({ "Content-Security-Policy": ["script-src *"] }, "default-src 'none'", true);
        expect(headers).toEqual({ [CspReportOnlyHeader]: ["default-src 'none'"] });
    });

    it("accepts a response without headers", () => {
        expect(withAppCsp(undefined, "default-src 'none'", false)).toEqual({ [CspHeader]: ["default-src 'none'"] });
    });

    it("sees the packaged page's files and the dev server's, and nothing else", () => {
        expect(isAppResponse("file:///app/frontend/index.html")).toBe(true);
        expect(isAppResponse("file:///app/frontend/assets/monaco-worker.js")).toBe(true);
        expect(isAppResponse("http://localhost:5173/index.html", DevOrigin)).toBe(true);
        expect(isAppResponse("http://localhost:5173/index.html")).toBe(false);
        expect(isAppResponse("http://localhost:5174/index.html", DevOrigin)).toBe(false);
        expect(isAppResponse(`${Web}/wave/file`, DevOrigin)).toBe(false);
        expect(isAppResponse("https://example.test/", DevOrigin)).toBe(false);
        expect(isAppResponse("not a url", DevOrigin)).toBe(false);
    });
});

function fakeSession() {
    const state = { listener: null as Parameters<AppCspSession["webRequest"]["onHeadersReceived"]>[1] | null };
    const session: AppCspSession = {
        webRequest: {
            onHeadersReceived: (_filter, listener) => {
                state.listener = listener;
            },
        },
    };
    const respond = (url: string, webContentsId?: number, responseHeaders?: Record<string, string[]>) => {
        let result: { responseHeaders?: Record<string, string[]> } | undefined;
        state.listener!({ url, webContentsId, responseHeaders }, (value) => {
            result = value;
        });
        return result;
    };
    return { session, respond };
}

function deps(extra: Partial<AppCspDeps> = {}): AppCspDeps {
    return { webEndpoint: () => Web, wsEndpoint: () => Ws, reportOnly: false, isBuilder: () => false, ...extra };
}

describe("app session hook", () => {
    it("sets the policy on the app's own files and leaves every other response as it came", () => {
        const { session, respond } = fakeSession();
        configureAppCsp(session, deps());
        const page = respond("file:///app/frontend/index.html", 3, { "Content-Type": ["text/html"] });
        expect(page?.responseHeaders?.[CspHeader]?.[0]).toBe(policy());
        const worker = respond("file:///app/frontend/assets/editor.worker.js", 3);
        expect(worker?.responseHeaders?.[CspHeader]?.[0]).toBe(policy());
        const backend = { "Content-Type": ["application/pdf"] };
        expect(respond(`${Web}/wave/preview-resource/abc`, 3, backend)?.responseHeaders).toBe(backend);
        expect(respond("https://example.test/", 3, backend)?.responseHeaders).toBe(backend);
    });

    it("reads the backend endpoints when the response arrives, not when the hook is installed", () => {
        const { session, respond } = fakeSession();
        let current = "http://127.0.0.1:1111";
        configureAppCsp(session, deps({ webEndpoint: () => current }));
        current = "http://127.0.0.1:2222";
        expect(respond("file:///app/frontend/index.html")?.responseHeaders?.[CspHeader]?.[0]).toContain(current);
    });

    it("enforces by default and only reports when asked to", () => {
        const enforced = fakeSession();
        configureAppCsp(enforced.session, deps());
        const headers = enforced.respond("file:///app/frontend/index.html")?.responseHeaders ?? {};
        expect(Object.keys(headers)).toEqual([CspHeader]);
        const reporting = fakeSession();
        configureAppCsp(reporting.session, deps({ reportOnly: true }));
        const reported = reporting.respond("file:///app/frontend/index.html")?.responseHeaders ?? {};
        expect(Object.keys(reported)).toEqual([CspReportOnlyHeader]);
        expect(reported[CspReportOnlyHeader][0]).not.toContain("frame-ancestors");
    });

    it("gives the builder window, and only it, the connection to the app it builds", () => {
        const { session, respond } = fakeSession();
        configureAppCsp(session, deps({ isBuilder: (id) => id === 9 }));
        expect(respond("file:///app/frontend/index.html", 9)?.responseHeaders?.[CspHeader]?.[0]).toContain(
            "http://localhost:*"
        );
        expect(respond("file:///app/frontend/index.html", 3)?.responseHeaders?.[CspHeader]?.[0]).not.toContain(
            "localhost"
        );
        expect(respond("file:///app/frontend/index.html")?.responseHeaders?.[CspHeader]?.[0]).not.toContain(
            "localhost"
        );
    });

    it("always answers the request, and sends it on as it came when the policy cannot be built", () => {
        const { session, respond } = fakeSession();
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        configureAppCsp(
            session,
            deps({
                webEndpoint: () => {
                    throw new Error("endpoint unavailable");
                },
            })
        );
        const original = { "Content-Type": ["text/html"] };
        expect(respond("file:///app/frontend/index.html", 3, original)?.responseHeaders).toBe(original);
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });
});

describe("mode", () => {
    it("enforces a packaged build unless the environment asks for report-only, and nothing turns it off", () => {
        expect(cspModeFromEnv({})).toBe("enforce");
        expect(cspModeFromEnv({}, false)).toBe("enforce");
        expect(cspModeFromEnv({ MOLTENTERM_CSP: "off" })).toBe("enforce");
        expect(cspModeFromEnv({ MOLTENTERM_CSP: "0" })).toBe("enforce");
        expect(cspModeFromEnv({ MOLTENTERM_CSP: "" })).toBe("enforce");
        expect(cspModeFromEnv({ MOLTENTERM_CSP: "report-only" })).toBe("report-only");
    });

    it("only reports under the dev server, unless the environment asks to enforce", () => {
        expect(cspModeFromEnv({}, true)).toBe("report-only");
        expect(cspModeFromEnv({ MOLTENTERM_CSP: "off" }, true)).toBe("report-only");
        expect(cspModeFromEnv({ MOLTENTERM_CSP: "report-only" }, true)).toBe("report-only");
        expect(cspModeFromEnv({ MOLTENTERM_CSP: "enforce" }, true)).toBe("enforce");
    });
});

describe("violation log", () => {
    // The wording of Electron 45's Chromium, copied from a test instance.
    const blocked =
        "Loading the image 'https://tracker.example/pixel.png' violates the following Content Security Policy directive: \"img-src 'self' data:\". The action has been blocked.";
    const reported =
        "Loading the image 'https://tracker.example/pixel.png' violates the following Content Security Policy directive: \"img-src 'self' data:\". The policy is report-only, so the violation has been logged but no further action has been taken.";

    it("reads what Chromium writes for a blocked and a report-only violation", () => {
        expect(parseCspViolation(blocked)).toEqual({
            reportOnly: false,
            directive: "img-src",
            what: "Loading the image 'https://tracker.example/pixel.png'",
        });
        expect(parseCspViolation(reported)?.reportOnly).toBe(true);
        expect(
            parseCspViolation(
                "Framing 'https://example.com/' violates the following report-only Content Security Policy directive: \"frame-src http://127.0.0.1:1\". The violation has been logged, but no further action has been taken."
            )
        ).toEqual({ reportOnly: true, directive: "frame-src", what: "Framing 'https://example.com/'" });
        expect(
            parseCspViolation(
                "Executing inline script violates the following Content Security Policy directive 'script-src 'self''. Either the 'unsafe-inline' keyword, a hash ('sha256-x'), or a nonce ('nonce-...') is required to enable inline execution. The action has been blocked."
            )
        ).toEqual({ reportOnly: false, directive: "script-src", what: "Executing inline script" });
        expect(
            parseCspViolation(
                "Applying inline style violates the following Content Security Policy directive 'style-src 'self''. Either the 'unsafe-inline' keyword, a hash ('sha256-x'), or a nonce ('nonce-...') is required to enable inline execution. The action has been blocked."
            )
        ).toEqual({ reportOnly: false, directive: "style-src", what: "Applying inline style" });
        expect(
            parseCspViolation(
                "Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: \"script-src 'self'\".\n The action has been blocked."
            )
        ).toEqual({ reportOnly: false, directive: "script-src", what: "Evaluating a string as JavaScript" });
    });

    it("still reads the older 'Refused to ...' wording", () => {
        expect(
            parseCspViolation(
                "Refused to load the image 'https://tracker.example/pixel.png' because it violates the following Content Security Policy directive: \"img-src 'self' data:\"."
            )
        ).toEqual({
            reportOnly: false,
            directive: "img-src",
            what: "load the image 'https://tracker.example/pixel.png'",
        });
        expect(
            parseCspViolation(
                "[Report Only] Refused to execute inline script because it violates the following Content Security Policy directive: \"script-src 'self'\"."
            )
        ).toEqual({ reportOnly: true, directive: "script-src", what: "execute inline script" });
    });

    it("does not take a report-only address for a report-only policy", () => {
        const address = blocked.replace("pixel.png", "The policy is report-only.png");
        expect(parseCspViolation(address)?.reportOnly).toBe(false);
    });

    it("ignores any other console line", () => {
        expect(parseCspViolation("Download the React DevTools")).toBeNull();
        expect(parseCspViolation("")).toBeNull();
    });

    it("writes each distinct violation once, with no control character from the page", () => {
        const lines: string[] = [];
        const log = new CspViolationLog((line) => lines.push(line));
        expect(log.note(blocked)).toBe(true);
        expect(log.note(blocked)).toBe(true);
        expect(log.note(reported)).toBe(true);
        expect(log.note("unrelated")).toBe(false);
        expect(lines).toEqual([
            "csp: blocked img-src: Loading the image 'https://tracker.example/pixel.png'",
            "csp: would block img-src: Loading the image 'https://tracker.example/pixel.png'",
        ]);
        const forged = new CspViolationLog((line) => lines.push(line));
        forged.note(blocked.replace("pixel.png", "a\nb\u0007c"));
        expect(lines[2]).toBe("csp: blocked img-src: Loading the image 'https://tracker.example/a b c'");
    });

    it("stops writing after a bounded number of distinct violations", () => {
        const lines: string[] = [];
        const log = new CspViolationLog((line) => lines.push(line));
        for (let i = 0; i < 500; i++) log.note(blocked.replace("pixel.png", `p${i}.png`));
        expect(lines.length).toBe(200);
    });
});
