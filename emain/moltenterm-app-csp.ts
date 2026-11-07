// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Content-Security-Policy of the application page (#1977, FR-BRW-014, browser audit finding M2). The renderer holds
// the privileged preload and the backend credentials, so a script injected into it (a markdown or HTML bug, a dependency)
// would have the app's whole reach; the policy is the second line. It is set here, on the responses of the private app
// session, and not by the page: the backend endpoints are only known to Electron main once wavesrv runs, and a header
// works for the packaged `file:` page as well as for the dev server. Guests of the browser panel use other sessions and
// keep the policy of the site they show.
//
// Every allowance beyond 'self' is listed with its reason in the table below, and `moltenterm-app-csp.test.ts` fails when
// the policy gains one that is not listed. The table is what a walk of the real app reported (a report-only run of the
// strictest policy, then every violation either fixed or allowed here), not a guess.
//
// What the policy deliberately refuses, and the app copes with: `eval` and `new Function` (zod probes for them once and
// takes its non-JIT path when refused; that shows as one `script-src` line in the log), inline scripts and event handler
// attributes (index.html has none), any plug-in or `<object>`, any form submission, a worker started from a blob URL.
// `'self'` covers the app's `file:` files (chunks, workers, Brokk's clips) but not a page's `blob:` URLs, hence the
// explicit `blob:` entries.

export const CspHeader = "Content-Security-Policy";
export const CspReportOnlyHeader = "Content-Security-Policy-Report-Only";
export const CspModeEnv = "MOLTENTERM_CSP";
export const CspReportOnlyMode = "report-only";
export const CspEnforceMode = "enforce";

export type AppCspOptions = {
    webEndpoint: string;
    wsEndpoint: string;
    // The origin of the Vite dev server, when the app runs from it.
    devOrigin?: string;
    // The builder window talks to the app it builds, which listens on a port of this computer chosen at run time.
    builder?: boolean;
    reportOnly?: boolean;
};

// Directive, source, why. The reasons are the contract: the code that needs one of them is named so that removing it
// later is a decision and not an accident.
export const AppCspAllowances: readonly (readonly [string, string, string])[] = [
    ["script-src", "'self'", "the app's bundle and chunks; nothing inline, no other origin"],
    [
        "script-src",
        "blob:",
        "the mod host imports each mod from a blob URL, revoked right after the import (molten-start.ts, importModule); 'self' does not cover blob URLs of a file: page",
    ],
    [
        "script-src",
        "'wasm-unsafe-eval'",
        "shiki's Oniguruma engine compiles a WebAssembly module for the code blocks of the AI panel (streamdown.tsx); it allows neither eval nor new Function",
    ],
    ["style-src", "'self'", "the app's style sheets"],
    [
        "style-src",
        "'unsafe-inline'",
        "forty-odd distinct inline styles at start alone: <style> elements and style attributes written by the editor, the terminal, diagrams and components",
    ],
    ["img-src", "'self'", "the app's images"],
    ["img-src", "data:", "the site icons Electron main keeps, the grain filter every surface wears, inline SVG icons"],
    [
        "img-src",
        "blob:",
        "the trimmed workspace logos (workspace-icon-trim.ts) and the images attached in the AI panel are object URLs",
    ],
    [
        "img-src",
        "<backend>",
        "the images the backend serves: workspace logos and materials (logoUrl), a markdown file's own images (markdown-util.ts, resolveRemoteFile), the preview and terminal stickers. No web address: the tab strips draw the icons main keeps (data:, browser-loading.ts tabFaviconSrc), and markdown shows a remote image as a link (remote-image.tsx, #2045)",
    ],
    ["font-src", "'self'", "the app's fonts and icon fonts"],
    ["font-src", "data:", "KaTeX inlines one small font as a data: URL in its built style sheet"],
    ["media-src", "'self'", "Brokk's video clips (@diamondforge/character) are files of the app"],
    ["media-src", "<backend>", "audio and video the backend streams to the preview"],
    [
        "connect-src",
        "<backend>",
        "the local backend, over HTTP and WebSocket: no other host is reachable from the app page",
    ],
    ["worker-src", "'self'", "the editor's workers are files of the app"],
    ["frame-src", "<backend>", "the PDF preview is a frame on a one-resource capability of the backend"],
];

function originOf(address: string): string | null {
    try {
        const { origin } = new URL(address);
        return origin === "null" ? null : origin;
    } catch {
        return null;
    }
}

function sources(...values: (string | null | undefined | false)[]): string {
    return values.filter((v): v is string => typeof v === "string" && v !== "").join(" ");
}

