// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";
// MOLTENTERM-PATCH (#806): authorize application frames before every privileged IPC handler.
import { handleAppIpc, onAppIpc, onGuestIpc } from "./moltenterm-privileged-ipc";
import { readRendererEnvironment } from "./moltenterm-renderer-env";
import { FastAverageColor } from "fast-average-color";
import fs from "fs";
import * as child_process from "node:child_process";
import * as path from "path";
import { PNG } from "pngjs";
import { Readable } from "stream";
import { RpcApi } from "../frontend/app/store/wshclientapi";
import { getWebServerEndpoint } from "../frontend/util/endpoints";
import * as keyutil from "../frontend/util/keyutil";
import { fireAndForget, parseDataUrl } from "../frontend/util/util";
import {
    incrementTermCommandsDurable,
    incrementTermCommandsRemote,
    incrementTermCommandsRun,
    incrementTermCommandsWsl,
    setWasActive,
} from "./emain-activity";
import { createBuilderWindow, getAllBuilderWindows, getBuilderWindowByWebContentsId } from "./emain-builder";
import { callWithOriginalXdgCurrentDesktopAsync, unamePlatform } from "./emain-platform";
import { getWaveTabViewByWebContentsId } from "./emain-tabview";
import { handleCtrlShiftState } from "./emain-util";
import { getWaveVersion } from "./emain-wavesrv";
import { createNewWaveWindow, getWaveWindowByWebContentsId } from "./emain-window";
import { ElectronWshClient } from "./emain-wsh";
import { initMoltentermBrowserAgent, isAgentInput } from "./moltenterm-browseragent"; // MOLTENTERM-PATCH (#300, #302)
import { initMoltentermContextMenu } from "./moltenterm-contextmenu";
import { initMoltentermDialogs } from "./moltenterm-dialogs"; // MOLTENTERM-PATCH (#30)
import { openExternalLink } from "./moltenterm-external-links"; // MOLTENTERM-PATCH (#663)
import { mt } from "./moltenterm-i18n"; // MOLTENTERM-PATCH (#623)
import { initMoltentermUpdate } from "./moltenterm-update"; // MOLTENTERM-PATCH (#64)
import { initMoltentermAccessibility } from "./moltenterm-accessibility"; // MOLTENTERM-PATCH (#808)
import { initMoltentermWindowButtons } from "./moltenterm-window-buttons"; // MOLTENTERM-PATCH (#1216)
import { liveWebContentsFromId } from "./moltenterm-webcontents-id"; // MOLTENTERM-PATCH (#928)
import { sendKeyNotice } from "./moltenterm-key-notice"; // MOLTENTERM-PATCH (#1242)

const electronApp = electron.app;

let webviewFocusId: number = null;
let webviewKeys: string[] = [];

export function openBuilderWindow(appId?: string) {
    const normalizedAppId = appId || "";
    const existingBuilderWindows = getAllBuilderWindows();
    const existingWindow = existingBuilderWindows.find((win) => win.builderAppId === normalizedAppId);
    if (existingWindow) {
        existingWindow.focus();
        return;
    }
    fireAndForget(() => createBuilderWindow(normalizedAppId));
}

type UrlInSessionResult = {
    stream: Readable;
    mimeType: string;
    fileName: string;
};

function getSingleHeaderVal(headers: Record<string, string | string[]>, key: string): string {
    const val = headers[key];
    if (val == null) {
        return null;
    }
    if (Array.isArray(val)) {
        return val[0];
    }
    return val;
}

function cleanMimeType(mimeType: string): string {
    if (mimeType == null) {
        return null;
    }
    const parts = mimeType.split(";");
    return parts[0].trim();
}

function getFileNameFromUrl(url: string): string {
    try {
        const pathname = new URL(url).pathname;
        const filename = pathname.substring(pathname.lastIndexOf("/") + 1);
        return filename;
    } catch (e) {
        return null;
    }
}

function getUrlInSession(session: Electron.Session, url: string): Promise<UrlInSessionResult> {
    return new Promise((resolve, reject) => {
        if (url.startsWith("data:")) {
            try {
                const parsed = parseDataUrl(url);
                const buffer = Buffer.from(parsed.buffer);
                const readable = Readable.from(buffer);
                resolve({ stream: readable, mimeType: parsed.mimeType, fileName: "image" });
            } catch (err) {
                return reject(err);
            }
            return;
        }
        const request = electron.net.request({
            url,
            method: "GET",
            session,
        });
        const readable = new Readable({
            read() {},
        });
        request.on("response", (response) => {
            const statusCode = response.statusCode;
            if (statusCode < 200 || statusCode >= 300) {
                readable.destroy();
                request.abort();
                reject(new Error(`HTTP request failed with status ${statusCode}: ${response.statusMessage || ""}`));
                return;
            }

            const mimeType = cleanMimeType(getSingleHeaderVal(response.headers, "content-type"));
            const fileName = getFileNameFromUrl(url) || "image";
            response.on("data", (chunk) => {
                readable.push(chunk);
            });
            response.on("end", () => {
                readable.push(null);
                resolve({ stream: readable, mimeType, fileName });
            });
            response.on("error", (err) => {
                readable.destroy(err);
                reject(err);
            });
        });
        request.on("error", (err) => {
            readable.destroy(err);
            reject(err);
        });
        request.end();
    });
}

