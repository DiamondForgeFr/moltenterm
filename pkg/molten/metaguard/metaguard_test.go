// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package metaguard_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/molten/metaguard"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

const (
	ownWs   = "ws-own"
	otherWs = "ws-other"
)

func terminal() metaguard.Caller {
	return metaguard.Caller{Local: true, BlockId: routetest.TerminalBlock, WorkspaceId: ownWs}
}

func untrusted() []struct {
	name string
	c    metaguard.Caller
} {
	return []struct {
		name string
		c    metaguard.Caller
	}{
		{"local terminal", terminal()},
		{"terminal without a block", metaguard.Caller{Local: true}},
		{"remote or forged", metaguard.Caller{}},
	}
}

func TestCallerOf(t *testing.T) {
	e := routetest.Make(t)
	trusted := []routetest.From{e.Window(), e.Electron(), e.WindowRoute(t, "feblock:term"), e.InProcess(t, "bare:wavesrv")}
	for _, from := range trusted {
		if got := metaguard.CallerOf(e.Router, from.Source, from.Link); got != (metaguard.Caller{Trusted: true}) {
			t.Errorf("%s: %+v, want trusted", from.Name, got)
		}
	}
	term := e.Terminal()
	if got := metaguard.CallerOf(e.Router, term.Source, term.Link); got != (metaguard.Caller{Local: true, BlockId: routetest.TerminalBlock}) {
		t.Errorf("local terminal: %+v", got)
	}
	forged := append(e.Forged(),
		routetest.From{Name: "terminal names the bare client", Source: "bare:wavesrv", Link: term.Link},
		routetest.From{Name: "terminal names a window route", Source: "feblock:term", Link: term.Link},
		routetest.From{Name: "terminal names wavesrv", Source: "wavesrv", Link: term.Link},
	)
	for _, from := range forged {
		if got := metaguard.CallerOf(e.Router, from.Source, from.Link); got != (metaguard.Caller{}) {
			t.Errorf("%s (%q): %+v, want an unverified caller", from.Name, from.Source, got)
		}
	}
	if got := metaguard.CallerOf(nil, term.Source, term.Link); got != (metaguard.Caller{}) {
		t.Errorf("no router: %+v", got)
	}
}

func mustRefuse(t *testing.T, name string, err error) {
	t.Helper()
	if err == nil || !strings.HasPrefix(err.Error(), "refused: a terminal cannot") || !strings.Contains(err.Error(), "MoltenTerm window") {
		t.Errorf("%s: %v, want a refusal naming the window", name, err)
	}
}

func TestWorkspaceWrites(t *testing.T) {
	own := waveobj.MakeORef(waveobj.OType_Workspace, ownWs)
	other := waveobj.MakeORef(waveobj.OType_Workspace, otherWs)
	link := waveobj.MetaMapType{molten.ProjectMetaKey: "/p", molten.WorkspaceRecentFoldersMetaKey: []any{"/p"}, molten.ProjectRepoMetaKey: nil, molten.ProjectLogoMetaKey: nil, molten.ProjectLogoOfferMetaKey: nil}
	if err := metaguard.CheckWrite(terminal(), own, link); err != nil {
		t.Fatalf("molten project link on its own workspace: %v", err)
	}
	trusted := metaguard.Caller{Trusted: true}
	for _, meta := range []waveobj.MetaMapType{link, {"molten:bookmarks": []any{}}, {"molten:tabprojects": nil}} {
		if err := metaguard.CheckWrite(trusted, other, meta); err != nil {
			t.Fatalf("the window was refused %v: %v", meta, err)
		}
	}
	for _, u := range untrusted() {
		mustRefuse(t, u.name+" on another workspace", metaguard.CheckWrite(u.c, other, link))
		for _, key := range []string{"molten:bookmarks", "molten:projects", "molten:tabprojects", molten.WorkspaceFolderMetaKey, "molten:globalpins", "name"} {
			mustRefuse(t, u.name+" sets "+key, metaguard.CheckWrite(u.c, own, waveobj.MetaMapType{key: "x"}))
			mustRefuse(t, u.name+" sets "+key+" with the link", metaguard.CheckWrite(u.c, own, waveobj.MetaMapType{molten.ProjectMetaKey: "/p", key: "x"}))
		}
	}
	for _, c := range []metaguard.Caller{{Local: true}, {}, {Local: true, BlockId: "b"}} {
		mustRefuse(t, "a caller without its workspace links a project", metaguard.CheckWrite(c, own, link))
	}
}

