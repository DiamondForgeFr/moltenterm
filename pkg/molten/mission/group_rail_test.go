// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func linkedWorkspace(id string, dir string) *waveobj.Workspace {
	ws := &waveobj.Workspace{OID: id, Name: id, Meta: waveobj.MetaMapType{}}
	if dir != "" {
		ws.Meta[molten.ProjectMetaKey] = dir
	}
	return ws
}

func TestLinksFollowTheRailOrder(t *testing.T) {
	workspaces := []*waveobj.Workspace{
		linkedWorkspace("app", "/r/app"),
		linkedWorkspace("plain", ""),
		linkedWorkspace("site", "/r/site"),
		linkedWorkspace("new", "/r/new"),
	}
	links := linksInOrder(workspaces, []string{"site", "gone", "plain", "app"})
	got := []string{}
	for _, link := range links {
		got = append(got, link.WorkspaceId)
	}
	want := []string{"site", "app", "new"}
	if len(got) != len(want) {
		t.Fatalf("links = %v; want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("links = %v; want %v", got, want)
		}
	}
	if links[0].Dir != "/r/site" || links[0].WorkspaceName != "site" {
		t.Fatalf("link content: %+v", links[0])
	}
	if got := linksInOrder(workspaces, nil); len(got) != 3 || got[0].WorkspaceId != "app" {
		t.Fatalf("without a stored order the database's order stays: %+v", got)
	}
}

func TestProductsOf(t *testing.T) {
	groups := []molten.ProjectGroup{
		{Key: "notulia", Members: []molten.GroupMember{
			{Dir: "/r/app", Workspaces: []molten.GroupWorkspace{{Id: "app"}, {Id: "app2"}}},
			{Dir: "/r/site", Workspaces: []molten.GroupWorkspace{{Id: "site"}}},
		}},
		{Key: "lone", Members: []molten.GroupMember{
			{Dir: "/r/lone", Workspaces: []molten.GroupWorkspace{{Id: "lone"}, {Id: "lone2"}}},
		}},
	}
	products := productsOf(groups)
	if len(products) != 3 || products["app"] != "notulia" || products["app2"] != "notulia" || products["site"] != "notulia" {
		t.Fatalf("products = %v", products)
	}
	if _, ok := products["lone"]; ok {
		t.Fatalf("a group of one member is no product: %v", products)
	}
}