function saveImageFileWithNativeDialog(
    sender: electron.WebContents,
    defaultFileName: string,
    mimeType: string,
    readStream: Readable
) {
    if (defaultFileName == null || defaultFileName == "") {
        defaultFileName = "image";
    }
    // MOLTENTERM-PATCH (#371): Wave uses BaseWindow and an owned tab WebContentsView.
    const ww = getWaveWindowByWebContentsId(sender.id) ?? electron.BrowserWindow.fromWebContents(sender);
    if (ww == null) {
        readStream.destroy();
        return;
    }
    const mimeToExtension: { [key: string]: string } = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/bmp": "bmp",
        "image/tiff": "tiff",
        "image/heic": "heic",
        "image/svg+xml": "svg",
    };
    function addExtensionIfNeeded(fileName: string, mimeType: string): string {
        const extension = mimeToExtension[mimeType];
        if (!path.extname(fileName) && extension) {
            return `${fileName}.${extension}`;
        }
        return fileName;
    }
    defaultFileName = addExtensionIfNeeded(defaultFileName, mimeType);
    electron.dialog
        .showSaveDialog(ww, {
            title: "Save Image",
            defaultPath: defaultFileName,
            filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic"] }],
        })
        .then((file) => {
            if (file.canceled) {
                readStream.destroy();
                return;
            }
            const writeStream = fs.createWriteStream(file.filePath);
            readStream.pipe(writeStream);
            writeStream.on("finish", () => {
                console.log("saved file", file.filePath);
            });
            writeStream.on("error", (err) => {
                console.log("error saving file (writeStream)", err);
                readStream.destroy();
            });
            readStream.on("error", (err) => {
                console.error("error saving file (readStream)", err);
                writeStream.destroy();
            });
        })
        .catch((err) => {
            console.log("error trying to save file", err);
        });
}