func TestOtherObjectWrites(t *testing.T) {
	ownBlock := waveobj.MakeORef(waveobj.OType_Block, routetest.TerminalBlock)
	otherBlock := waveobj.MakeORef(waveobj.OType_Block, "block-other")
	tab := waveobj.MakeORef(waveobj.OType_Tab, "tab")
	window := waveobj.MakeORef(waveobj.OType_Window, "win")
	client := waveobj.MakeORef(waveobj.OType_Client, "client")
	allowed := []struct {
		name string
		oref waveobj.ORef
		meta waveobj.MetaMapType
	}{
		{"own block, molten worktree", ownBlock, waveobj.MetaMapType{molten.WorktreeMetaKey: "/w"}},
		{"own block, any molten key", ownBlock, waveobj.MetaMapType{molten.AgentFirstNameMetaKey: "Ada", "term:mode": "vdom"}},
		{"browser panel page", otherBlock, molten.BrowserOpenRequestMeta("01", "https://example.com")},
		{"browser panel close", otherBlock, molten.BrowserCloseRequestMeta("01", "t1")},
		{"file panel", otherBlock, waveobj.MetaMapType{"file": "/p/a", "molten:fileorigin": "agent", "molten:filefilter": "*.go"}},
		{"wave keys on another block", otherBlock, waveobj.MetaMapType{"connection": "local", "bg": "red"}},
		{"wave keys on a tab", tab, waveobj.MetaMapType{"bg": "red", "bg:opacity": 0.5}},
		{"wave keys on a window", window, waveobj.MetaMapType{"bg": "red"}},
	}
	for _, a := range allowed {
		if err := metaguard.CheckWrite(terminal(), a.oref, a.meta); err != nil {
			t.Errorf("%s: %v", a.name, err)
		}
	}
	refused := []struct {
		name string
		oref waveobj.ORef
		meta waveobj.MetaMapType
	}{
		{"pin a view", tab, waveobj.MetaMapType{"molten:pin": true}},
		{"pin everywhere", tab, waveobj.MetaMapType{"bg": "red", "molten:globalpin": true}},
		{"window state", window, waveobj.MetaMapType{"molten:hiddentabs": []any{}}},
		{"client state", client, waveobj.MetaMapType{"molten:workspaceorder": []any{}}},
		{"another block's browser tabs", otherBlock, waveobj.MetaMapType{molten.BrowserTabsMetaKey: []any{}}},
		{"another block's worktree", otherBlock, waveobj.MetaMapType{molten.WorktreeMetaKey: "/w"}},
	}
	for _, r := range refused {
		mustRefuse(t, r.name, metaguard.CheckWrite(terminal(), r.oref, r.meta))
		if err := metaguard.CheckWrite(metaguard.Caller{Trusted: true}, r.oref, r.meta); err != nil {
			t.Errorf("the window was refused %s: %v", r.name, err)
		}
	}
	mustRefuse(t, "a remote caller on the terminal's block", metaguard.CheckWrite(metaguard.Caller{}, ownBlock, waveobj.MetaMapType{molten.WorktreeMetaKey: "/w"}))
}

