// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package railorder

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestCleanGroupNameDropsControls(t *testing.T) {
	got, err := CleanGroupName(" Cli\x1b[31ments‮ ")
	if err != nil || got != "Cli[31ments" {
		t.Fatalf("CleanGroupName = %q, %v", got, err)
	}
}

func TestProductsSeenRunsOnePassAtATime(t *testing.T) {
	defer SetReconcile(nil)
	release := make(chan struct{})
	seen := make(chan ProductMap, 8)
	SetReconcile(func(p ProductMap) {
		seen <- p
		<-release
	})
	ProductsSeen(ProductMap{Names: map[string]string{"n": "1"}})
	first := <-seen
	ProductsSeen(ProductMap{Names: map[string]string{"n": "2"}})
	ProductsSeen(ProductMap{Names: map[string]string{"n": "3"}})
	release <- struct{}{}
	second := <-seen
	release <- struct{}{}
	if first.Names["n"] != "1" || second.Names["n"] != "3" {
		t.Fatalf("passes = %v, %v; want the first, then only the newest", first.Names, second.Names)
	}
	select {
	case extra := <-seen:
		t.Fatalf("an extra pass ran: %v", extra.Names)
	case <-time.After(50 * time.Millisecond):
	}
}

// Rail: a, b, c, d (plain), app, site (the Notulia product).
func testRail(groups ...LocalGroup) Rail {
	return Rail{
		Order:    []string{"a", "b", "c", "d", "app", "site"},
		Groups:   groups,
		Products: ProductMap{Of: map[string]string{"app": "notulia", "site": "notulia"}, Names: map[string]string{"notulia": "Notulia"}},
		Names:    map[string]string{"a": "A", "b": "B", "c": "C", "d": "D", "app": "App", "site": "Site"},
	}
}

// must normalizes a change's result, as every write does, and fails the test on an error.
func must(t *testing.T) func(Rail, error) Rail {
	return func(r Rail, err error) Rail {
		t.Helper()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		normal, _ := r.Normalize()
		return normal
	}
}

func norm(r Rail) Rail {
	normal, _ := r.Normalize()
	return normal
}

func onlyGroup(t *testing.T, r Rail) LocalGroup {
	t.Helper()
	if len(r.Groups) != 1 {
		t.Fatalf("groups = %+v; want one", r.Groups)
	}
	return r.Groups[0]
}

func TestJoinMakesAGroupAtTheTargetsPlace(t *testing.T) {
	r := must(t)(testRail().Join(JoinRequest{WorkspaceId: "d", TargetId: "b"}))
	group := onlyGroup(t, r)
	if !slices.Equal(group.Members, []string{"b", "d"}) || group.Name != "" || group.Id == "" {
		t.Fatalf("group = %+v", group)
	}
	if want := []string{"a", "b", "d", "c", "app", "site"}; !slices.Equal(r.Order, want) {
		t.Fatalf("order = %v; want %v", r.Order, want)
	}
	if r.GroupName(group) != "B" {
		t.Fatalf("default name = %q; want the first member's", r.GroupName(group))
	}
	// A workspace above the target joins at the group's end, below it: the group stays at the target's place.
	r = must(t)(r.Join(JoinRequest{WorkspaceId: "a", TargetId: "d"}))
	if group := onlyGroup(t, r); !slices.Equal(group.Members, []string{"b", "d", "a"}) {
		t.Fatalf("members = %v", group.Members)
	}
	if want := []string{"b", "d", "a", "c", "app", "site"}; !slices.Equal(r.Order, want) {
		t.Fatalf("order = %v; want %v", r.Order, want)
	}
	// By the group's id, as the menu's Group with does.
	r = must(t)(r.Join(JoinRequest{WorkspaceId: "c", TargetId: r.Groups[0].Id}))
	if group := onlyGroup(t, r); !slices.Equal(group.Members, []string{"b", "d", "a", "c"}) {
		t.Fatalf("members = %v", group.Members)
	}
}

