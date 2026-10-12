// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package reopen keeps the panes and tabs closed in each workspace so the last one can come back (Cmd+Shift+T, #512).
// A close is kept as a journal entry (who, what, which, the state it had), the shape the workspace history explored
// in #513 would record, so that history can feed the same stack later; nothing here is a journal yet. The stack lives
// in wavesrv's memory: a closed tab takes its window's renderer with it, and quitting MoltenTerm clears it.
package reopen

import (
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	RouteId       = "molten:reopen"
	RecordCommand = "moltenreopenrecord"
	ReopenCommand = "moltenreopenlast"
	// The close recorded did not happen (a confirmation was declined): its entry goes.
	DropCommand = "moltenreopendrop"

	// How many closes each workspace keeps.
	StackSize = 10

	ActorUser   = "user"
	ActionClose = "close"
	KindPane    = "pane"
	KindTab     = "tab"
)

// RecordRequest: a window is about to close a pane (BlockId) or a tab; wavesrv reads their state before they go.
type RecordRequest struct {
	Kind        string `json:"kind"`
	WorkspaceId string `json:"workspaceid"`
	TabId       string `json:"tabid"`
	BlockId     string `json:"blockid,omitempty"`
	// Root: the window's live layout tree of the tab, when it has it (the stored one lags behind a quick series of
	// closes); the stored one is read otherwise.
	Root any `json:"root,omitempty"`
}

// RecordResult names the entry, for a drop if the close does not happen.
type RecordResult struct {
	Id string `json:"id"`
}

type DropRequest struct {
	WorkspaceId string `json:"workspaceid"`
	Id          string `json:"id"`
}

// ReopenRequest: the window's workspace, and the tab it shows (a pane whose tab is gone comes back there).
type ReopenRequest struct {
	WorkspaceId string `json:"workspaceid"`
	TabId       string `json:"tabid"`
}

// ReopenResult says what came back, for the window's toast. Reopened false: nothing to reopen.
type ReopenResult struct {
	Reopened bool   `json:"reopened"`
	Kind     string `json:"kind,omitempty"`
	Name     string `json:"name,omitempty"`
	// FreshShell: a terminal came back with a new shell in its folder (a closed shell cannot be revived).
	FreshShell bool   `json:"freshshell,omitempty"`
	Cwd        string `json:"cwd,omitempty"`
	TabId      string `json:"tabid,omitempty"`
	BlockId    string `json:"blockid,omitempty"`
}

// Target is what was closed.
type Target struct {
	Kind        string `json:"kind"`
	WorkspaceId string `json:"workspaceid"`
	TabId       string `json:"tabid"`
	BlockId     string `json:"blockid,omitempty"`
	Name        string `json:"name"`
}

// Entry is one close, as a journal entry: State holds what it takes to bring the target back.
type Entry struct {
	Id     string `json:"id"`
	At     int64  `json:"at"`
	Actor  string `json:"actor"`
	Action string `json:"action"`
	Target Target `json:"target"`
	Pane   *Pane  `json:"pane,omitempty"`
	Tab    *Tab   `json:"tab,omitempty"`
}

// Pane is a closed pane: its block's meta and where it sat, beside a panel that stays.
type Pane struct {
	Meta waveobj.MetaMapType `json:"meta"`
	molten.PanePlacement
	// IndexArr: its place for an insertatindex action, when it had no single panel beside it (PanePlacement).
	IndexArr []int `json:"indexarr,omitempty"`
}

// Tab is a closed tab: its name, place in the strip, meta and every pane in its layout.
type Tab struct {
	Name   string              `json:"name"`
	Index  int                 `json:"index"`
	Meta   waveobj.MetaMapType `json:"meta,omitempty"`
	Leaves []Leaf              `json:"leaves"`
}

// Leaf is one pane of a closed tab, in the order the tab is rebuilt (see LayoutLeaves): the first pane fills the
// tab, each next one splits an earlier one (Target, its index in the list) on a side.
type Leaf struct {
	Meta    waveobj.MetaMapType `json:"meta"`
	Target  int                 `json:"target"`
	Split   string              `json:"split,omitempty"`
	Focused bool                `json:"focused,omitempty"`
}

// Stacks holds each workspace's closes, most recent last.
type Stacks struct {
	lock    sync.Mutex
	entries map[string][]Entry
	// reopenedAs: a reopened pane is a new block; a pane closed before it, placed beside it, finds it by its old id.
	reopenedAs map[string]string
}

func MakeStacks() *Stacks {
	return &Stacks{entries: map[string][]Entry{}, reopenedAs: map[string]string{}}
}

