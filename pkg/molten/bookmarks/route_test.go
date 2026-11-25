// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package bookmarks

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The workspace ws-a of the fixture: projects p1 (Desktop, the current one) and p2 (Website); tab-web belongs to
// Website. It has no molten:context, so it is in the first context.
const workspaceWithTwoProjects = `{
  "molten:projects": [
    {"id": "p1", "type": "Desktop", "dir": "/work/app"},
    {"id": "p2", "type": "", "dir": "/work/site"}
  ],
  "molten:currentproject": "p1",
  "molten:project": "/work/app",
  "molten:projecttype": "Desktop",
  "molten:tabprojects": {"tab-web": "p2", "tab-app": "p1"}
}`

const contextsOfTheFixture = `[{"id": "ctx-client", "name": "Client SEFERS"}, {"id": "ctx-perso", "name": "Personal"}]`

func workspaceMeta(t *testing.T, raw string) waveobj.MetaMapType {
	t.Helper()
	var m waveobj.MetaMapType
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func fixtureClientMeta(t *testing.T) waveobj.MetaMapType {
	t.Helper()
	meta := clientMeta(t, fixtureStore)
	var list any
	if err := json.Unmarshal([]byte(contextsOfTheFixture), &list); err != nil {
		t.Fatal(err)
	}
	meta["molten:contexts"] = list
	return meta
}

func siteOf(t *testing.T, workspaceRaw string, tabId string) terminalSite {
	t.Helper()
	return terminalSite{workspaceId: "ws-a", workspaceName: "Acme", workspaceMeta: workspaceMeta(t, workspaceRaw), tabId: tabId, clientMeta: fixtureClientMeta(t)}
}

func fakeReader(site terminalSite) siteReader {
	return func(blockId string) (terminalSite, error) {
		if blockId != "block-1" {
			return terminalSite{}, fmt.Errorf("block %s not found", blockId)
		}
		return site, nil
	}
}

func localCallerOf(blockId string) localroute.Caller {
	return localroute.Caller{IsLocalTerminal: true, BlockId: blockId}
}

var terminalCaller = localCallerOf("block-1")

func listFrom(t *testing.T, site terminalSite) molten.BookmarksView {
	t.Helper()
	out, err := (&routeLink{read: fakeReader(site)}).handle(molten.BookmarksListCommand, terminalCaller, molten.BookmarksRequest{BlockId: "block-1"})
	if err != nil {
		t.Fatal(err)
	}
	return out.(molten.BookmarksView)
}

func TestRouteListsWhatTheTerminalsPlaceSees(t *testing.T) {
	t.Parallel()
	view := listFrom(t, siteOf(t, workspaceWithTwoProjects, "tab-app"))
	if view.Project.Id != "p1" || view.Project.Name != "Desktop" || view.Workspace != "Acme" || view.Context != "Client SEFERS" {
		t.Fatalf("view %+v", view)
	}
	want := []string{
		"Staging @ project:Desktop:, context:Client SEFERS:Ops",
		"Vite config @ project:Desktop:Docs, app::",
		"Dashboards @ workspace:Acme:Shared",
		"Everywhere @ app::",
	}
	if got := shapes(view.Bookmarks); !reflect.DeepEqual(got, want) {
		t.Fatalf("Desktop sees\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	web := listFrom(t, siteOf(t, workspaceWithTwoProjects, "tab-web"))
	if web.Project.Id != "p2" || web.Project.Name != "site" {
		t.Fatalf("a terminal of the Website tab reads Website: %+v", web.Project)
	}
	if got, want := titles(web.Bookmarks), []string{"Site", "Dashboards", "Staging", "Vite config", "Everywhere"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Website sees %v, want %v", got, want)
	}
}

// Another workspace's project p1 is not this workspace's p1.
func TestRouteSeparatesTheProjectsOfTwoWorkspaces(t *testing.T) {
	t.Parallel()
	site := siteOf(t, workspaceWithTwoProjects, "tab-app")
	site.workspaceId, site.workspaceName = "ws-b", "Beta"
	view := listFrom(t, site)
	if got, want := titles(view.Bookmarks), []string{"Everywhere", "Other workspace's p1", "Staging", "Vite config"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ws-b/p1 sees %v, want %v", got, want)
	}
}

func TestRouteListsTheWorkspaceTheContextAndTheAppWhenTheWorkspaceHasNoProject(t *testing.T) {
	t.Parallel()
	view := listFrom(t, siteOf(t, `{}`, "tab-x"))
	if view.Project != (molten.BookmarksProject{}) || view.Workspace != "Acme" || view.Context != "Client SEFERS" {
		t.Fatalf("view %+v", view)
	}
	want := []string{
		"Dashboards @ workspace:Acme:Shared",
		"Staging @ context:Client SEFERS:Ops",
		"Vite config @ app::",
		"Everywhere @ app::",
	}
	if got := shapes(view.Bookmarks); !reflect.DeepEqual(got, want) {
		t.Fatalf("a workspace with no project yet sees\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestRouteFollowsTheContextOfTheWorkspace(t *testing.T) {
	t.Parallel()
	view := listFrom(t, siteOf(t, `{"molten:context": "ctx-perso"}`, "tab-x"))
	if view.Context != "Personal" {
		t.Fatalf("context %q", view.Context)
	}
	want := []string{
		"Dashboards @ workspace:Acme:Shared",
		"Everywhere @ context:Personal:, app::",
		"Personal @ context:Personal:Secret context folder",
		"Vite config @ app::",
	}
	if got := shapes(view.Bookmarks); !reflect.DeepEqual(got, want) {
		t.Fatalf("got\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if unknown := listFrom(t, siteOf(t, `{"molten:context": "gone"}`, "tab-x")); unknown.Context != "Client SEFERS" {
		t.Errorf("a workspace of a context that is gone is in the first context: %q", unknown.Context)
	}
}

func TestRouteAnswersAnEmptyListWhenNothingIsVisible(t *testing.T) {
	t.Parallel()
	site := siteOf(t, workspaceWithTwoProjects, "tab-app")
	site.clientMeta = nil
	view := listFrom(t, site)
	if view.Bookmarks == nil || len(view.Bookmarks) != 0 {
		t.Errorf("a client with no bookmark lists an empty array: %+v", view.Bookmarks)
	}
	if view.Context != "workshop" || view.Project.Id != "p1" {
		t.Errorf("view %+v", view)
	}
}

// What the route answers carries nothing of the places the terminal is not in, whatever its JSON is read as.
func TestRouteAnswersNeverNameAnotherPlace(t *testing.T) {
	t.Parallel()
	view := listFrom(t, siteOf(t, workspaceWithTwoProjects, "tab-app"))
	data, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"ctx-perso", "ws-b", "Secret", "Personal", "other-workspace", "Website"} {
		if strings.Contains(string(data), leak) {
			t.Errorf("%q reached the terminal: %s", leak, data)
		}
	}
}

func TestRouteRefusesWhatIsNotAListing(t *testing.T) {
	t.Parallel()
	l := &routeLink{read: fakeReader(siteOf(t, workspaceWithTwoProjects, "tab-app"))}
	for _, command := range []string{"moltenbookmarksadd", "moltenbookmarksdelete", "moltenbookmarksset", ""} {
		if _, err := l.handle(command, terminalCaller, molten.BookmarksRequest{BlockId: "block-1"}); err == nil {
			t.Errorf("%q was answered: agents only read", command)
		}
	}
	if _, err := l.handle(molten.BookmarksListCommand, terminalCaller, molten.BookmarksRequest{}); err == nil {
		t.Error("a listing without a terminal was answered")
	}
	policy := l.route().Policy
	if !policy.Admits(molten.BookmarksListCommand, terminalCaller) || policy.Admits(molten.BookmarksListCommand, localroute.Caller{}) {
		t.Error("only local callers list")
	}
}

func TestRouteRefusesATerminalThatAsksForAnotherTerminalsWorkspace(t *testing.T) {
	t.Parallel()
	l := &routeLink{read: fakeReader(siteOf(t, workspaceWithTwoProjects, "tab-app"))}
	if _, err := l.handle(molten.BookmarksListCommand, terminalCaller, molten.BookmarksRequest{BlockId: "block-2"}); err == nil || !strings.Contains(err.Error(), "its own workspace") {
		t.Errorf("a terminal read another terminal's workspace: %v", err)
	}
	other := localroute.Caller{IsLocalTerminal: true, BlockId: "block-2"}
	if _, err := l.handle(molten.BookmarksListCommand, other, molten.BookmarksRequest{BlockId: "block-1"}); err == nil {
		t.Error("a terminal named another terminal's block")
	}
	failing := &routeLink{read: func(string) (terminalSite, error) { return terminalSite{}, fmt.Errorf("no such block") }}
	if _, err := failing.handle(molten.BookmarksListCommand, terminalCaller, molten.BookmarksRequest{BlockId: "block-1"}); err == nil {
		t.Error("a block that cannot be read was answered")
	}
}