export function buildAppCsp(options: AppCspOptions): string {
    const web = originOf(options.webEndpoint);
    const ws = originOf(options.wsEndpoint);
    const dev = options.devOrigin ? originOf(options.devOrigin) : null;
    const devWs = dev?.replace(/^http/, "ws");
    const directives: string[] = [
        "default-src 'none'",
        `script-src ${sources("'self'", "'wasm-unsafe-eval'", "blob:", dev && "'unsafe-inline'")}`,
        "style-src 'self' 'unsafe-inline'",
        `img-src ${sources("'self'", "data:", "blob:", web)}`,
        "font-src 'self' data:",
        `media-src ${sources("'self'", web)}`,
        `connect-src ${sources(web, ws, dev, devWs, options.builder && "http://localhost:*")}`,
        "worker-src 'self'",
        `frame-src ${sources(web)}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'none'",
    ];
    // Ignored (with a console warning) in a report-only policy.
    if (!options.reportOnly) directives.push("frame-ancestors 'none'");
    return directives.join("; ");
}

// A packaged build always enforces unless the environment asks to report. Under the dev server the policy only reports
// (the hot reload client and its preamble are not the app's own files, and `task dev` is not driven in a test instance),
// unless the environment asks to enforce: the developer still sees each violation in the terminal.
export function cspModeFromEnv(env: Record<string, string | undefined>, dev = false): "enforce" | "report-only" {
    const asked = env[CspModeEnv];
    if (asked === CspReportOnlyMode) return "report-only";
    if (asked === CspEnforceMode) return "enforce";
    return dev ? "report-only" : "enforce";
}

// Whether a response is a file of the application: the packaged page and its chunks (`file:`), or the dev server's.
export function isAppResponse(url: string, devOrigin?: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === "file:") return true;
        return devOrigin != null && devOrigin !== "" && parsed.origin === devOrigin;
    } catch {
        return false;
    }
}

// The headers of an app response with the policy set, whatever case the existing names have and whatever policy the
// response carried: an app file never brings a weaker one of its own.
export function withAppCsp(
    headers: Record<string, string[]> | undefined,
    policy: string,
    reportOnly: boolean
): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
        const lower = name.toLowerCase();
        if (lower === CspHeader.toLowerCase() || lower === CspReportOnlyHeader.toLowerCase()) continue;
        result[name] = value;
    }
    result[reportOnly ? CspReportOnlyHeader : CspHeader] = [policy];
    return result;
}

export type AppCspSession = {
    webRequest: {
        onHeadersReceived: (
            filter: { urls: string[] },
            listener: (
                details: { url: string; webContentsId?: number; responseHeaders?: Record<string, string[]> },
                callback: (response: { responseHeaders?: Record<string, string[]> }) => void
            ) => void
        ) => void;
    };
};

export type AppCspDeps = {
    webEndpoint: () => string | null;
    wsEndpoint: () => string | null;
    devOrigin?: string;
    reportOnly: boolean;
    isBuilder: (webContentsId: number | undefined) => boolean;
};

export function configureAppCsp(session: AppCspSession, deps: AppCspDeps): void {
    session.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
        // A throw here is an uncaught exception that quits the app and a callback that never runs hangs the request:
        // a failure sends the response on as it came.
        try {
            if (!isAppResponse(details.url, deps.devOrigin)) {
                callback({ responseHeaders: details.responseHeaders });
                return;
            }
            const policy = buildAppCsp({
                webEndpoint: deps.webEndpoint() ?? "",
                wsEndpoint: deps.wsEndpoint() ?? "",
                devOrigin: deps.devOrigin,
                builder: deps.isBuilder(details.webContentsId),
                reportOnly: deps.reportOnly,
            });
            callback({ responseHeaders: withAppCsp(details.responseHeaders, policy, deps.reportOnly) });
        } catch (e) {
            console.error("app content security policy hook failed, sending the response on as it came", e);
            callback({ responseHeaders: details.responseHeaders });
        }
    });
}

const BuilderContents = new Set<number>();

export function registerBuilderContents(contents: {
    id: number;
    once: (event: "destroyed", listener: () => void) => unknown;
}): void {
    BuilderContents.add(contents.id);
    contents.once("destroyed", () => BuilderContents.delete(contents.id));
}

export function isBuilderContents(webContentsId: number | undefined): boolean {
    return webContentsId != null && BuilderContents.has(webContentsId);
}

// What Chromium writes to the console when a policy blocks (or, in report-only, would block) something. Electron 45's
// wording is "<what> violates the following Content Security Policy directive: "<directive> ...". The action has been
// blocked." (report-only: "The policy is report-only, ..."); the older "Refused to <what> because it violates ..." is
// read too, so that a Chromium that goes back to it does not silence the log.
const ViolationPattern =
    /^(\[Report Only\] )?(?:Refused to )?([\s\S]+?) (?:because it )?violates the following (report-only )?Content Security Policy directive(?: because '[^']*' is not an allowed source of script)?:? ["']([^"']*)/;
const ViolationMaxChars = 300;
const ViolationMaxDistinct = 200;

export type CspViolation = { reportOnly: boolean; directive: string; what: string };

export function parseCspViolation(message: string): CspViolation | null {
    const text = message ?? "";
    const match = ViolationPattern.exec(text);
    if (match == null) return null;
    const directive = match[4].trim().split(/\s+/)[0] ?? "";
    // The blocked address comes from the page: no control character reaches the log, and it stays short.
    // eslint-disable-next-line no-control-regex
    const what = match[2].replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, ViolationMaxChars);
    // Only what Chromium wrote around the page's text decides: the label before the sentence, the tail after the directive.
    const tail = text.slice(match[0].length);
    const reportOnly = match[1] != null || match[3] != null || tail.includes("The policy is report-only");
    return { reportOnly, directive, what };
}

// One line per distinct violation, so a page that retries a blocked request does not flood the log.
export class CspViolationLog {
    private readonly seen = new Set<string>();

    constructor(private readonly write: (line: string) => void) {}

    note(message: string): boolean {
        const violation = parseCspViolation(message);
        if (violation == null) return false;
        const line = `csp: ${violation.reportOnly ? "would block" : "blocked"} ${violation.directive}: ${violation.what}`;
        if (this.seen.has(line) || this.seen.size >= ViolationMaxDistinct) return true;
        this.seen.add(line);
        this.write(line);
        return true;
    }
}
