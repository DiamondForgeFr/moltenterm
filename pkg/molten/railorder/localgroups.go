// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package railorder

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Local rail groups (FR-MC-032, DS-MC-028): groups the user makes of any saved workspaces, kept in the client meta
// "molten:railgroups" beside the rail order and written with it, under the same lock and in the same transaction, so
// membership and order never diverge. They are MoltenTerm's own data: nothing is written in any project (NFR-MC-006).
// The rail draws a local group as a product (FR-MC-027) and orders it as one (FR-MC-031); a project group always wins
// (FR-MC-026): a workspace shown in a project product is never a local member. This file holds the pure rules.

// must match frontend/moltenterm-shell/rail-local-groups.ts and cmd/wsh/cmd/wshcmd-molten-rail.go
const (
	GroupsMetaKey  = "molten:railgroups"
	JoinCommand    = "railgroupjoin"
	LeaveCommand   = "railgroupleave"
	RenameCommand  = "railgrouprename"
	UngroupCommand = "railgroupungroup"
	ListCommand    = "railgrouplist"

	// A local group's unit key, beside the project products' keys (a group name, trimmed and lowercased); also its key
	// in "molten:railcollapsed".
	LocalKeyPrefix   = "local:"
	MaxGroupNameRune = 64
	MinGroupMembers  = 2
)

type LocalGroup struct {
	Id string `json:"id"`
	// Empty: the group is named after its first member, and follows that name.
	Name string `json:"name,omitempty"`
	// Saved workspace ids, in rail order.
	Members []string `json:"members"`
}

type JoinRequest struct {
	WorkspaceId string `json:"workspaceid"`
	// A workspace, or a local group's id.
	TargetId string `json:"targetid"`
}

type LeaveRequest struct {
	WorkspaceId string `json:"workspaceid"`
	// Where it lands: next to this workspace or local group. Without it, right after the group it leaves.
	TargetId string `json:"targetid,omitempty"`
	Place    string `json:"place,omitempty"`
}

type RenameRequest struct {
	GroupId string `json:"groupid"`
	// Trimmed; empty gives the group back its first member's name.
	Name string `json:"name"`
}

type UngroupRequest struct {
	GroupId string `json:"groupid"`
}

// ProductMap is the project products (FR-MC-027) a rail write checks against: workspace id → product key, product key
// → its name. Only products of two members or more.
type ProductMap struct {
	Of    map[string]string
	Names map[string]string
}

// Displaced is a local member that a project product took (FR-MC-032-AC8): it left its local group.
type Displaced struct {
	WorkspaceId   string
	WorkspaceName string
	GroupId       string
	GroupName     string
	ProductName   string
}

// Rail is what a rail write works on: the order, the local groups, and what names and checks need.
type Rail struct {
	Order    []string
	Groups   []LocalGroup
	Products ProductMap
	// Workspace id → name, for the messages and the default group names.
	Names map[string]string
}

// ReadGroups reads the stored local groups; a missing or unreadable value is none. The meta comes back from the
// database as []any of maps, and as []LocalGroup when it was just set in memory.
func ReadGroups(meta waveobj.MetaMapType) []LocalGroup {
	raw, found := meta[GroupsMetaKey]
	if !found || raw == nil {
		return nil
	}
	switch v := raw.(type) {
	case []LocalGroup:
		return cloneGroups(v)
	case []any:
		rtn := make([]LocalGroup, 0, len(v))
		for _, item := range v {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			id, _ := m["id"].(string)
			name, _ := m["name"].(string)
			group := LocalGroup{Id: id, Name: name}
			if members, ok := m["members"].([]any); ok {
				for _, member := range members {
					if wsId, ok := member.(string); ok && wsId != "" {
						group.Members = append(group.Members, wsId)
					}
				}
			}
			rtn = append(rtn, group)
		}
		return rtn
	}
	return nil
}

// GroupsMetaValue is the groups as the client meta stores them.
func GroupsMetaValue(groups []LocalGroup) []any {
	rtn := make([]any, len(groups))
	for i, group := range groups {
		members := make([]any, len(group.Members))
		for j, id := range group.Members {
			members[j] = id
		}
		value := map[string]any{"id": group.Id, "members": members}
		if group.Name != "" {
			value["name"] = group.Name
		}
		rtn[i] = value
	}
	return rtn
}