func TestWorkspaceReads(t *testing.T) {
	own := waveobj.MakeORef(waveobj.OType_Workspace, ownWs)
	other := waveobj.MakeORef(waveobj.OType_Workspace, otherWs)
	meta := waveobj.MetaMapType{molten.ProjectMetaKey: "/p", molten.ProjectRepoMetaKey: "/p/r", "molten:bookmarks": []any{"https://x/?token=1"}, "molten:tabprojects": map[string]any{}}
	got, err := metaguard.ReadMeta(terminal(), own, meta)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[molten.ProjectMetaKey] != "/p" || got[molten.ProjectRepoMetaKey] != "/p/r" {
		t.Fatalf("own workspace: %v, want the project link only", got)
	}
	for _, u := range untrusted() {
		if _, err := metaguard.ReadMeta(u.c, other, meta); err == nil || !strings.HasPrefix(err.Error(), "refused: a terminal cannot read") {
			t.Errorf("%s read another workspace: %v", u.name, err)
		}
		if listed := metaguard.ListedWorkspaceMeta(u.c, otherWs, meta); len(listed) != 0 {
			t.Errorf("%s listed another workspace's meta: %v", u.name, listed)
		}
	}
	if listed := metaguard.ListedWorkspaceMeta(terminal(), ownWs, meta); len(listed) != 2 || listed["molten:bookmarks"] != nil {
		t.Errorf("own workspace listed: %v", listed)
	}
	trusted := metaguard.Caller{Trusted: true}
	if got, err := metaguard.ReadMeta(trusted, other, meta); err != nil || len(got) != len(meta) {
		t.Errorf("the window read %v, %v", got, err)
	}
	if listed := metaguard.ListedWorkspaceMeta(trusted, otherWs, meta); len(listed) != len(meta) {
		t.Errorf("the window listed %v", listed)
	}
	tab := waveobj.MakeORef(waveobj.OType_Tab, "tab")
	if got, err := metaguard.ReadMeta(metaguard.Caller{}, tab, waveobj.MetaMapType{molten.BrowserRecentMetaKey: "b"}); err != nil || got[molten.BrowserRecentMetaKey] != "b" {
		t.Errorf("a tab's meta: %v, %v", got, err)
	}
}

func TestTooWideProjectFolder(t *testing.T) {
	own := waveobj.MakeORef(waveobj.OType_Workspace, ownWs)
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "root")
	if err := os.Symlink("/", link); err != nil {
		t.Fatal(err)
	}
	homeLink := filepath.Join(t.TempDir(), "home")
	if err := os.Symlink(home, homeLink); err != nil {
		t.Fatal(err)
	}
	wide := []string{"/", "//", home, home + "/", home + "/.", filepath.Dir(home), link, homeLink, home + "/code/..", filepath.Join(link, filepath.Dir(home))}
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		wide = append(wide, strings.ToUpper(home), strings.ToUpper(filepath.Dir(home)))
	}
	for _, folder := range wide {
		mustRefuse(t, "project folder "+folder, metaguard.CheckWrite(terminal(), own, waveobj.MetaMapType{molten.ProjectMetaKey: folder}))
		if err := metaguard.CheckWrite(metaguard.Caller{Trusted: true}, own, waveobj.MetaMapType{molten.ProjectMetaKey: folder}); err != nil {
			t.Errorf("the window was refused %s: %v", folder, err)
		}
	}
	for _, folder := range []string{filepath.Join(home, "code", "app"), "/tmp/p", ""} {
		if err := metaguard.CheckWrite(terminal(), own, waveobj.MetaMapType{molten.ProjectMetaKey: folder}); err != nil {
			t.Errorf("project folder %q: %v", folder, err)
		}
	}
	if err := metaguard.CheckWrite(terminal(), own, waveobj.MetaMapType{molten.ProjectMetaKey: nil}); err != nil {
		t.Errorf("molten project unlink: %v", err)
	}
}

