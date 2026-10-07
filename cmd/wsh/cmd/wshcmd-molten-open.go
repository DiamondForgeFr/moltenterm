// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/browsers"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// `molten open` and `molten browsers` (FR-BRW-002, DS-BRW-002): a page opens in MoltenTerm's browser panel (engine
// "app") or in the user's installed Chromium browser. wavesrv routes it (explicit engine, then the per-site choice,
// then browser:default) and starts the browser (pkg/molten/browsers), so the page opens on the user's computer even
// when molten runs on a remote host.

const moltenBrowserRpcTimeoutMs = 20000

var moltenOpenBrowser string

var moltenOpenCmd = &cobra.Command{
	Use:     "open <url>",
	Short:   "open a page in MoltenTerm's browser panel or in your installed browser (--browser app|installed|<id>)",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenOpenRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenBrowsersCmd = &cobra.Command{
	Use:     "browsers",
	Short:   "list the Chromium browsers found on this computer and the one pages are handed off to",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenBrowsersRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenOpenCmd.Flags().StringVar(&moltenOpenBrowser, "browser", "", "engine: app (MoltenTerm), installed (the browser of browser:installed) or a browser id (brave, chrome, ...); default: the site's choice, then browser:default")
	for _, cmd := range []*cobra.Command{moltenOpenCmd, moltenBrowsersCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
		moltenCmd.AddCommand(cmd)
	}
}

var moltenSchemeRe = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9+.-]*://|about:|file:|data:)`)

// moltenPageUrl accepts a bare host the way the address bar does: localhost gets http, anything else https.
func moltenPageUrl(arg string) string {
	text := strings.TrimSpace(arg)
	if text == "" || moltenSchemeRe.MatchString(text) {
		return text
	}
	lower := strings.ToLower(text)
	if strings.HasPrefix(lower, "localhost") || strings.HasPrefix(lower, "127.0.0.1") {
		return "http://" + text
	}
	return "https://" + text
}

func moltenBrowserRequest(command string, data any, out any) error {
	resp, err := RpcClient.SendRpcRequest(command, data, &wshrpc.RpcOpts{Route: browsers.RouteId, Timeout: moltenBrowserRpcTimeoutMs})
	if err != nil {
		return fmt.Errorf("asking MoltenTerm (%s): %w", command, err)
	}
	return utilfn.ReUnmarshal(out, resp)
}

type moltenOpenResult struct {
	browsers.Route
	Url   string `json:"url"`
	Panel string `json:"panel,omitempty"`
}

func moltenOpenRun(cmd *cobra.Command, args []string) error {
	if moltenOpenFromBrowserEnv {
		return moltenBrowserEnvRun(args[0])
	}
	url := moltenPageUrl(args[0])
	engine := strings.ToLower(strings.TrimSpace(moltenOpenBrowser))
	tabId := getTabIdFromEnv()
	var route browsers.Route
	err := moltenBrowserRequest(browsers.OpenCommand, browsers.OpenRequest{Url: url, Engine: engine}, &route)
	if err != nil {
		if engine != "" && engine != browsers.EngineApp {
			return err
		}
		route = browsers.Route{Engine: browsers.EngineApp}
	}
	result := moltenOpenResult{Route: route, Url: url}
	if route.Engine != browsers.EngineApp {
		if tabId != "" {
			// The panel keeps a handed-off entry; a tab without a panel gets none (no panel opens for it).
			result.Panel, _ = queueInBrowserPanel(tabId, func(id string) waveobj.MetaMapType {
				return molten.BrowserHandoffRequestMeta(id, url, route.Engine)
			})
		}
		if moltenJson {
			return moltenWriteJson(result)
		}
		WriteStdout("opened in %s\n", route.Browser.Name)
		return nil
	}
	if route.Fallback != "" && !moltenJson {
		WriteStderr("molten: %s; opening in MoltenTerm instead\n", route.Fallback)
	}
	if tabId == "" {
		return fmt.Errorf("molten must run in a MoltenTerm terminal to open a page in MoltenTerm (WAVETERM_TABID is not set)")
	}
	panel, err := openInBrowserPanel(tabId, url)
	if err != nil {
		return err
	}
	if panel == "" {
		oref, err := wshclient.CreateBlockCommand(RpcClient, wshrpc.CommandCreateBlockData{
			TabId:    tabId,
			BlockDef: &waveobj.BlockDef{Meta: map[string]any{waveobj.MetaKey_View: molten.BrowserView, waveobj.MetaKey_Url: url}},
			Focused:  true,
		}, nil)
		if err != nil {
			return fmt.Errorf("creating a browser panel: %w", err)
		}
		panel = oref.OID
	}
	result.Panel = panel
	if moltenJson {
		return moltenWriteJson(result)
	}
	WriteStdout("opened in MoltenTerm (browser panel block:%s)\n", panel)
	return nil
}

// handOffBySite sends a page `wsh web open` opens to the installed browser when the per-site choice or the default
// engine says so; false lets the caller open it in MoltenTerm (a fallback reason is printed).
func handOffBySite(tabId string, url string) bool {
	var route browsers.Route
	if err := moltenBrowserRequest(browsers.OpenCommand, browsers.OpenRequest{Url: url}, &route); err != nil {
		return false
	}
	if route.Engine == browsers.EngineApp {
		if route.Fallback != "" {
			WriteStderr("%s; opening in MoltenTerm instead\n", route.Fallback)
		}
		return false
	}
	queueInBrowserPanel(tabId, func(id string) waveobj.MetaMapType {
		return molten.BrowserHandoffRequestMeta(id, url, route.Engine)
	})
	WriteStdout("opened in %s\n", route.Browser.Name)
	return true
}

func moltenBrowsersRun(cmd *cobra.Command, args []string) error {
	var list browsers.ListResult
	if err := moltenBrowserRequest(browsers.ListCommand, nil, &list); err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(list)
	}
	if len(list.Browsers) == 0 {
		WriteStdout("no Chromium browser found: pages open in MoltenTerm\n")
	}
	w := tabwriter.NewWriter(WrappedStdout, 0, 0, 2, ' ', 0)
	for _, b := range list.Browsers {
		mark := " "
		if list.Chosen != nil && list.Chosen.Path == b.Path {
			mark = "*"
		}
		fmt.Fprintf(w, "%s %s\t%s\t%s\n", mark, b.Id, b.Name, b.Path)
	}
	w.Flush()
	if list.Chosen != nil && list.Chosen.Id == browsers.CustomBrowserId {
		WriteStdout("* %s (browser:installed) %s\n", list.Chosen.Name, list.Chosen.Path)
	}
	if list.Problem != "" && len(list.Browsers) > 0 {
		WriteStdout("browser:installed: %s\n", list.Problem)
	}
	WriteStdout("default engine: %s\n", list.Default)
	sites := make([]string, 0, len(list.Sites))
	for site := range list.Sites {
		sites = append(sites, site)
	}
	sort.Strings(sites)
	for _, site := range sites {
		WriteStdout("site %s: %s\n", site, list.Sites[site])
	}
	return nil
}
