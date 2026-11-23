// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package contexts groups workspaces by activity (FR-SHELL-158, DS-SHELL-157, #2476). A context has a name, a
// description and an emblem (a Lucide icon). The contexts are an ordered list in the client meta "molten:contexts";
// a workspace is in the context its own meta "molten:context" names. A workspace with no id, or one whose context is
// gone, is in the first context, so an installation that never used the feature holds one context with every
// workspace and nothing written: the migration is a read rule. A window has no context of its own: it is the context
// of the workspace it shows. This file holds the pure rules; pkg/wcore/moltenterm_contexts.go reads and writes them.
package contexts

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// must match frontend/moltenterm-shell/contexts/context-model.ts
const (
	ClientMetaKey    = "molten:contexts"
	WorkspaceMetaKey = "molten:context"
	RouteId          = "molten:contexts"

	CreateCommand = "contextcreate"
	UpdateCommand = "contextupdate"
	DeleteCommand = "contextdelete"
	AssignCommand = "contextassign"
	TouchCommand  = "contexttouch"
	ListCommand   = "contextlist"

	// The first context of an installation that stored none: its name is empty and the interface shows its own
	// language's ("My workshop", "Mon atelier").
	DefaultId      = "workshop"
	DefaultEmblem  = "hammer"
	FallbackEmblem = "folder"

	MaxNameRunes        = 60
	MaxDescriptionRunes = 280
	MaxEmblemLength     = 60
)

var emblemPattern = regexp.MustCompile(`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`)

type Context struct {
	Id string `json:"id"`
	// Empty on the default context until the developer renames it: the interface shows its own default name.
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	// A Lucide icon's name, in kebab case ("briefcase").
	Emblem string `json:"emblem,omitempty"`
	// The workspace this context last showed in a window: where choosing the context lands.
	Last string `json:"last,omitempty"`
}

// State is what a write sees: the contexts in order, and the context each workspace is in once the first-context rule
// is applied (every workspace has an entry).
type State struct {
	Contexts []Context
	Of       map[string]string
}

type CreateRequest struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Emblem      string   `json:"emblem,omitempty"`
	Workspaces  []string `json:"workspaces,omitempty"`
}

// UpdateRequest changes the fields it sets. Workspaces, when set, is the whole list of workspaces the context holds
// afterwards: the ones listed move in, the ones that were in and are not listed move to the first other context.
type UpdateRequest struct {
	Id          string    `json:"id"`
	Name        *string   `json:"name,omitempty"`
	Description *string   `json:"description,omitempty"`
	Emblem      *string   `json:"emblem,omitempty"`
	Workspaces  *[]string `json:"workspaces,omitempty"`
}

type DeleteRequest struct {
	Id string `json:"id"`
	// Where its workspaces go; empty: the first context left.
	MoveTo string `json:"moveto,omitempty"`
}

type AssignRequest struct {
	WorkspaceId string `json:"workspaceid"`
	ContextId   string `json:"contextid"`
}

type TouchRequest struct {
	ContextId   string `json:"contextid"`
	WorkspaceId string `json:"workspaceid"`
}

// Default is the context of an installation that stored none.
func Default() Context {
	return Context{Id: DefaultId, Emblem: DefaultEmblem}
}

// ReadContexts reads the stored list; a missing or unreadable value, or one with no usable entry, is the default
// context alone. An entry with no id, or an id seen before, is dropped.
func ReadContexts(meta waveobj.MetaMapType) []Context {
	raw, found := meta[ClientMetaKey]
	if !found || raw == nil {
		return []Context{Default()}
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return []Context{Default()}
	}
	var stored []Context
	if err := json.Unmarshal(data, &stored); err != nil {
		return []Context{Default()}
	}
	rtn := make([]Context, 0, len(stored))
	seen := make(map[string]bool, len(stored))
	for _, c := range stored {
		if c.Id == "" || seen[c.Id] {
			continue
		}
		seen[c.Id] = true
		rtn = append(rtn, c)
	}
	if len(rtn) == 0 {
		return []Context{Default()}
	}
	return rtn
}

// Stored tells whether the client meta holds a list of its own, as opposed to the default one read in its place.
func Stored(meta waveobj.MetaMapType) bool {
	raw, found := meta[ClientMetaKey]
	return found && raw != nil
}