func cloneGroups(groups []LocalGroup) []LocalGroup {
	rtn := make([]LocalGroup, len(groups))
	for i, group := range groups {
		rtn[i] = LocalGroup{Id: group.Id, Name: group.Name, Members: slices.Clone(group.Members)}
	}
	return rtn
}

// SameGroups tells whether two lists of groups say the same.
func SameGroups(a []LocalGroup, b []LocalGroup) bool {
	return slices.EqualFunc(a, b, func(x LocalGroup, y LocalGroup) bool {
		return x.Id == y.Id && x.Name == y.Name && slices.Equal(x.Members, y.Members)
	})
}

func (r Rail) clone() Rail {
	return Rail{Order: slices.Clone(r.Order), Groups: cloneGroups(r.Groups), Products: r.Products, Names: r.Names}
}

func (r Rail) name(wsId string) string {
	if name := r.Names[wsId]; name != "" {
		return name
	}
	return wsId
}

func (r Rail) productName(key string) string {
	if name := r.Products.Names[key]; name != "" {
		return name
	}
	return key
}

// GroupName is the name the rail shows: the one the user gave, else its first member's.
func (r Rail) GroupName(group LocalGroup) string {
	if group.Name != "" {
		return group.Name
	}
	if len(group.Members) == 0 {
		return ""
	}
	return r.name(group.Members[0])
}

func (r Rail) groupIndex(id string) int {
	if id == "" {
		return -1
	}
	return slices.IndexFunc(r.Groups, func(g LocalGroup) bool { return g.Id == id })
}

func (r Rail) groupOf(wsId string) int {
	return slices.IndexFunc(r.Groups, func(g LocalGroup) bool { return slices.Contains(g.Members, wsId) })
}

// UnitKeys maps each grouped workspace to its unit's key: its project product's, or LocalKeyPrefix + its local group's
// id. MoveGrouped reads local groups through it as it reads products.
func (r Rail) UnitKeys() map[string]string {
	rtn := make(map[string]string, len(r.Products.Of))
	for id, key := range r.Products.Of {
		rtn[id] = key
	}
	for _, group := range r.Groups {
		for _, id := range group.Members {
			if _, taken := rtn[id]; !taken {
				rtn[id] = LocalKeyPrefix + group.Id
			}
		}
	}
	return rtn
}

// refusedProductMember is the message of FR-MC-032-AC8.
func (r Rail) refusedProductMember(wsId string) error {
	return fmt.Errorf("%s belongs to %s, declared in its project files. Project groups come first.", r.name(wsId), r.productName(r.Products.Of[wsId]))
}

// Normalize is run by every write, before and after its change: ids no longer in the order (deleted workspaces) leave
// their group, a member shown in a project product leaves it too (returned as displaced, FR-MC-032-AC8), a workspace
// stays in its first group only, groups below two members dissolve, members follow the rail order, and each group
// is gathered where its first member sits.
func (r Rail) Normalize() (Rail, []Displaced) {
	rtn := r.clone()
	present := make(map[string]int, len(rtn.Order))
	for i, id := range rtn.Order {
		present[id] = i
	}
	seen := map[string]bool{}
	ids := map[string]bool{}
	var displaced []Displaced
	groups := make([]LocalGroup, 0, len(rtn.Groups))
	for _, group := range rtn.Groups {
		if group.Id == "" || ids[group.Id] {
			continue
		}
		ids[group.Id] = true
		name := rtn.GroupName(group)
		members := make([]string, 0, len(group.Members))
		for _, id := range group.Members {
			if _, ok := present[id]; !ok || seen[id] {
				continue
			}
			seen[id] = true
			if key := rtn.Products.Of[id]; key != "" {
				displaced = append(displaced, Displaced{WorkspaceId: id, WorkspaceName: rtn.name(id), GroupId: group.Id, GroupName: name, ProductName: rtn.productName(key)})
				continue
			}
			members = append(members, id)
		}
		if len(members) < MinGroupMembers {
			continue
		}
		slices.SortFunc(members, func(a string, b string) int { return present[a] - present[b] })
		groups = append(groups, LocalGroup{Id: group.Id, Name: group.Name, Members: members})
	}
	rtn.Groups = groups
	rtn.Order = Normalize(rtn.Order, rtn.UnitKeys())
	return rtn, displaced
}