// Reopened notes the block a closed one came back as.
func (s *Stacks) Reopened(oldId string, newId string) {
	if oldId == "" || newId == "" {
		return
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	s.reopenedAs[oldId] = newId
}

// CurrentId is the block a closed one is now, after its reopens (itself when it never came back).
func (s *Stacks) CurrentId(id string) string {
	s.lock.Lock()
	defer s.lock.Unlock()
	for i := 0; i < StackSize*4; i++ {
		next, ok := s.reopenedAs[id]
		if !ok {
			return id
		}
		id = next
	}
	return id
}

func (s *Stacks) Push(e Entry) {
	s.lock.Lock()
	defer s.lock.Unlock()
	ws := e.Target.WorkspaceId
	list := append(s.entries[ws], e)
	if len(list) > StackSize {
		list = list[len(list)-StackSize:]
	}
	s.entries[ws] = list
}

// Pop takes the most recent close of a workspace.
func (s *Stacks) Pop(workspaceId string) (Entry, bool) {
	s.lock.Lock()
	defer s.lock.Unlock()
	list := s.entries[workspaceId]
	if len(list) == 0 {
		return Entry{}, false
	}
	e := list[len(list)-1]
	s.entries[workspaceId] = list[:len(list)-1]
	return e, true
}

// Drop removes one entry of a workspace.
func (s *Stacks) Drop(workspaceId string, id string) bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	list := s.entries[workspaceId]
	for i := len(list) - 1; i >= 0; i-- {
		if list[i].Id == id {
			s.entries[workspaceId] = append(list[:i:i], list[i+1:]...)
			return true
		}
	}
	return false
}

// PushBack returns an entry that could not be reopened, so a second try finds it.
func (s *Stacks) PushBack(e Entry) {
	s.Push(e)
}

func (s *Stacks) Len(workspaceId string) int {
	s.lock.Lock()
	defer s.lock.Unlock()
	return len(s.entries[workspaceId])
}

// The block meta a reopened pane does not take back: requests a panel had not handled yet, and notices about the
// moment it closed.
var transientMetaPrefixes = []string{
	molten.BrowserOpenKeyPrefix,
	molten.BrowserCloseKeyPrefix,
}

var transientMetaKeys = map[string]bool{
	molten.BrowserAskMetaKey:       true,
	molten.BrowserKeepFocusMetaKey: true,
	"molten:browser:notice":        true,
}

// CleanMeta copies a block's meta without its transient keys.
func CleanMeta(meta waveobj.MetaMapType) waveobj.MetaMapType {
	rtn := waveobj.MetaMapType{}
	for k, v := range meta {
		if transientMetaKeys[k] || v == nil {
			continue
		}
		skip := false
		for _, p := range transientMetaPrefixes {
			if strings.HasPrefix(k, p) {
				skip = true
				break
			}
		}
		if !skip {
			rtn[k] = v
		}
	}
	return rtn
}

// The names of the other panel kinds, as frontend/moltenterm-shell/command-panel/panel-context.ts names them.
var viewNames = map[string]string{
	"sysinfo":          "the system info",
	"cpuplot":          "the system info",
	"processviewer":    "the process view",
	"help":             "the help",
	"tsunami":          "the app",
	"molten-companion": "the companion",
	"molten-linemap":   "the line map",
	"molten-cicd":      "the CI/CD view",
	"molten-project":   "the Project view",
	"molten-timeline":  "the Project view",
	"molten-sessions":  "Sessions",
}

// PaneName is how the toast names a pane: its title, else its kind, with the folder of a terminal.
func PaneName(meta waveobj.MetaMapType) string {
	if title := meta.GetString(waveobj.MetaKey_FrameTitle, ""); title != "" {
		return title
	}
	switch meta.GetString(waveobj.MetaKey_View, "") {
	case "term":
		return "the terminal"
	case molten.BrowserView, molten.LegacyWebView:
		return "the browser"
	case "preview":
		if file := meta.GetString(waveobj.MetaKey_File, ""); file != "" {
			return lastPathPart(file)
		}
		return "the file view"
	case "":
		return "the pane"
	}
	if name, ok := viewNames[meta.GetString(waveobj.MetaKey_View, "")]; ok {
		return name
	}
	return "the " + meta.GetString(waveobj.MetaKey_View, "pane")
}

func lastPathPart(path string) string {
	path = strings.TrimRight(path, "/")
	if i := strings.LastIndex(path, "/"); i >= 0 && i < len(path)-1 {
		return path[i+1:]
	}
	return path
}