func TestPublish(t *testing.T) {
	for _, event := range []string{wps.Event_Badge, wps.Event_SysInfo, "molten:modschanged"} {
		for _, u := range untrusted() {
			if err := metaguard.CheckPublish(u.c, event); err != nil {
				t.Errorf("%s publishing %s: %v", u.name, event, err)
			}
		}
	}
	serverOwned := []string{wps.Event_WaveObjUpdate, wps.Event_Config, wps.Event_WorkspaceUpdate, wps.Event_BlockClose, wps.Event_BlockFile,
		wps.Event_ControllerStatus, wps.Event_UserInput, wps.Event_RouteDown, wps.Event_AIModeConfig, wps.Event_BlockJobStatus,
		molten.AgentStateEvent, molten.MaterialsEvent, "anything:else"}
	for _, event := range serverOwned {
		for _, u := range untrusted() {
			if err := metaguard.CheckPublish(u.c, event); err == nil || !strings.HasPrefix(err.Error(), "refused: a terminal cannot publish") {
				t.Errorf("%s published %s: %v", u.name, event, err)
			}
		}
		if err := metaguard.CheckPublish(metaguard.Caller{Trusted: true}, event); err != nil {
			t.Errorf("wavesrv or the window could not publish %s: %v", event, err)
		}
	}
}

func TestSubscribe(t *testing.T) {
	inOwn := func(oref waveobj.ORef) bool { return oref.OID == "own-tab" || oref.OID == routetest.TerminalBlock }
	sub := func(scopes ...string) wps.SubscriptionRequest {
		return wps.SubscriptionRequest{Event: wps.Event_WaveObjUpdate, Scopes: scopes}
	}
	allowed := []wps.SubscriptionRequest{
		sub("block:" + routetest.TerminalBlock),
		sub("tab:own-tab", "block:"+routetest.TerminalBlock),
		{Event: wps.Event_BlockClose, AllScopes: true},
		{Event: wps.Event_Config, AllScopes: true},
	}
	for _, req := range allowed {
		if err := metaguard.CheckSubscribe(terminal(), req, inOwn); err != nil {
			t.Errorf("%+v: %v", req, err)
		}
	}
	refused := []wps.SubscriptionRequest{
		{Event: wps.Event_WaveObjUpdate, AllScopes: true},
		sub(),
		sub("workspace:" + ownWs),
		sub("workspace:" + otherWs),
		sub("client:c"),
		sub("window:w"),
		sub("tab:other-tab"),
		sub("block:other"),
		sub("tab:own-tab", "block:other"),
		sub("block:*"),
		sub("garbage"),
	}
	for _, req := range refused {
		for _, u := range untrusted() {
			if err := metaguard.CheckSubscribe(u.c, req, inOwn); err == nil || !strings.HasPrefix(err.Error(), "refused: a terminal cannot follow") {
				t.Errorf("%s subscribed %+v: %v", u.name, req, err)
			}
		}
		if err := metaguard.CheckSubscribe(metaguard.Caller{Trusted: true}, req, inOwn); err != nil {
			t.Errorf("the window was refused %+v: %v", req, err)
		}
	}
}

// MoltenTerm's own events reach the windows and local terminals, never a remote or unverified caller (#1914).
func TestSubscribeMoltenEvents(t *testing.T) {
	never := func(waveobj.ORef) bool { return false }
	reqs := []wps.SubscriptionRequest{
		{Event: molten.MorphDesignEvent, AllScopes: true},
		{Event: molten.MorphDesignHandoffEvent, Scopes: []string{"mod-id"}},
		{Event: molten.AgentStateEvent, Scopes: []string{"workspace:" + ownWs}},
		{Event: molten.ModsChangedEvent, AllScopes: true},
		{Event: "molten:review:state", AllScopes: true},
	}
	admitted := []struct {
		name string
		c    metaguard.Caller
	}{
		{"window", metaguard.Caller{Trusted: true}},
		{"local terminal", terminal()},
		{"terminal without a block", metaguard.Caller{Local: true}},
	}
	for _, req := range reqs {
		for _, a := range admitted {
			if err := metaguard.CheckSubscribe(a.c, req, never); err != nil {
				t.Errorf("%s refused %+v: %v", a.name, req, err)
			}
		}
		err := metaguard.CheckSubscribe(metaguard.Caller{}, req, never)
		if err == nil || !strings.HasPrefix(err.Error(), "refused: a remote or unverified terminal cannot follow MoltenTerm's") || !strings.Contains(err.Error(), req.Event) {
			t.Errorf("remote subscribed %+v: %v", req, err)
		}
	}
	others := []wps.SubscriptionRequest{
		{Event: wps.Event_BlockClose, AllScopes: true},
		{Event: wps.Event_Config, AllScopes: true},
		{Event: wps.Event_Badge, AllScopes: true},
		{Event: "moltenish", AllScopes: true},
	}
	for _, req := range others {
		if err := metaguard.CheckSubscribe(metaguard.Caller{}, req, never); err != nil {
			t.Errorf("remote refused %+v outside the molten: family: %v", req, err)
		}
	}
}