// MOLTENTERM-PATCH (#371): owned, captured context-menu actions.
export function initIpcHandlers() {
    initMoltentermAccessibility(); // MOLTENTERM-PATCH (#808): read-only OS accessibility state.
    initMoltentermWindowButtons(); // MOLTENTERM-PATCH (#1216): the window buttons follow the hidden sidebar.
    initMoltentermContextMenu(async (host, guest, source, valid) => {
        const result = await getUrlInSession(guest.session, source);
        if (!valid()) {
            result.stream.destroy();
            return;
        }
        saveImageFileWithNativeDialog(host, result.fileName, result.mimeType, result.stream);
    });
    initMoltentermDialogs(); // MOLTENTERM-PATCH (#30): folder and image pickers of the Moltenterm shell
    initMoltentermUpdate(); // MOLTENTERM-PATCH (#64): gold updates
    // MOLTENTERM-PATCH (#300, #302, #971): a download the agent's tab starts waits for the user's Allow (route
    // molten:browseragent); taking a tab over is the user's explicit act in the panel, never a click in the page
    initMoltentermBrowserAgent(async (blockId, browserTabId, host) => {
        try {
            const answer = await ElectronWshClient.wshRpcCall(
                "moltenbrowseragentdownload",
                { blockid: blockId, browsertabid: browserTabId, host },
                { route: "molten:browseragent", timeout: 130000 }
            );
            return answer?.allow === true;
        } catch (e) {
            console.log("molten browser agent: download answer failed", e);
            return false;
        }
    });
    // MOLTENTERM-PATCH (#663): one scheme rule for every link handed to the system (emain/moltenterm-external-links.ts)
    onAppIpc("open-external", (event, url) => {
        fireAndForget(() => openExternalLink(url, event.sender));
    });

    onGuestIpc("webview-mouse-navigate", (event: electron.IpcMainEvent, direction: string) => {
        if (direction === "back") {
            event.sender.navigationHistory.goBack();
        } else if (direction === "forward") {
            event.sender.navigationHistory.goForward();
        }
    });

    onAppIpc("download", (event, payload) => {
        const baseName = encodeURIComponent(path.basename(payload.filePath));
        const streamingUrl =
            getWebServerEndpoint() + "/wave/stream-file/" + baseName + "?path=" + encodeURIComponent(payload.filePath);
        event.sender.downloadURL(streamingUrl);
    });

    onAppIpc("get-cursor-point", (event) => {
        const tabView = getWaveTabViewByWebContentsId(event.sender.id);
        if (tabView == null) {
            event.returnValue = null;
            return;
        }
        const screenPoint = electron.screen.getCursorScreenPoint();
        const windowRect = tabView.getBounds();
        const retVal: Electron.Point = {
            x: screenPoint.x - windowRect.x,
            y: screenPoint.y - windowRect.y,
        };
        event.returnValue = retVal;
    });

    handleAppIpc("capture-screenshot", async (event, rect) => {
        const tabView = getWaveTabViewByWebContentsId(event.sender.id);
        if (!tabView) {
            throw new Error("No tab view found for the given webContents id");
        }
        const image = await tabView.webContents.capturePage(rect);
        const base64String = image.toPNG().toString("base64");
        return `data:image/png;base64,${base64String}`;
    });

    onAppIpc("get-env", (event, varName) => {
        event.returnValue = readRendererEnvironment(varName);
    });

    onAppIpc("get-about-modal-details", (event) => {
        event.returnValue = getWaveVersion() as AboutModalDetails;
    });

    onAppIpc("get-zoom-factor", (event) => {
        event.returnValue = event.sender.getZoomFactor();
    });

    const hasBeforeInputRegisteredMap = new Map<number, boolean>();

    onAppIpc("webview-focus", (event: Electron.IpcMainEvent, focusedId: number) => {
        webviewFocusId = focusedId;
        console.log("webview-focus", focusedId);
        if (focusedId == null) {
            return;
        }
        const parentWc = event.sender;
        const webviewWc = liveWebContentsFromId(focusedId); // MOLTENTERM-PATCH (#928)
        if (webviewWc == null) {
            webviewFocusId = null;
            return;
        }
        if (!hasBeforeInputRegisteredMap.get(focusedId)) {
            hasBeforeInputRegisteredMap.set(focusedId, true);
            webviewWc.on("before-input-event", (e, input) => {
                // MOLTENTERM-PATCH (#302): keys an agent sends to its page (cmd+w, cmd+t…) stay in the page: they never
                // reach MoltenTerm's shortcuts.
                if (isAgentInput(webviewWc.id, input)) {
                    return;
                }
                let waveEvent = keyutil.adaptFromElectronKeyEvent(input);
                handleCtrlShiftState(parentWc, waveEvent);
                if (webviewFocusId != focusedId) {
                    return;
                }
                sendKeyNotice(parentWc, waveEvent); // MOLTENTERM-PATCH (#1242): the shortcut overlay's hold and close
                if (input.type != "keyDown") {
                    return;
                }
                for (let keyDesc of webviewKeys) {
                    if (keyutil.checkKeyPressed(waveEvent, keyDesc)) {
                        e.preventDefault();
                        parentWc.send("reinject-key", waveEvent);
                        console.log("webview reinject-key", keyDesc);
                        return;
                    }
                }
            });
            webviewWc.on("destroyed", () => {
                hasBeforeInputRegisteredMap.delete(focusedId);
            });
        }
    });

    onAppIpc("register-global-webview-keys", (event, keys: string[]) => {
        webviewKeys = keys ?? [];
    });

    onAppIpc("set-keyboard-chord-mode", (event) => {
        event.returnValue = null;
        const tabView = getWaveTabViewByWebContentsId(event.sender.id);
        tabView?.setKeyboardChordMode(true);
    });

    handleAppIpc("set-is-active", () => {
        setWasActive(true);
    });

    const fac = new FastAverageColor();
    onAppIpc("update-window-controls-overlay", async (event, rect: Dimensions) => {
        if (unamePlatform === "darwin") return;
        try {
            const fullConfig = await RpcApi.GetFullConfigCommand(ElectronWshClient);
            if (fullConfig?.settings?.["window:nativetitlebar"] && unamePlatform !== "win32") return;

            const zoomFactor = event.sender.getZoomFactor();
            const electronRect: Electron.Rectangle = {
                x: rect.left * zoomFactor,
                y: rect.top * zoomFactor,
                height: rect.height * zoomFactor,
                width: rect.width * zoomFactor,
            };
            const overlay = await event.sender.capturePage(electronRect);
            const overlayBuffer = overlay.toPNG();
            const png = PNG.sync.read(overlayBuffer);
            const color = fac.prepareResult(fac.getColorFromArray4(png.data));
            const ww = getWaveWindowByWebContentsId(event.sender.id);
            if (ww == null) return;
            ww.setTitleBarOverlay({
                color: unamePlatform === "linux" ? color.rgba : "#00000000",
                symbolColor: color.isDark ? "white" : "black",
            });
        } catch (e) {
            console.error("Error updating window controls overlay:", e);
        }
    });

    onAppIpc("quicklook", (event, filePath: string) => {
        if (unamePlatform !== "darwin") return;
        child_process.execFile("/usr/bin/qlmanage", ["-p", filePath], (error, stdout, stderr) => {
            if (error) {
                console.error(`Error opening Quick Look: ${error}`);
            }
        });
    });

    handleAppIpc("clear-webview-storage", async (event, webContentsId: number) => {
        try {
            const wc = electron.webContents.fromId(webContentsId);
            if (wc && wc.session) {
                await wc.session.clearStorageData();
                console.log("Cleared cookies and storage for webContentsId:", webContentsId);
            }
        } catch (e) {
            console.error("Failed to clear cookies and storage:", e);
            throw e;
        }
    });

    onAppIpc("open-native-path", (event, filePath: string) => {
        console.log("open-native-path", filePath);
        filePath = filePath.replace("~", electronApp.getPath("home"));
        fireAndForget(() =>
            callWithOriginalXdgCurrentDesktopAsync(() =>
                electron.shell.openPath(filePath).then((excuse) => {
                    if (excuse) console.error(`Failed to open ${filePath} in native application: ${excuse}`);
                })
            )
        );
    });

    onAppIpc("set-window-init-status", (event, status: "ready" | "wave-ready") => {
        const tabView = getWaveTabViewByWebContentsId(event.sender.id);
        if (tabView != null && tabView.initResolve != null) {
            if (status === "ready") {
                tabView.initResolve();
                if (tabView.savedInitOpts) {
                    console.log("savedInitOpts calling wave-init", tabView.waveTabId);
                    tabView.webContents.send("wave-init", tabView.savedInitOpts);
                }
            } else if (status === "wave-ready") {
                tabView.waveReadyResolve();
            }
            return;
        }

        const builderWindow = getBuilderWindowByWebContentsId(event.sender.id);
        if (builderWindow != null) {
            if (status === "ready") {
                if (builderWindow.savedInitOpts) {
                    console.log("savedInitOpts calling builder-init", builderWindow.savedInitOpts.builderId);
                    builderWindow.webContents.send("builder-init", builderWindow.savedInitOpts);
                }
            }
            return;
        }

        console.log("set-window-init-status: no window found for webContentsId", event.sender.id);
    });

    onAppIpc("fe-log", (event, logStr: string) => {
        console.log("fe-log", logStr);
    });

    onAppIpc(
        "increment-term-commands",
        (event, opts?: { isRemote?: boolean; isWsl?: boolean; isDurable?: boolean }) => {
            incrementTermCommandsRun();
            if (opts?.isRemote) {
                incrementTermCommandsRemote();
            }
            if (opts?.isWsl) {
                incrementTermCommandsWsl();
            }
            if (opts?.isDurable) {
                incrementTermCommandsDurable();
            }
        }
    );

    onAppIpc("native-paste", (event) => {
        event.sender.paste();
    });

    onAppIpc("open-builder", (event, appId?: string) => {
        openBuilderWindow(appId);
    });

    onAppIpc("set-builder-window-appid", (event, appId: string) => {
        const bw = getBuilderWindowByWebContentsId(event.sender.id);
        if (bw == null) {
            return;
        }
        bw.builderAppId = appId;
        console.log("set-builder-window-appid", bw.builderId, appId);
    });

    onAppIpc("open-new-window", () => fireAndForget(createNewWaveWindow));

    onAppIpc("close-builder-window", async (event) => {
        const bw = getBuilderWindowByWebContentsId(event.sender.id);
        if (bw == null) {
            return;
        }
        const builderId = bw.builderId;
        if (builderId) {
            try {
                await RpcApi.SetRTInfoCommand(ElectronWshClient, {
                    oref: `builder:${builderId}`,
                    data: {} as ObjRTInfo,
                    delete: true,
                });
            } catch (e) {
                console.error("Error deleting builder rtinfo:", e);
            }
        }
        bw.destroy();
    });

    onAppIpc("do-refresh", (event) => {
        event.sender.reloadIgnoringCache();
    });

    handleAppIpc("save-text-file", async (event, fileName: string, content: string) => {
        const ww = electron.BrowserWindow.fromWebContents(event.sender);
        if (ww == null) {
            return false;
        }
        const result = await electron.dialog.showSaveDialog(ww, {
            title: mt("dialog.saveScrollback.title"), // MOLTENTERM-PATCH (#623)
            defaultPath: fileName || "session.log",
            filters: [{ name: mt("dialog.saveScrollback.filter"), extensions: ["txt", "log"] }],
        });
        if (result.canceled || !result.filePath) {
            return false;
        }
        try {
            await fs.promises.writeFile(result.filePath, content, "utf-8");
            console.log("saved scrollback to", result.filePath);
            return true;
        } catch (err) {
            console.error("error saving scrollback file", err);
            return false;
        }
    });
}