// ContextOf is the id of the context a workspace is in: the one its meta names, else the first context.
func ContextOf(list []Context, workspaceMeta waveobj.MetaMapType) string {
	if id, _ := workspaceMeta[WorkspaceMetaKey].(string); id != "" {
		for _, c := range list {
			if c.Id == id {
				return id
			}
		}
	}
	return list[0].Id
}

// MakeState reads the contexts from the client meta and puts every workspace in one; workspaces maps a workspace id
// to its meta.
func MakeState(clientMeta waveobj.MetaMapType, workspaces map[string]waveobj.MetaMapType) State {
	list := ReadContexts(clientMeta)
	of := make(map[string]string, len(workspaces))
	for id, meta := range workspaces {
		of[id] = ContextOf(list, meta)
	}
	return State{Contexts: list, Of: of}
}

func (s State) clone() State {
	of := make(map[string]string, len(s.Of))
	for id, ctx := range s.Of {
		of[id] = ctx
	}
	return State{Contexts: slices.Clone(s.Contexts), Of: of}
}

func (s State) indexOf(id string) int {
	return slices.IndexFunc(s.Contexts, func(c Context) bool { return c.Id == id })
}

// Members lists a context's workspaces, sorted by id.
func (s State) Members(contextId string) []string {
	rtn := []string{}
	for id, ctx := range s.Of {
		if ctx == contextId {
			rtn = append(rtn, id)
		}
	}
	slices.Sort(rtn)
	return rtn
}

func cleanLine(text string, max int) string {
	text = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, text)
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) > max {
		text = string([]rune(text)[:max])
	}
	return strings.TrimSpace(text)
}

func cleanName(name string) (string, error) {
	rtn := cleanLine(name, MaxNameRunes)
	if rtn == "" {
		return "", fmt.Errorf("a context needs a name")
	}
	return rtn, nil
}

func cleanEmblem(emblem string, allowEmpty bool) (string, error) {
	emblem = strings.TrimSpace(emblem)
	if emblem == "" && allowEmpty {
		return FallbackEmblem, nil
	}
	if len(emblem) > MaxEmblemLength || !emblemPattern.MatchString(emblem) {
		return "", fmt.Errorf("the emblem %q is not an icon name (lower case words joined by hyphens)", emblem)
	}
	return emblem, nil
}

// moveTo puts a workspace in a context and says whether it moved.
func (s *State) moveTo(workspaceId string, contextId string) bool {
	if s.Of[workspaceId] == contextId {
		return false
	}
	if i := s.indexOf(s.Of[workspaceId]); i >= 0 && s.Contexts[i].Last == workspaceId {
		s.Contexts[i].Last = ""
	}
	s.Of[workspaceId] = contextId
	return true
}

func (s State) checkWorkspaces(ids []string) error {
	for _, id := range ids {
		if _, ok := s.Of[id]; !ok {
			return fmt.Errorf("workspace %q does not exist", id)
		}
	}
	return nil
}

// Create adds a context after the others and puts the listed workspaces in it. It returns the state, the workspaces
// that moved (their metas are to be written) and the new context's id.
func (s State) Create(req CreateRequest, id string) (State, []string, error) {
	name, err := cleanName(req.Name)
	if err != nil {
		return s, nil, err
	}
	emblem, err := cleanEmblem(req.Emblem, true)
	if err != nil {
		return s, nil, err
	}
	if id == "" || s.indexOf(id) >= 0 {
		return s, nil, fmt.Errorf("context id %q is empty or taken", id)
	}
	if err := s.checkWorkspaces(req.Workspaces); err != nil {
		return s, nil, err
	}
	rtn := s.clone()
	rtn.Contexts = append(rtn.Contexts, Context{Id: id, Name: name, Description: cleanLine(req.Description, MaxDescriptionRunes), Emblem: emblem})
	moved := []string{}
	for _, ws := range req.Workspaces {
		if rtn.moveTo(ws, id) {
			moved = append(moved, ws)
		}
	}
	return rtn, moved, nil
}

