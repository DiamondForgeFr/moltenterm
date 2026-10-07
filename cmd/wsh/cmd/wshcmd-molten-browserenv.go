// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/browsers"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// molten-open, the BROWSER of local MoltenTerm terminals (FR-BRW-007, DS-BRW-008). It is wsh installed under another
// name (pkg/util/shellutil/moltenterm_molten.go) and runs `molten open --from-browser-env`. A web page goes through
// molten open's routing (FR-BRW-002) to the browser panel of the pane's own tab, without taking the focus and with the
// first-link choice (DS-BRW-022); anything else, and every page when MoltenTerm cannot be reached, goes to the OS
// opener, so a link is never lost. It returns as soon as the page is queued: programs often wait on BROWSER.

const MoltenOpenProgramName = shellutil.MoltenOpenCommandName

const moltenBrowserEnvRpcTimeoutMs = 5000

// How long the OS opener may take to report a failure; one still running after it is left to finish on its own.
const moltenOsOpenWait = 2 * time.Second

var moltenOpenFromBrowserEnv bool

// Set by the pre-run when molten-open cannot reach MoltenTerm: the page then goes to the OS opener.
var moltenBrowserEnvRpcErr error

var moltenUrlSchemeRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)
var moltenUrlAuthorityRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*://`)
var moltenHostPortRe = regexp.MustCompile(`^[^:/?#]+:[0-9]+([/?#].*)?$`)

func init() {
	moltenOpenCmd.Flags().BoolVar(&moltenOpenFromBrowserEnv, "from-browser-env", false, "run as BROWSER (molten-open): non-web targets and an unreachable MoltenTerm go to the OS opener")
	moltenOpenCmd.Flags().MarkHidden("from-browser-env")
	moltenOpenCmd.PreRunE = moltenOpenPreRun
}

// moltenBrowserEnvArgs is the wsh command line molten-open runs: programs call `$BROWSER <url>`, sometimes with more
// arguments. Only the first argument that is not an option is read, and it is passed after "--" so that no URL is
// ever read as a flag.
func moltenBrowserEnvArgs(args []string) []string {
	rtn := []string{args[0], MoltenProgramName, "open", "--from-browser-env"}
	for _, arg := range args[1:] {
		if strings.TrimSpace(arg) == "" || strings.HasPrefix(arg, "-") {
			continue
		}
		return append(rtn, "--", arg)
	}
	return rtn
}

func moltenOpenPreRun(cmd *cobra.Command, args []string) error {
	err := preRunSetupRpcClient(cmd, args)
	if err != nil && moltenOpenFromBrowserEnv {
		moltenBrowserEnvRpcErr = err
		return nil
	}
	return err
}

// moltenBrowserEnvPage returns the web page a BROWSER argument opens, or false when the argument is something else the
// OS opener handles: a file path (existing, or written as one), a file:, mailto: or any other non-http(s) URL. A bare
// host is completed like `molten open` does (https, http for localhost).
func moltenBrowserEnvPage(arg string) (string, bool) {
	text := strings.TrimSpace(arg)
	if text == "" {
		return "", false
	}
	if moltenUrlAuthorityRe.MatchString(text) || (moltenUrlSchemeRe.MatchString(text) && !moltenHostPortRe.MatchString(text)) {
		return text, moltenIsWebUrl(text)
	}
	if moltenLooksLikePath(text) {
		return "", false
	}
	if _, err := os.Stat(text); err == nil {
		return "", false
	}
	page := moltenPageUrl(text)
	return page, moltenIsWebUrl(page)
}

func moltenIsWebUrl(text string) bool {
	u, err := url.Parse(text)
	if err != nil {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	return (scheme == "http" || scheme == "https") && u.Host != ""
}

func moltenLooksLikePath(text string) bool {
	for _, prefix := range []string{"/", "./", "../", "~", `.\`, `..\`, `\\`} {
		if strings.HasPrefix(text, prefix) {
			return true
		}
	}
	return text == "." || text == ".."
}

func moltenBrowserEnvRun(arg string) error {
	page, web := moltenBrowserEnvPage(arg)
	if !web {
		return moltenOsOpen(arg)
	}
	tabId := getTabIdFromEnv()
	if moltenBrowserEnvRpcErr != nil || RpcClient == nil || tabId == "" {
		return moltenOsOpen(page)
	}
	err := moltenBrowserEnvQueue(tabId, page)
	if err != nil {
		WriteStderr("molten-open: %v; opening it with the system instead\n", err)
		return moltenOsOpen(page)
	}
	return nil
}

// moltenBrowserEnvQueue routes the page like `molten open` (explicit engine, per-site choice, browser:default) and
// queues it in the browser panel of the tab, or a handed-off entry when an installed browser opened it.
func moltenBrowserEnvQueue(tabId string, page string) error {
	var route browsers.Route
	resp, err := RpcClient.SendRpcRequest(browsers.OpenCommand, browsers.OpenRequest{Url: page}, &wshrpc.RpcOpts{Route: browsers.RouteId, Timeout: moltenBrowserEnvRpcTimeoutMs})
	if err == nil {
		err = utilfn.ReUnmarshal(&route, resp)
	}
	if err != nil {
		route = browsers.Route{Engine: browsers.EngineApp}
	}
	if route.Engine != browsers.EngineApp {
		_, err = queueInBrowserPanel(tabId, func(id string) waveobj.MetaMapType {
			return molten.BrowserHandoffRequestMeta(id, page, route.Engine)
		})
		return err
	}
	if route.Fallback != "" {
		WriteStderr("molten-open: %s; opening in MoltenTerm instead\n", route.Fallback)
	}
	ask := route.Fallback == ""
	panel, err := queueInBrowserPanel(tabId, func(id string) waveobj.MetaMapType {
		return molten.BrowserEnvRequestMeta(id, page, ask)
	})
	if err != nil || panel != "" {
		return err
	}
	_, err = wshclient.CreateBlockCommand(RpcClient, wshrpc.CommandCreateBlockData{
		TabId:    tabId,
		BlockDef: &waveobj.BlockDef{Meta: molten.BrowserEnvBlockMeta(page, ask)},
	}, &wshrpc.RpcOpts{Timeout: moltenBrowserEnvRpcTimeoutMs})
	if err != nil {
		return fmt.Errorf("creating a browser panel: %w", err)
	}
	return nil
}

func moltenOsOpenCommand(target string) *exec.Cmd {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", target)
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		return exec.Command("xdg-open", target)
	}
}

// moltenOsOpen hands the target to the OS opener, as data and never through a shell. BROWSER is removed from the
// opener's environment: xdg-open reads it, and would hand the target straight back to molten-open.
func moltenOsOpen(target string) error {
	cmd := moltenOsOpenCommand(target)
	cmd.Env = moltenEnvWithout(os.Environ(), shellutil.BrowserVarName)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("opening %s: %w", target, err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("opening %s: %w", target, err)
		}
		return nil
	case <-time.After(moltenOsOpenWait):
		cmd.Process.Release()
		return nil
	}
}

func moltenEnvWithout(env []string, name string) []string {
	prefix := name + "="
	rtn := make([]string, 0, len(env))
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			continue
		}
		rtn = append(rtn, kv)
	}
	return rtn
}
