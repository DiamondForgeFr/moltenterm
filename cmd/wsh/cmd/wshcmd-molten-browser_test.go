// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// `molten open` brings a page that is already open into view instead of opening it again (#2333). The pages are
// synthetic: example hosts only.

func browserBlock(blockId string, tabId string, active string, tabs ...map[string]any) wshrpc.BlocksListEntry {
	list := make([]any, 0, len(tabs))
	for _, tab := range tabs {
		list = append(list, tab)
	}
	return wshrpc.BlocksListEntry{
		TabId:   tabId,
		BlockId: blockId,
		Meta: waveobj.MetaMapType{
			waveobj.MetaKey_View:        molten.BrowserView,
			molten.BrowserTabsMetaKey:   list,
			molten.BrowserActiveMetaKey: active,
		},
	}
}

func browserTab(id string, url string, engine string) map[string]any {
	tab := map[string]any{"id": id, "url": url}
	if engine != "" {
		tab["engine"] = engine
	}
	return tab
}

func TestOpenPagesOfListsTheBrowserPagesOfOneWaveTab(t *testing.T) {
	blocks := []wshrpc.BlocksListEntry{
		browserBlock("p-here-1", "tab-1", "a", browserTab("a", "https://docs.example/guide", "")),
		browserBlock("p-here-2", "tab-1", "c", browserTab("b", "https://docs.example/guide#intro", ""), browserTab("c", "https://other.example", "")),
		browserBlock("p-handed-off", "tab-1", "d", browserTab("d", "https://docs.example/guide", "brave")),
		browserBlock("p-elsewhere", "tab-2", "e", browserTab("e", "https://docs.example/guide", "")),
		{TabId: "tab-1", BlockId: "term-1", Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"}},
	}
	pages := openPagesOf("tab-1", blocks, []any{"p-here-2", 7, "p-gone"})
	var got []string
	for _, p := range pages {
		got = append(got, p.PanelId+"/"+p.TabId)
	}
	if strings.Join(got, ",") != "p-here-1/a,p-here-2/b,p-here-2/c" {
		t.Fatalf("only the pages of this Wave tab's browser panels, in the panel's own engine: %v", got)
	}
	if !pages[0].InView || pages[1].InView || !pages[2].InView {
		t.Fatalf("the shown page of each panel is in view: %+v", pages)
	}
	if pages[0].Recent != -1 || pages[1].Recent != 0 || pages[2].Recent != 0 {
		t.Fatalf("the panel's rank in the focus history: %+v", pages)
	}
}

func TestOpenPagesOfFindsTheOpenPageAnAddressNames(t *testing.T) {
	blocks := []wshrpc.BlocksListEntry{
		browserBlock("p-old", "tab-1", "a", browserTab("a", "https://docs.example/guide", "")),
		browserBlock("p-recent", "tab-1", "b", browserTab("b", "HTTPS://Docs.Example:443/guide/#top", "")),
		browserBlock("p-elsewhere", "tab-2", "c", browserTab("c", "https://docs.example/other", "")),
	}
	pages := openPagesOf("tab-1", blocks, []any{"p-recent", "p-old"})
	best, ok := molten.BestOpenPage(pages, moltenPageUrl("docs.example/guide"))
	if !ok || best.PanelId != "p-recent" || best.TabId != "b" {
		t.Fatalf("the page that was in use last: %+v %v", best, ok)
	}
	if _, ok := molten.BestOpenPage(pages, moltenPageUrl("docs.example/other")); ok {
		t.Fatalf("a page of another Wave tab is not offered: the developer is not looking there")
	}
	if _, ok := molten.BestOpenPage(pages, moltenPageUrl("docs.example/guide?x=1")); ok {
		t.Fatalf("another query is another page")
	}
	if _, ok := molten.BestOpenPage(pages, moltenPageUrl("file:///tmp/a.html")); ok {
		t.Fatalf("a local page never matches")
	}
}

func TestShowRequestsAreOneKeyEachAndNameTheTab(t *testing.T) {
	first := molten.BrowserShowRequestMeta("01", "tab-a")
	second := molten.BrowserShowRequestMeta("02", "tab-b")
	if first[molten.BrowserShowKeyPrefix+"01"] != "tab-a" || len(first) != 1 || second[molten.BrowserShowKeyPrefix+"02"] != "tab-b" {
		t.Fatalf("one key per request, so concurrent wsh writes merge: %v %v", first, second)
	}
	if !strings.HasPrefix(molten.BrowserShowKeyPrefix, "molten:browser:") {
		t.Fatalf("the logs mask every molten:browser: key")
	}
	logged := molten.LoggableMeta(first)
	if logged[molten.BrowserShowKeyPrefix+"01"] == "tab-a" {
		t.Fatalf("a request is not logged as written: %v", logged)
	}
}

func TestMoltenOpenKeepsAFlagForASecondCopy(t *testing.T) {
	found, _, err := rootCmd.Find([]string{"molten", "open", "--new-tab", "https://example.com"})
	if err != nil || found != moltenOpenCmd {
		t.Fatalf("molten open: %v %v", found, err)
	}
	flag := moltenOpenCmd.Flags().Lookup("new-tab")
	if flag == nil || flag.DefValue != "false" {
		t.Fatalf("molten open reuses by default, --new-tab opens another: %+v", flag)
	}
	if moltenOpenCmd.Flags().Lookup("reload") != nil {
		t.Fatalf("a command never reloads a page the developer opened")
	}
}
