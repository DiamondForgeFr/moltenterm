import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

function contents(id: number, host?: any) {
    const contents = new EventEmitter() as any;
    Object.assign(contents, {
        id,
        hostWebContents: host,
        destroyed: false,
        url: "http://fixture.test/image",
        isDestroyed: () => contents.destroyed,
        getType: () => (host ? "webview" : "window"),
        getURL: () => contents.url,
        getZoomFactor: () => 1,
        focus: vi.fn(),
        copy: vi.fn(),
        paste: vi.fn(),
        send: vi.fn(),
    });
    return contents;
}
async function setup() {
    vi.resetModules();
    const host = contents(1);
    const other = contents(2);
    const guest = contents(3, host);
    const foreign = contents(4, other);
    const all = [host, other, guest, foreign];
    const owner = new EventEmitter() as any;
    Object.assign(owner, {
        id: 10,
        focused: true,
        isDestroyed: () => false,
        isFocused: () => owner.focused,
        activeTabView: { webContents: host, getBounds: () => ({ x: 0, y: 0 }) },
        getContentBounds: () => ({ x: 0, y: 0 }),
    });
    const handlers = new Map<string, (...args: any[]) => void>();
    vi.doMock("electron", () => ({
        ipcMain: { on: (channel, handler) => handlers.set(channel, handler) },
        webContents: { fromId: (id) => all.find((entry) => entry.id === id), getAllWebContents: () => all },
        screen: { getCursorScreenPoint: () => ({ x: 50, y: 50 }) },
    }));
    vi.doMock("./emain-window", () => ({ getWaveWindowByWebContentsId: (id) => (id === host.id ? owner : null) }));
    vi.doMock("./emain-builder", () => ({ getBuilderWindowByWebContentsId: () => null }));
    const bridge = await import("./moltenterm-contextmenu");
    const save = vi.fn(async (_host: any, _guest: any, _source: string, _valid: () => boolean) => {});
    bridge.initMoltentermContextMenu(save);
    function call(channel: string, sender: any, ...args: any[]) {
        let reply: any;
        let replied = false;
        const event = { sender } as any;
        Object.defineProperty(event, "returnValue", {
            set(value) {
                if (replied) return;
                replied = true;
                reply = value;
            },
        });
        handlers.get(channel)(event, ...args);
        return reply;
    }
    call("moltenterm-contextmenu-guest", host, guest.id, true);
    return {
        host,
        other,
        guest,
        foreign,
        owner,
        bridge,
        save,
        call,
        capture: () => call("moltenterm-contextmenu-capture", host, guest.id),
    };
}
describe("owned menu IPC lifetime", () => {
    it("executes only a captured active guest once without touching a global focused guest", async () => {
        const { call, capture, host, other, guest } = await setup();
        const token = capture();
        call("moltenterm-contextmenu-role", other, token, "paste");
        expect(guest.paste).not.toHaveBeenCalled();
        call("moltenterm-contextmenu-role", host, token, "paste");
        call("moltenterm-contextmenu-role", host, token, "paste");
        expect(guest.paste).toHaveBeenCalledOnce();
        expect(host.paste).not.toHaveBeenCalled();
    });
    it("rejects revoked, background, destroyed, unfocused and cross-host targets", async () => {
        const { call, capture, host, guest, foreign, owner } = await setup();
        expect(call("moltenterm-contextmenu-capture", host, foreign.id)).toBeNull();
        let token = capture();
        call("moltenterm-contextmenu-revoke", host, token);
        call("moltenterm-contextmenu-role", host, token, "copy");
        token = capture();
        owner.focused = false;
        call("moltenterm-contextmenu-role", host, token, "copy");
        owner.emit("blur");
        owner.focused = true;
        call("moltenterm-contextmenu-role", host, token, "copy");
        token = capture();
        call("moltenterm-contextmenu-guest", host, guest.id, false);
        call("moltenterm-contextmenu-role", host, token, "copy");
        call("moltenterm-contextmenu-guest", host, guest.id, true);
        token = capture();
        guest.destroyed = true;
        call("moltenterm-contextmenu-role", host, token, "copy");
        expect(guest.copy).not.toHaveBeenCalled();
    });
    it("invalidates a consumed in-flight image on same-URL reload and consumes image tokens once", async () => {
        const { call, host, guest, save } = await setup();
        call("moltenterm-contextmenu-guest-request", guest, { x: 10, y: 10, src: "https://fixture.test/image.png" });
        const token = host.send.mock.calls[0][1].imageToken;
        call("moltenterm-contextmenu-save-image", host, token);
        call("moltenterm-contextmenu-save-image", host, token);
        expect(save).toHaveBeenCalledOnce();
        const valid = save.mock.calls[0][3] as () => boolean;
        expect(valid()).toBe(true);
        guest.emit("did-start-navigation", {}, guest.url, false, true);
        expect(valid()).toBe(false);
    });
});