// edgeOf turns a neighbour that is a local group into its first or last member, the side a move lands on.
func (r Rail) edgeOf(targetId string, place string) string {
	gi := r.groupIndex(targetId)
	if gi < 0 {
		return targetId
	}
	members := r.Groups[gi].Members
	if place == PlaceBefore {
		return members[0]
	}
	return members[len(members)-1]
}

func (r Rail) checkSaved(wsId string) error {
	if wsId == "" {
		return fmt.Errorf("name a workspace")
	}
	if !slices.Contains(r.Order, wsId) {
		return fmt.Errorf("workspace %q is not in the rail (an unsaved workspace cannot be grouped)", wsId)
	}
	return nil
}

// Join puts a workspace in the target's local group (FR-MC-032-AC3): an ungrouped target becomes a new group of the
// two at the target's place, the workspace right after it; a target in a local group, or a local group, gains the
// workspace at its end. A workspace leaving another local group for it leaves that one.
func (r Rail) Join(req JoinRequest) (Rail, error) {
	if err := r.checkSaved(req.WorkspaceId); err != nil {
		return r, err
	}
	if r.Products.Of[req.WorkspaceId] != "" {
		return r, r.refusedProductMember(req.WorkspaceId)
	}
	if req.TargetId == "" {
		return r, fmt.Errorf("name the workspace or the group to join")
	}
	if req.TargetId == req.WorkspaceId {
		return r, fmt.Errorf("a workspace cannot be grouped with itself")
	}
	rtn := r.clone()
	target := rtn.groupIndex(req.TargetId)
	if target < 0 {
		if !slices.Contains(rtn.Order, req.TargetId) {
			return r, fmt.Errorf("%q is neither a saved workspace nor a group of the rail", req.TargetId)
		}
		if rtn.Products.Of[req.TargetId] != "" {
			return r, rtn.refusedProductMember(req.TargetId)
		}
		target = rtn.groupOf(req.TargetId)
	}
	if target >= 0 && slices.Contains(rtn.Groups[target].Members, req.WorkspaceId) {
		return r, nil
	}
	if own := rtn.groupOf(req.WorkspaceId); own >= 0 {
		rtn.Groups[own].Members = slices.DeleteFunc(rtn.Groups[own].Members, func(id string) bool { return id == req.WorkspaceId })
	}
	if target < 0 {
		rtn.Groups = append(rtn.Groups, LocalGroup{Id: uuid.NewString(), Members: []string{req.TargetId}})
		target = len(rtn.Groups) - 1
	}
	group := &rtn.Groups[target]
	last := group.Members[len(group.Members)-1]
	for _, id := range group.Members {
		if slices.Index(rtn.Order, id) > slices.Index(rtn.Order, last) {
			last = id
		}
	}
	rtn.Order = slices.DeleteFunc(rtn.Order, func(id string) bool { return id == req.WorkspaceId })
	at := slices.Index(rtn.Order, last) + 1
	rtn.Order = slices.Insert(rtn.Order, at, req.WorkspaceId)
	group.Members = append(group.Members, req.WorkspaceId)
	return rtn, nil
}

// Leave takes a workspace out of its local group (FR-MC-032-AC7): next to the given neighbour, outside the group, or
// right after the group without one.
func (r Rail) Leave(req LeaveRequest) (Rail, error) {
	if err := r.checkSaved(req.WorkspaceId); err != nil {
		return r, err
	}
	own := r.groupOf(req.WorkspaceId)
	if own < 0 {
		return r, fmt.Errorf("%s is in no group", r.name(req.WorkspaceId))
	}
	targetId, place := req.TargetId, req.Place
	if targetId == "" {
		targetId, place = r.Groups[own].Id, PlaceAfter
	}
	if targetId != r.Groups[own].Id && slices.Contains(r.Groups[own].Members, targetId) {
		return r, fmt.Errorf("a workspace leaving its group lands outside it")
	}
	if place != PlaceBefore && place != PlaceAfter {
		return r, fmt.Errorf("unknown place %q: before or after", place)
	}
	targetId = r.edgeOf(targetId, place)
	rtn := r.clone()
	rtn.Groups[own].Members = slices.DeleteFunc(rtn.Groups[own].Members, func(id string) bool { return id == req.WorkspaceId })
	if targetId == req.WorkspaceId {
		return rtn, nil
	}
	order, _, err := MoveGrouped(rtn.Order, rtn.UnitKeys(), MoveRequest{WorkspaceId: req.WorkspaceId, TargetId: targetId, Place: place})
	if err != nil {
		return r, err
	}
	rtn.Order = order
	return rtn, nil
}

