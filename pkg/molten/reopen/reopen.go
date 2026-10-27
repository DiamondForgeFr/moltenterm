// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package reopen keeps the panes and tabs closed in each workspace so the last one can come back (Cmd+Shift+T, #512).
// A close is kept as a journal entry (who, what, which, the state it had), the shape the workspace history explored
// in #513 would record, so that history can feed the same stack later; nothing here is a journal yet. The stack lives
// in wavesrv's memory: a closed tab takes its window's renderer with it, and quitting MoltenTerm clears it.
package reopen

import (
	"sort"
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
	// The library's put-away views (FR-SHELL-088): the closed views of every workspace, and one of them back.
	ListCommand     = "moltenreopenlist"
	ReopenIdCommand = "moltenreopenid"

	// How many pane closes each workspace keeps.
	StackSize = 10
	// How many closed views (tabs) each workspace keeps: the library lists them, so pane closes never push them out.
	PutAwaySize = 30

	// ResumeAgentMetaKey: a closed terminal held an agent; the reopened terminal starts it again on its session. The
	// terminal's window types the command once and clears the key (frontend/moltenterm-shell/sidebar/agent-slot.tsx).
	ResumeAgentMetaKey = "molten:reopenagent"

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

// ReopenIdRequest: a closed view the library reopens, in its own workspace.
type ReopenIdRequest struct {
	WorkspaceId string `json:"workspaceid"`
	Id          string `json:"id"`
	TabId       string `json:"tabid,omitempty"`
}

// ResumeAgent is the agent a closed terminal held, and the command line that starts it again on its session.
type ResumeAgent struct {
	Agent   string `json:"agent"`
	Name    string `json:"name,omitempty"`
	Command string `json:"command"`
	// Guessed: the session was not known for sure; the command resumes the agent's last session in the folder.
	Guessed bool `json:"guessed,omitempty"`
}

// PutAway is one closed view as the library lists it. Panels: the meta its panels' names and icons are read from.
type PutAway struct {
	Id          string                `json:"id"`
	At          int64                 `json:"at"`
	WorkspaceId string                `json:"workspaceid"`
	Name        string                `json:"name"`
	Meta        waveobj.MetaMapType   `json:"meta,omitempty"`
	Panels      []waveobj.MetaMapType `json:"panels"`
	Agents      []ResumeAgent         `json:"agents,omitempty"`
}

type ListResult struct {
	Views []PutAway `json:"views"`
}

// The panel meta the library reads a closed view's names and icons from; the rest of the state stays in wavesrv.
var listedPanelKeys = []string{waveobj.MetaKey_View, waveobj.MetaKey_File, waveobj.MetaKey_Url, waveobj.MetaKey_CmdCwd,
	waveobj.MetaKey_Connection, waveobj.MetaKey_FrameTitle, "display:icon"}

// The tab meta the library shows of a closed view.
var listedTabKeys = []string{waveobj.MetaKey_TabFlagColor}

func pickKeys(meta waveobj.MetaMapType, keys []string) waveobj.MetaMapType {
	rtn := waveobj.MetaMapType{}
	for _, k := range keys {
		if v, ok := meta[k]; ok && v != nil {
			rtn[k] = v
		}
	}
	return rtn
}

// ReadResumeAgent reads the agent a closed panel held, from its meta.
func ReadResumeAgent(meta waveobj.MetaMapType) (ResumeAgent, bool) {
	raw, ok := meta[ResumeAgentMetaKey]
	if !ok || raw == nil {
		return ResumeAgent{}, false
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return ResumeAgent{}, false
	}
	a := ResumeAgent{}
	a.Agent, _ = m["agent"].(string)
	a.Name, _ = m["name"].(string)
	a.Command, _ = m["command"].(string)
	a.Guessed, _ = m["guessed"].(bool)
	return a, a.Command != ""
}

// ResumeAgentMeta is the meta value that carries a ResumeAgent into the reopened block.
func ResumeAgentMeta(a ResumeAgent) map[string]any {
	rtn := map[string]any{"agent": a.Agent, "command": a.Command}
	if a.Name != "" {
		rtn["name"] = a.Name
	}
	if a.Guessed {
		rtn["guessed"] = true
	}
	return rtn
}

// Summary is how the library shows a closed view.
func (e Entry) Summary() PutAway {
	rtn := PutAway{Id: e.Id, At: e.At, WorkspaceId: e.Target.WorkspaceId, Name: e.Target.Name, Panels: []waveobj.MetaMapType{}}
	if e.Tab == nil {
		return rtn
	}
	rtn.Meta = pickKeys(e.Tab.Meta, listedTabKeys)
	for _, leaf := range e.Tab.Leaves {
		rtn.Panels = append(rtn.Panels, pickKeys(leaf.Meta, listedPanelKeys))
		if a, ok := ReadResumeAgent(leaf.Meta); ok {
			rtn.Agents = append(rtn.Agents, a)
		}
	}
	return rtn
}

var agentResumeLock sync.Mutex
var agentResume func(blockId string) (ResumeAgent, bool)

// SetAgentResume installs how a terminal's agent is read before it closes; wavesrv sets it once at start, from the
// package that knows the agents (termupdate), which this one cannot import.
func SetAgentResume(fn func(blockId string) (ResumeAgent, bool)) {
	agentResumeLock.Lock()
	defer agentResumeLock.Unlock()
	agentResume = fn
}

func getAgentResume() func(blockId string) (ResumeAgent, bool) {
	agentResumeLock.Lock()
	defer agentResumeLock.Unlock()
	return agentResume
}

// AgentOf reads the agent a terminal runs, with the command that resumes it; false when none runs or none is known.
func AgentOf(blockId string) (ResumeAgent, bool) {
	fn := getAgentResume()
	if fn == nil || blockId == "" {
		return ResumeAgent{}, false
	}
	return fn(blockId)
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

func keepOf(kind string) int {
	if kind == KindTab {
		return PutAwaySize
	}
	return StackSize
}

// Push keeps the workspace's last StackSize pane closes and its last PutAwaySize closed views: the oldest entry of the
// kind just pushed goes.
func (s *Stacks) Push(e Entry) {
	s.lock.Lock()
	defer s.lock.Unlock()
	ws := e.Target.WorkspaceId
	list := append(s.entries[ws], e)
	kind := e.Target.Kind
	count := 0
	for _, x := range list {
		if x.Target.Kind == kind {
			count++
		}
	}
	for i := 0; i < len(list) && count > keepOf(kind); {
		if list[i].Target.Kind != kind {
			i++
			continue
		}
		list = append(list[:i:i], list[i+1:]...)
		count--
	}
	s.entries[ws] = list
}

// PutAway lists the closed views of every workspace, the most recent first.
func (s *Stacks) PutAway() []PutAway {
	s.lock.Lock()
	defer s.lock.Unlock()
	rtn := []PutAway{}
	for _, list := range s.entries {
		for _, e := range list {
			if e.Tab != nil {
				rtn = append(rtn, e.Summary())
			}
		}
	}
	sort.SliceStable(rtn, func(i, j int) bool {
		if rtn[i].At != rtn[j].At {
			return rtn[i].At > rtn[j].At
		}
		return rtn[i].Id < rtn[j].Id
	})
	return rtn
}

// Take removes one entry of a workspace and returns it.
func (s *Stacks) Take(workspaceId string, id string) (Entry, bool) {
	s.lock.Lock()
	defer s.lock.Unlock()
	list := s.entries[workspaceId]
	for i := len(list) - 1; i >= 0; i-- {
		if list[i].Id == id {
			e := list[i]
			s.entries[workspaceId] = append(list[:i:i], list[i+1:]...)
			return e, true
		}
	}
	return Entry{}, false
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