func TestCreateBlock(t *testing.T) {
	allowed := []waveobj.MetaMapType{
		{"view": molten.BrowserView, "url": "https://example.com"},
		molten.BrowserEnvBlockMeta("https://example.com", true),
		{"view": "preview", "file": "/p/a", "molten:fileorigin": "agent"},
		{"view": "term", "controller": "cmd"},
		nil,
	}
	for _, meta := range allowed {
		if err := metaguard.CheckCreateBlock(terminal(), true, meta); err != nil {
			t.Errorf("%v: %v", meta, err)
		}
		if err := metaguard.CheckCreateBlock(metaguard.Caller{}, false, meta); err != nil {
			t.Errorf("a remote host's %v: %v", meta, err)
		}
	}
	mustRefuse(t, "a panel in another workspace's tab", metaguard.CheckCreateBlock(terminal(), false, waveobj.MetaMapType{"view": "term"}))
	for _, meta := range []waveobj.MetaMapType{{molten.BrowserTabsMetaKey: []any{}}, {"view": "term", molten.AgentFirstNameMetaKey: "Ada"}, {"molten:pin": true}} {
		for _, u := range untrusted() {
			mustRefuse(t, u.name+" creates with molten keys", metaguard.CheckCreateBlock(u.c, true, meta))
		}
		if err := metaguard.CheckCreateBlock(metaguard.Caller{Trusted: true}, false, meta); err != nil {
			t.Errorf("the window was refused %v: %v", meta, err)
		}
	}
}

// The developer's note on an agent is never the agent's to read (FR-SHELL-084, #2008): it lives in the workspace's meta,
// which a terminal neither reads, writes nor follows, while its own block's meta, and its workspace's other blocks',
// are open to it.
func TestAgentNotesStayOutOfATerminalsReach(t *testing.T) {
	own := waveobj.MakeORef(waveobj.OType_Workspace, ownWs)
	notes := waveobj.MetaMapType{molten.AgentNotesMetaKey: map[string]any{routetest.TerminalBlock: "audit sécu nov6, ne pas relancer"}}
	withLink := waveobj.MetaMapType{molten.ProjectMetaKey: "/p", molten.AgentNotesMetaKey: notes[molten.AgentNotesMetaKey]}
	trusted := metaguard.Caller{Trusted: true}
	if err := metaguard.CheckWrite(trusted, own, notes); err != nil {
		t.Fatalf("the window was refused its notes: %v", err)
	}
	for _, u := range untrusted() {
		mustRefuse(t, u.name+" writes the notes", metaguard.CheckWrite(u.c, own, notes))
		mustRefuse(t, u.name+" writes the notes with the link", metaguard.CheckWrite(u.c, own, withLink))
		if got, err := metaguard.ReadMeta(u.c, own, withLink); err == nil && got[molten.AgentNotesMetaKey] != nil {
			t.Errorf("%s read the notes of its own workspace: %v", u.name, got)
		}
		if listed := metaguard.ListedWorkspaceMeta(u.c, ownWs, withLink); listed[molten.AgentNotesMetaKey] != nil {
			t.Errorf("%s listed the notes of its own workspace: %v", u.name, listed)
		}
		req := wps.SubscriptionRequest{Event: wps.Event_WaveObjUpdate, Scopes: []string{"workspace:" + ownWs}}
		if err := metaguard.CheckSubscribe(u.c, req, func(waveobj.ORef) bool { return true }); err == nil {
			t.Errorf("%s follows the updates of its workspace, whose meta holds the notes", u.name)
		}
	}
	if got, err := metaguard.ReadMeta(trusted, own, withLink); err != nil || got[molten.AgentNotesMetaKey] == nil {
		t.Errorf("the window read %v, %v", got, err)
	}
	onBlock := waveobj.MetaMapType{"view": "term", molten.AgentNotesMetaKey: "on the block"}
	if got := metaguard.ReadBlockMeta(terminal(), true, onBlock); got[molten.AgentNotesMetaKey] == nil {
		t.Errorf("the block's meta is open to its workspace's terminals: that is why the notes are not kept there")
	}
}