func TestJoinRefusals(t *testing.T) {
	r := testRail()
	_, err := r.Join(JoinRequest{WorkspaceId: "site", TargetId: "b"})
	if err == nil || err.Error() != "Site belongs to Notulia, declared in its project files. Project groups come first." {
		t.Fatalf("project member: %v", err)
	}
	if _, err := r.Join(JoinRequest{WorkspaceId: "b", TargetId: "app"}); err == nil || !strings.Contains(err.Error(), "App belongs to Notulia") {
		t.Fatalf("project member target: %v", err)
	}
	if _, err := r.Join(JoinRequest{WorkspaceId: "unsaved", TargetId: "b"}); err == nil || !strings.Contains(err.Error(), "unsaved") {
		t.Fatalf("unsaved: %v", err)
	}
	if _, err := r.Join(JoinRequest{WorkspaceId: "b", TargetId: "b"}); err == nil {
		t.Fatalf("itself: no error")
	}
	if _, err := r.Join(JoinRequest{WorkspaceId: "b", TargetId: "nowhere"}); err == nil {
		t.Fatalf("unknown target: no error")
	}
	grouped := must(t)(r.Join(JoinRequest{WorkspaceId: "d", TargetId: "b"}))
	again := must(t)(grouped.Join(JoinRequest{WorkspaceId: "d", TargetId: "b"}))
	if !SameGroups(again.Groups, grouped.Groups) || !slices.Equal(again.Order, grouped.Order) {
		t.Fatalf("joining its own group changed the rail")
	}
}

func TestJoinFromAnotherGroupDissolvesALoneOne(t *testing.T) {
	r := norm(testRail(LocalGroup{Id: "g1", Members: []string{"a", "b"}}, LocalGroup{Id: "g2", Members: []string{"c", "d"}}))
	r = must(t)(r.Join(JoinRequest{WorkspaceId: "c", TargetId: "g1"}))
	if group := onlyGroup(t, r); group.Id != "g1" || !slices.Equal(group.Members, []string{"a", "b", "c"}) {
		t.Fatalf("groups = %+v", r.Groups)
	}
}

func TestLeave(t *testing.T) {
	base := testRail(LocalGroup{Id: "g", Name: "Clients", Members: []string{"a", "b", "c"}})
	r := must(t)(base.Leave(LeaveRequest{WorkspaceId: "a"}))
	if want := []string{"b", "c", "a", "d", "app", "site"}; !slices.Equal(r.Order, want) {
		t.Fatalf("order = %v; want %v (right after the group)", r.Order, want)
	}
	if group := onlyGroup(t, r); !slices.Equal(group.Members, []string{"b", "c"}) || group.Name != "Clients" {
		t.Fatalf("group = %+v", group)
	}
	r = must(t)(base.Leave(LeaveRequest{WorkspaceId: "b", TargetId: "d", Place: PlaceAfter}))
	if want := []string{"a", "c", "d", "b", "app", "site"}; !slices.Equal(r.Order, want) {
		t.Fatalf("order = %v; want %v", r.Order, want)
	}
	r = must(t)(base.Leave(LeaveRequest{WorkspaceId: "c", TargetId: "g", Place: PlaceBefore}))
	if want := []string{"c", "a", "b", "d", "app", "site"}; !slices.Equal(r.Order, want) {
		t.Fatalf("before its own group: %v; want %v", r.Order, want)
	}
	if _, err := base.Leave(LeaveRequest{WorkspaceId: "c", TargetId: "a", Place: PlaceBefore}); err == nil {
		t.Fatalf("a neighbour inside the group: no error")
	}
	if _, err := base.Leave(LeaveRequest{WorkspaceId: "c", TargetId: "site", Place: PlaceBefore}); err == nil {
		t.Fatalf("between two members of a product: no error")
	}
	if _, err := base.Leave(LeaveRequest{WorkspaceId: "d"}); err == nil || !strings.Contains(err.Error(), "D is in no group") {
		t.Fatalf("ungrouped: %v", err)
	}
	pair := testRail(LocalGroup{Id: "g", Name: "Clients", Members: []string{"a", "b"}})
	if r := must(t)(pair.Leave(LeaveRequest{WorkspaceId: "b"})); len(r.Groups) != 0 {
		t.Fatalf("a group of one dissolves: %+v", r.Groups)
	}
}