// Move is railordermove with the local groups (DS-MC-028): a local group moves as a block and its members within it,
// as a product does, and a neighbour may be named by a local group's id. A local member whose neighbour lies outside
// its group leaves the group there, which a project product's member cannot do.
func (r Rail) Move(req MoveRequest) (Rail, error) {
	if req.Place != PlaceBefore && req.Place != PlaceAfter {
		return r, fmt.Errorf("unknown place %q: before or after", req.Place)
	}
	own := r.groupOf(req.WorkspaceId)
	// Its own group's id as the neighbour is outside it too: right before or after the group.
	if !req.Block && own >= 0 && !slices.Contains(r.Groups[own].Members, req.TargetId) {
		return r.Leave(LeaveRequest{WorkspaceId: req.WorkspaceId, TargetId: req.TargetId, Place: req.Place})
	}
	moved := req
	moved.TargetId = r.edgeOf(req.TargetId, req.Place)
	order, _, err := MoveGrouped(r.Order, r.UnitKeys(), moved)
	if err != nil {
		return r, err
	}
	rtn := r.clone()
	rtn.Order = order
	return rtn, nil
}

// CleanGroupName trims a group name and checks its length; empty means the default name.
func CleanGroupName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > MaxGroupNameRune {
		return "", fmt.Errorf("a group name is at most %d characters", MaxGroupNameRune)
	}
	return name, nil
}

// Rename names a local group (FR-MC-032-AC6); an empty name gives it back its first member's.
func (r Rail) Rename(req RenameRequest) (Rail, error) {
	gi := r.groupIndex(req.GroupId)
	if gi < 0 {
		return r, fmt.Errorf("no group %q in the rail", req.GroupId)
	}
	name, err := CleanGroupName(req.Name)
	if err != nil {
		return r, err
	}
	rtn := r.clone()
	rtn.Groups[gi].Name = name
	return rtn, nil
}

// Ungroup dissolves a local group; its members stay where they are.
func (r Rail) Ungroup(req UngroupRequest) (Rail, error) {
	gi := r.groupIndex(req.GroupId)
	if gi < 0 {
		return r, fmt.Errorf("no group %q in the rail", req.GroupId)
	}
	rtn := r.clone()
	rtn.Groups = slices.Delete(rtn.Groups, gi, gi+1)
	return rtn, nil
}

type ListWorkspace struct {
	Id   string `json:"id"`
	Name string `json:"name"`
	// Its local group's id.
	Group string `json:"group,omitempty"`
	// The project product it is shown in.
	Product string `json:"product,omitempty"`
}

type ListGroup struct {
	Id   string `json:"id"`
	Name string `json:"name"`
	// The user named it; otherwise it follows its first member's name.
	Renamed bool     `json:"renamed,omitempty"`
	Members []string `json:"members"`
}

// ListAnswer is the rail as `molten rail group list` prints it.
type ListAnswer struct {
	Workspaces []ListWorkspace `json:"workspaces"`
	Groups     []ListGroup     `json:"groups"`
}

func (r Rail) List() ListAnswer {
	answer := ListAnswer{Workspaces: []ListWorkspace{}, Groups: []ListGroup{}}
	for _, id := range r.Order {
		ws := ListWorkspace{Id: id, Name: r.Names[id]}
		if gi := r.groupOf(id); gi >= 0 {
			ws.Group = r.Groups[gi].Id
		}
		if key := r.Products.Of[id]; key != "" {
			ws.Product = r.productName(key)
		}
		answer.Workspaces = append(answer.Workspaces, ws)
	}
	for _, group := range r.Groups {
		answer.Groups = append(answer.Groups, ListGroup{Id: group.Id, Name: r.GroupName(group), Renamed: group.Name != "", Members: slices.Clone(group.Members)})
	}
	return answer
}
