// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Settings = vi.hoisted(() => ({ value: {} as Record<string, any> }));
vi.mock("@/app/store/global", async () => {
    const { atom: makeAtom } = await import("jotai");
    return { getApi: () => ({}), getSettingsKeyAtom: () => makeAtom(Settings.value) };
});
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetConfigCommand: vi.fn() } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { ConnectionButton } from "./connection-button";
import { ConnectionInfo } from "./connection-popover";
import type { ConnectionState } from "./connection-security";
import { ConnectionModel, connectionView } from "./connection-store";
import { InsecurePasswordBar } from "./insecure-password-bar";

const secureState: ConnectionState = {
    url: "https://app.example.com/dashboard",
    mixed: false,
    certificate: {
        subject: "app.example.com",
        issuer: "Let's Encrypt",
        validFrom: 1760000000,
        validUntil: Date.UTC(2027, 0, 12, 12) / 1000,
        fingerprint: "AA:BB",
    },
};
function view(address: string, state: ConnectionState | null) {
    return connectionView({ address, state, failed: false });
}

beforeEach(() => {
    Settings.value = {};
});

describe("the connection button (#1980)", () => {
    const render = (address: string, state: ConnectionState | null) =>
        renderToStaticMarkup(
            <Provider store={globalStore}>
                <ConnectionButton view={view(address, state)} address={address} state={state} />
            </Provider>
        );

    it("is a lock without a word on a secure page, named for a screen reader", () => {
        const html = render(secureState.url, secureState);
        expect(html).toContain('data-kind="secure"');
        expect(html).toContain("fa-lock");
        expect(html).toContain('aria-label="Secure connection, site information"');
        expect(html).not.toContain("browser-connection-word");
    });

    it("is a warning with its word on plain http, whose name keeps the word when the word is hidden", () => {
        const html = render("http://staging.example.com/login", null);
        expect(html).toContain('data-kind="insecure"');
        expect(html).toContain("fa-triangle-exclamation");
        expect(html).toContain(
            '<span class="molten-conn-word whitespace-nowrap" data-testid="browser-connection-word">Not secure</span>'
        );
        expect(html).toContain('aria-label="Not secure, site information"');
    });

    it("says partly secure for insecure content", () => {
        expect(render("https://a.example/", { url: "https://a.example/", mixed: true, certificate: null })).toContain(
            "Partially secure"
        );
    });

    it("is a button that opens a dialog and has no popover until it is clicked", () => {
        const html = render(secureState.url, secureState);
        expect(html).toContain('type="button"');
        expect(html).toContain('aria-haspopup="dialog"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain("browser-connection-popover");
    });

    it("shows nothing on a local page, the start page or a file", () => {
        for (const address of ["http://localhost:3000/", "about:blank#moltenterm-start", "file:///tmp/a.html"]) {
            expect(render(address, { url: address, mixed: false, certificate: null }), address).toBe("");
        }
    });
});

describe("the site information (#1980)", () => {
    const render = (kind: string, props: Partial<React.ComponentProps<typeof ConnectionInfo>> = {}) => {
        const address = kind === "insecure" ? "http://staging.example.com/login" : secureState.url;
        const state = kind === "insecure" ? null : secureState;
        return renderToStaticMarkup(
            <Provider store={globalStore}>
                <ConnectionInfo
                    view={view(address, state)}
                    address={address}
                    state={state}
                    onClose={() => {}}
                    {...props}
                />
            </Provider>
        );
    };

    it("names the host in monospace, the connection, and the certificate with who it is for, who issued it and its expiry", () => {
        const html = render("secure");
        expect(html).toContain('data-testid="browser-connection-host"');
        expect(html).toMatch(/font-mono[^>]*>app\.example\.com</);
        expect(html).toContain("Secure connection");
        expect(html).toContain("encrypted on its way");
        expect(html).toContain("Valid certificate");
        expect(html).toContain("Issued for");
        expect(html).toContain("app.example.com");
        expect(html).toContain("Issued by");
        expect(html).toContain("Let&#x27;s Encrypt");
        expect(html).toMatch(/Expires [^<]*2027/);
        expect(html).toContain("Fingerprint: AA:BB");
    });

    it("says the certificate is not available when main has none for the host", () => {
        const html = render("secure", { state: { ...secureState, certificate: null } });
        expect(html).toContain("Its details are not available for this page.");
        expect(html).not.toContain("Valid certificate");
    });

    it("has no certificate section on plain http and says it is not encrypted", () => {
        const html = render("insecure");
        expect(html).toContain("Not secure");
        expect(html).toContain("without encryption");
        expect(html).not.toContain("browser-connection-certificate");
    });

    it("lists the four permissions, with the decision kept and a Remove button for a decision only", () => {
        Settings.value = { "app.example.com": { camera: "allow", notifications: "block" } };
        const html = render("secure");
        expect(html).toContain("Permissions of this site");
        for (const kind of ["camera", "microphone", "location", "notifications"]) {
            expect(html).toContain(`browser-connection-permission-${kind}`);
        }
        expect(html).toContain("Allowed");
        expect(html).toContain("Blocked");
        expect(html.match(/>Ask</g)).toHaveLength(2);
        expect(html).toContain("browser-connection-remove-camera");
        expect(html).toContain("browser-connection-remove-notifications");
        expect(html).not.toContain("browser-connection-remove-microphone");
        expect(html).toContain('aria-label="Remove the Camera decision for this site"');
    });

    it("offers to clear the site's cookies and data only when the page has some to clear", () => {
        expect(render("secure")).not.toContain("browser-connection-clear");
        const html = render("secure", { onClearData: () => {} });
        expect(html).toContain("browser-connection-clear");
        expect(html).toContain("Clear this site&#x27;s cookies and data…");
    });
});

describe("the password warning bar (#1980)", () => {
    const render = (connection: ConnectionModel, address: string) =>
        renderToStaticMarkup(
            <Provider store={globalStore}>
                <InsecurePasswordBar connection={connection} tabId="t1" address={address} />
            </Provider>
        );

    it("shows nothing until a password field took the focus", () => {
        expect(render(new ConnectionModel(), "http://a.example/login")).toBe("");
    });

    it("warns, with a secondary button and no way to block the field, never taking the focus", () => {
        const model = new ConnectionModel();
        model.notePasswordField("t1", "http://a.example/login");
        const html = render(model, "http://a.example/login");
        expect(html).toContain('role="region"');
        expect(html).toContain("This page is not secure");
        expect(html).toContain("A password typed here can be read on its way. Do not use it anywhere else.");
        expect(html).toContain("Understood");
        expect(html).toContain("fa-lock-open");
        expect(html).not.toContain("autofocus");
        expect(html).not.toContain("autoFocus");
    });

    it("does not show on another page of the tab, and goes once dismissed", () => {
        const model = new ConnectionModel();
        model.notePasswordField("t1", "http://a.example/login");
        expect(render(model, "http://a.example/other")).toBe("");
        model.dismissWarning("t1");
        expect(render(model, "http://a.example/login")).toBe("");
    });
});