func TestMoveWithLocalGroups(t *testing.T) {
	base := norm(testRail(LocalGroup{Id: "g", Members: []string{"b", "c"}}))
	cases := []struct {
		name    string
		req     MoveRequest
		order   []string
		members []string
	}{
		{"member within its group", mv("c", "b", PlaceBefore), []string{"a", "c", "b", "d", "app", "site"}, []string{"c", "b"}},
		{"group as a block", block("b", "d", PlaceAfter), []string{"a", "d", "b", "c", "app", "site"}, []string{"b", "c"}},
		{"group named as the neighbour", mv("a", "g", PlaceAfter), []string{"b", "c", "a", "d", "app", "site"}, []string{"b", "c"}},
		{"block past a product", block("c", "site", PlaceAfter), []string{"a", "d", "app", "site", "b", "c"}, []string{"b", "c"}},
		{"member out, after another workspace", mv("b", "d", PlaceAfter), []string{"a", "c", "d", "b", "app", "site"}, nil},
		{"member out, before its own group", mv("c", "g", PlaceBefore), []string{"a", "c", "b", "d", "app", "site"}, nil},
	}
	for _, tc := range cases {
		r := must(t)(base.Move(tc.req))
		if !slices.Equal(r.Order, tc.order) {
			t.Fatalf("%s: order = %v; want %v", tc.name, r.Order, tc.order)
		}
		if tc.members == nil {
			if len(r.Groups) != 0 {
				t.Fatalf("%s: a group of one dissolves: %+v", tc.name, r.Groups)
			}
			continue
		}
		if group := onlyGroup(t, r); !slices.Equal(group.Members, tc.members) {
			t.Fatalf("%s: members = %v; want %v", tc.name, group.Members, tc.members)
		}
	}
	if _, err := base.Move(mv("a", "c", PlaceBefore)); err == nil {
		t.Fatalf("between two members of a local group: no error")
	}
	if _, err := base.Move(mv("app", "d", PlaceAfter)); err == nil {
		t.Fatalf("a project member left its product")
	}
}

func TestNormalizeGroups(t *testing.T) {
	r := testRail(
		LocalGroup{Id: "g", Name: "Clients", Members: []string{"d", "gone", "a", "site"}},
		LocalGroup{Id: "g", Members: []string{"b", "c"}},
		LocalGroup{Id: "h", Members: []string{"a", "b", "c"}},
		LocalGroup{Id: "", Members: []string{"c", "d"}},
	)
	normal, displaced := r.Normalize()
	if len(normal.Groups) != 2 {
		t.Fatalf("groups = %+v", normal.Groups)
	}
	if g := normal.Groups[0]; g.Id != "g" || !slices.Equal(g.Members, []string{"a", "d"}) {
		t.Fatalf("first group = %+v (deleted and project members out, rail order)", g)
	}
	if h := normal.Groups[1]; h.Id != "h" || !slices.Equal(h.Members, []string{"b", "c"}) {
		t.Fatalf("second group = %+v (a workspace stays in its first group)", h)
	}
	if want := []string{"a", "d", "b", "c", "app", "site"}; !slices.Equal(normal.Order, want) {
		t.Fatalf("order = %v; want %v (gathered at the first member)", normal.Order, want)
	}
	if len(displaced) != 1 || displaced[0].WorkspaceId != "site" || displaced[0].ProductName != "Notulia" || displaced[0].GroupName != "Clients" || displaced[0].WorkspaceName != "Site" {
		t.Fatalf("displaced = %+v", displaced)
	}
	lone := testRail(LocalGroup{Id: "g", Members: []string{"d", "app"}})
	normal, displaced = lone.Normalize()
	if len(normal.Groups) != 0 || len(displaced) != 1 || displaced[0].GroupName != "D" {
		t.Fatalf("a group left alone dissolves: %+v, %+v", normal.Groups, displaced)
	}
}