func TestReadBlockMeta(t *testing.T) {
	meta := waveobj.MetaMapType{"view": molten.BrowserView, "url": "https://a", molten.BrowserTabsMetaKey: []any{"https://x/?token=1"}}
	if got := metaguard.ReadBlockMeta(terminal(), true, meta); len(got) != 3 {
		t.Errorf("own workspace's block: %v", got)
	}
	for _, c := range []metaguard.Caller{terminal(), {}} {
		got := metaguard.ReadBlockMeta(c, false, meta)
		if len(got) != 2 || got[molten.BrowserTabsMetaKey] != nil || got["view"] != molten.BrowserView {
			t.Errorf("another workspace's block for %+v: %v", c, got)
		}
	}
	if got := metaguard.ReadBlockMeta(metaguard.Caller{}, true, meta); got[molten.BrowserTabsMetaKey] != nil {
		t.Errorf("a remote host read molten keys: %v", got)
	}
	if got := metaguard.ReadBlockMeta(metaguard.Caller{Trusted: true}, false, meta); len(got) != 3 {
		t.Errorf("the window: %v", got)
	}
}

func TestTabOrder(t *testing.T) {
	current := []string{"t1", "t2", "t3"}
	if err := metaguard.CheckTabOrder(terminal(), current, []string{"t3", "t1", "t2"}); err != nil {
		t.Errorf("a reorder: %v", err)
	}
	refused := [][]string{
		{"t1", "t2", "t3", "other-ws-tab"},
		{"t1", "t2", "other-ws-tab"},
		{"t1", "t2"},
		{"t1", "t1", "t2"},
		{"t1", "t2", "t3", "t3"},
		{},
	}
	for _, next := range refused {
		for _, u := range untrusted() {
			if err := metaguard.CheckTabOrder(u.c, current, next); err == nil || !strings.HasPrefix(err.Error(), "refused: a terminal can only reorder") {
				t.Errorf("%s set the tabs to %v: %v", u.name, next, err)
			}
		}
		if err := metaguard.CheckTabOrder(metaguard.Caller{Trusted: true}, current, next); err != nil {
			t.Errorf("the window was refused %v: %v", next, err)
		}
	}
}

func TestOwnWorkspace(t *testing.T) {
	if err := metaguard.CheckOwnWorkspace(terminal(), ownWs, "rename a tab"); err != nil {
		t.Errorf("own workspace: %v", err)
	}
	for _, u := range untrusted() {
		mustRefuse(t, u.name+" in another workspace", metaguard.CheckOwnWorkspace(u.c, otherWs, "rename a tab"))
		mustRefuse(t, u.name+" in an unknown workspace", metaguard.CheckOwnWorkspace(u.c, "", "reorder tabs"))
	}
	if err := metaguard.CheckOwnWorkspace(metaguard.Caller{Trusted: true}, otherWs, "rename a tab"); err != nil {
		t.Errorf("the window: %v", err)
	}
}