// Update changes a context's fields and, when the request lists workspaces, what it holds.
func (s State) Update(req UpdateRequest) (State, []string, error) {
	at := s.indexOf(req.Id)
	if at < 0 {
		return s, nil, fmt.Errorf("context %q does not exist", req.Id)
	}
	rtn := s.clone()
	if req.Name != nil {
		name, err := cleanName(*req.Name)
		if err != nil {
			return s, nil, err
		}
		rtn.Contexts[at].Name = name
	}
	if req.Description != nil {
		rtn.Contexts[at].Description = cleanLine(*req.Description, MaxDescriptionRunes)
	}
	if req.Emblem != nil {
		emblem, err := cleanEmblem(*req.Emblem, false)
		if err != nil {
			return s, nil, err
		}
		rtn.Contexts[at].Emblem = emblem
	}
	moved := []string{}
	if req.Workspaces != nil {
		listed := *req.Workspaces
		if err := s.checkWorkspaces(listed); err != nil {
			return s, nil, err
		}
		fallback := ""
		for _, c := range s.Contexts {
			if c.Id != req.Id {
				fallback = c.Id
				break
			}
		}
		for _, ws := range s.Members(req.Id) {
			if slices.Contains(listed, ws) {
				continue
			}
			if fallback == "" {
				return s, nil, fmt.Errorf("the only context holds every workspace: make another context first")
			}
			if rtn.moveTo(ws, fallback) {
				moved = append(moved, ws)
			}
		}
		for _, ws := range listed {
			if rtn.moveTo(ws, req.Id) {
				moved = append(moved, ws)
			}
		}
	}
	return rtn, moved, nil
}

// Delete removes a context and moves its workspaces to another. The last context cannot go.
func (s State) Delete(req DeleteRequest) (State, []string, error) {
	at := s.indexOf(req.Id)
	if at < 0 {
		return s, nil, fmt.Errorf("context %q does not exist", req.Id)
	}
	if len(s.Contexts) < 2 {
		return s, nil, fmt.Errorf("the last context cannot be deleted")
	}
	target := req.MoveTo
	if target == "" {
		for _, c := range s.Contexts {
			if c.Id != req.Id {
				target = c.Id
				break
			}
		}
	}
	if target == req.Id || s.indexOf(target) < 0 {
		return s, nil, fmt.Errorf("context %q cannot take the workspaces of %q", target, req.Id)
	}
	rtn := s.clone()
	moved := []string{}
	for _, ws := range s.Members(req.Id) {
		rtn.Of[ws] = target
		moved = append(moved, ws)
	}
	rtn.Contexts = slices.Delete(rtn.Contexts, at, at+1)
	return rtn, moved, nil
}

// Assign puts one workspace in a context (a workspace just made).
func (s State) Assign(req AssignRequest) (State, []string, error) {
	if s.indexOf(req.ContextId) < 0 {
		return s, nil, fmt.Errorf("context %q does not exist", req.ContextId)
	}
	if err := s.checkWorkspaces([]string{req.WorkspaceId}); err != nil {
		return s, nil, err
	}
	rtn := s.clone()
	if !rtn.moveTo(req.WorkspaceId, req.ContextId) {
		return s, nil, nil
	}
	return rtn, []string{req.WorkspaceId}, nil
}

// Touch remembers the workspace a context showed last. A workspace of another context is ignored.
func (s State) Touch(req TouchRequest) (State, error) {
	at := s.indexOf(req.ContextId)
	if at < 0 {
		return s, fmt.Errorf("context %q does not exist", req.ContextId)
	}
	if s.Of[req.WorkspaceId] != req.ContextId || s.Contexts[at].Last == req.WorkspaceId {
		return s, nil
	}
	rtn := s.clone()
	rtn.Contexts[at].Last = req.WorkspaceId
	return rtn, nil
}

// SameContexts tells whether two lists are the same, in the same order.
func SameContexts(a []Context, b []Context) bool {
	return slices.Equal(a, b)
}

// SameIgnoringLast tells whether two lists are the same but for the workspace each context last showed: a window that
// switches workspace changes that and nothing a rail or a switcher draws.
func SameIgnoringLast(a []Context, b []Context) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		x, y := a[i], b[i]
		x.Last, y.Last = "", ""
		if x != y {
			return false
		}
	}
	return true
}

// MetaValue is the list as the client meta stores it.
func MetaValue(list []Context) []any {
	rtn := make([]any, len(list))
	for i, c := range list {
		entry := map[string]any{"id": c.Id}
		if c.Name != "" {
			entry["name"] = c.Name
		}
		if c.Description != "" {
			entry["description"] = c.Description
		}
		if c.Emblem != "" {
			entry["emblem"] = c.Emblem
		}
		if c.Last != "" {
			entry["last"] = c.Last
		}
		rtn[i] = entry
	}
	return rtn
}