func TestRenameAndUngroup(t *testing.T) {
	r := testRail(LocalGroup{Id: "g", Members: []string{"b", "d"}})
	renamed := must(t)(r.Rename(RenameRequest{GroupId: "g", Name: "  Clients  "}))
	if renamed.Groups[0].Name != "Clients" || renamed.GroupName(renamed.Groups[0]) != "Clients" {
		t.Fatalf("renamed = %+v", renamed.Groups[0])
	}
	reset := must(t)(renamed.Rename(RenameRequest{GroupId: "g", Name: "   "}))
	if reset.Groups[0].Name != "" || reset.GroupName(reset.Groups[0]) != "B" {
		t.Fatalf("an empty name gives back the default: %+v", reset.Groups[0])
	}
	if _, err := r.Rename(RenameRequest{GroupId: "g", Name: strings.Repeat("é", 65)}); err == nil {
		t.Fatalf("65 characters: no error")
	}
	if _, err := r.Rename(RenameRequest{GroupId: "g", Name: strings.Repeat("é", 64)}); err != nil {
		t.Fatalf("64 characters: %v", err)
	}
	if _, err := r.Rename(RenameRequest{GroupId: "x", Name: "x"}); err == nil {
		t.Fatalf("unknown group: no error")
	}
	normal := norm(r)
	ungrouped := must(t)(normal.Ungroup(UngroupRequest{GroupId: "g"}))
	if len(ungrouped.Groups) != 0 || !slices.Equal(ungrouped.Order, normal.Order) {
		t.Fatalf("ungroup: %+v, %v (members stay in place)", ungrouped.Groups, ungrouped.Order)
	}
}

func TestGroupsMetaRoundTrip(t *testing.T) {
	groups := []LocalGroup{{Id: "g", Name: "Clients", Members: []string{"b", "d"}}, {Id: "h", Members: []string{"a", "c"}}}
	got := ReadGroups(waveobj.MetaMapType{GroupsMetaKey: GroupsMetaValue(groups)})
	if !SameGroups(got, groups) {
		t.Fatalf("round trip = %+v", got)
	}
	if got := ReadGroups(waveobj.MetaMapType{GroupsMetaKey: groups}); !SameGroups(got, groups) {
		t.Fatalf("in memory = %+v", got)
	}
	if got := ReadGroups(waveobj.MetaMapType{GroupsMetaKey: "junk"}); got != nil {
		t.Fatalf("junk = %+v", got)
	}
	if _, found := GroupsMetaValue(groups)[1].(map[string]any)["name"]; found {
		t.Fatalf("an unset name is not stored")
	}
}

func TestList(t *testing.T) {
	r := norm(testRail(LocalGroup{Id: "g", Members: []string{"b", "d"}}))
	answer := r.List()
	if len(answer.Workspaces) != 6 || answer.Workspaces[1].Group != "g" || answer.Workspaces[4].Product != "Notulia" {
		t.Fatalf("workspaces = %+v", answer.Workspaces)
	}
	if len(answer.Groups) != 1 || answer.Groups[0].Name != "B" || answer.Groups[0].Renamed {
		t.Fatalf("groups = %+v", answer.Groups)
	}
}

func TestIsTerminalSource(t *testing.T) {
	if !isTerminalSource("proc:1234") {
		t.Fatalf("a local terminal's wsh is a terminal")
	}
	if isTerminalSource("conn:remote") || isTerminalSource("tab:1") || isTerminalSource("") {
		t.Fatalf("only local terminals")
	}
}
