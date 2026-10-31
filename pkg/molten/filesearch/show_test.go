// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package filesearch

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/fileconfine"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	termId = "term"
	tabId  = "tab"
	wsId   = "ws"
)

type created struct {
	tab, beside string
	meta        waveobj.MetaMapType
}

type fakeBackend struct {
	lock       sync.Mutex
	blocks     map[string]*waveobj.Block
	tab        *waveobj.Tab
	ws         *waveobj.Workspace
	agent      string
	showHidden bool
	writes     []string
	created    []created
	nextId     int
}

func (f *fakeBackend) Block(blockId string) (*waveobj.Block, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	b := f.blocks[blockId]
	if b == nil {
		return nil, nil
	}
	copied := *b
	copied.Meta = waveobj.MetaMapType{}
	for k, v := range b.Meta {
		copied.Meta[k] = v
	}
	return &copied, nil
}

func (f *fakeBackend) TabOfBlock(blockId string) (*waveobj.Tab, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	for _, id := range f.tab.BlockIds {
		if id == blockId {
			return f.tab, nil
		}
	}
	return nil, fmt.Errorf("no tab for %s", blockId)
}

func (f *fakeBackend) WorkspaceOfTab(tabId string) (*waveobj.Workspace, error) {
	return f.ws, nil
}

func (f *fakeBackend) SetMeta(blockId string, meta waveobj.MetaMapType) error {
	f.lock.Lock()
	defer f.lock.Unlock()
	b := f.blocks[blockId]
	if b == nil {
		return fmt.Errorf("no block %s", blockId)
	}
	for k, v := range meta {
		if v == nil {
			delete(b.Meta, k)
			continue
		}
		b.Meta[k] = v
	}
	f.writes = append(f.writes, blockId)
	return nil
}

func (f *fakeBackend) CreatePanel(tabId string, meta waveobj.MetaMapType, besideBlockId string) (string, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.nextId++
	id := fmt.Sprintf("new%d", f.nextId)
	f.blocks[id] = &waveobj.Block{OID: id, Meta: meta}
	f.tab.BlockIds = append(f.tab.BlockIds, id)
	f.created = append(f.created, created{tab: tabId, beside: besideBlockId, meta: meta})
	return id, nil
}

func (f *fakeBackend) AgentName(blockId string) string {
	return f.agent
}

func (f *fakeBackend) ShowHiddenDefault() bool {
	return f.showHidden
}

func (f *fakeBackend) addPanel(id string, meta waveobj.MetaMapType) {
	f.lock.Lock()
	defer f.lock.Unlock()
	m := waveobj.MetaMapType{waveobj.MetaKey_View: PreviewView}
	for k, v := range meta {
		m[k] = v
	}
	f.blocks[id] = &waveobj.Block{OID: id, Meta: m}
	f.tab.BlockIds = append(f.tab.BlockIds, id)
}

func (f *fakeBackend) meta(id string) waveobj.MetaMapType {
	b, _ := f.Block(id)
	if b == nil {
		return nil
	}
	return b.Meta
}

type fixture struct {
	project string
	outside string
	b       *fakeBackend
	s       *Service
}

func makeFixture(t *testing.T) *fixture {
	t.Helper()
	project := t.TempDir()
	outside := t.TempDir()
	for _, rel := range []string{"src/test-a.ts", "src/b.ts", "src/ui/test-b.tsx", "README.md"} {
		writeFile(t, project, rel)
	}
	writeFile(t, outside, "test-out.txt")
	b := &fakeBackend{
		blocks: map[string]*waveobj.Block{termId: {OID: termId, Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"}}},
		tab:    &waveobj.Tab{OID: tabId, BlockIds: []string{termId}},
		ws:     &waveobj.Workspace{OID: wsId, Meta: waveobj.MetaMapType{molten.ProjectMetaKey: project}},
	}
	return &fixture{project: project, outside: outside, b: b, s: MakeService(b)}
}

var terminal = localroute.Caller{IsLocalTerminal: true, BlockId: termId}

func TestShowOpensANewPanelRightOfTheAgent(t *testing.T) {
	f := makeFixture(t)
	f.b.agent = "Olivia"
	src := filepath.Join(f.project, "src")
	r, err := f.s.Show(terminal, ShowRequest{Folder: src, Pattern: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if !r.Created || len(f.b.created) != 1 || f.b.created[0].beside != termId || f.b.created[0].tab != tabId {
		t.Fatalf("a new panel beside the agent: %+v %+v", r, f.b.created)
	}
	meta := f.b.meta(r.Panel)
	if meta[waveobj.MetaKey_View] != PreviewView || meta[waveobj.MetaKey_File] != src || meta[FilterMetaKey] != "test" ||
		meta[FilterDirMetaKey] != src || meta[FilterByMetaKey] != FilterByAgent || meta[FilterByNameMetaKey] != "Olivia" {
		t.Fatalf("panel meta %v", meta)
	}
	if meta[fileconfine.OriginNameMetaKey] != "Olivia" {
		t.Fatalf("the file meta names the agent for the confinement gate: %v", meta)
	}
	for k, v := range f.b.created[0].meta {
		if v == nil {
			t.Fatalf("a new panel's meta holds no null (%s)", k)
		}
	}
	if got := strings.Join(names(Result{Matches: r.Matches}), ","); got != "test-a.ts" || r.Asked {
		t.Fatalf("matches %q asked %v", got, r.Asked)
	}
	if f.b.meta(termId)[LastPanelMetaKey] != r.Panel {
		t.Fatal("the terminal remembers its panel")
	}
	again, err := f.s.Show(terminal, ShowRequest{Folder: src, Pattern: "*.tsx", Recursive: true})
	if err != nil || again.Panel != r.Panel || again.Created || len(f.b.created) != 1 {
		t.Fatalf("the second run reuses the panel: %+v %v", again, err)
	}
	if got := strings.Join(names(Result{Matches: again.Matches}), ","); got != "ui/test-b.tsx" || f.b.meta(r.Panel)[FilterRecursiveMetaKey] != true {
		t.Fatalf("recursive matches %q", got)
	}
}

func TestPickPanel(t *testing.T) {
	f := makeFixture(t)
	f.b.addPanel("file", waveobj.MetaMapType{waveobj.MetaKey_File: filepath.Join(f.project, "README.md"), FocusedTsMetaKey: 900.0})
	f.b.addPanel("old", waveobj.MetaMapType{waveobj.MetaKey_File: f.project, FocusedTsMetaKey: 100.0})
	f.b.addPanel("recent", waveobj.MetaMapType{waveobj.MetaKey_File: f.project, FocusedTsMetaKey: 500.0})
	f.b.addPanel("remote", waveobj.MetaMapType{waveobj.MetaKey_File: "/", waveobj.MetaKey_Connection: "user@host", FocusedTsMetaKey: 999.0})
	term, _ := f.b.Block(termId)
	if got := f.s.PickPanel(term, f.b.tab); got == nil || got.OID != "recent" {
		t.Fatalf("the most recently focused panel showing a folder: %v", got)
	}
	term.Meta[LastPanelMetaKey] = "old"
	if got := f.s.PickPanel(term, f.b.tab); got == nil || got.OID != "old" {
		t.Fatalf("the panel of the last run first: %v", got)
	}
	term.Meta[LastPanelMetaKey] = "closed"
	if got := f.s.PickPanel(term, f.b.tab); got == nil || got.OID != "recent" {
		t.Fatalf("a closed last panel is skipped: %v", got)
	}
	f2 := makeFixture(t)
	f2.b.addPanel("never", waveobj.MetaMapType{})
	term2, _ := f2.b.Block(termId)
	if got := f2.s.PickPanel(term2, f2.b.tab); got == nil || got.OID != "never" {
		t.Fatalf("a panel never focused is still reused: %v", got)
	}
	f3 := makeFixture(t)
	f3.b.addPanel("file", waveobj.MetaMapType{waveobj.MetaKey_File: filepath.Join(f3.project, "README.md")})
	term3, _ := f3.b.Block(termId)
	if got := f3.s.PickPanel(term3, f3.b.tab); got != nil {
		t.Fatalf("a panel showing a file is not taken over: %v", got)
	}
}

func TestShowFolderResolution(t *testing.T) {
	f := makeFixture(t)
	f.b.addPanel("panel", waveobj.MetaMapType{waveobj.MetaKey_File: f.project, FilterMetaKey: "keep", FilterDirMetaKey: f.project})
	f.b.ws.Meta[molten.WorkspaceFolderMetaKey] = filepath.Join(f.project, "src")
	r, err := f.s.Show(terminal, ShowRequest{Cwd: "/somewhere"})
	if err != nil || r.Folder != filepath.Join(f.project, "src") {
		t.Fatalf("the workspace folder by default: %+v %v", r, err)
	}
	if meta := f.b.meta("panel"); meta[FilterMetaKey] != nil || meta[FilterByMetaKey] != nil {
		t.Fatalf("without a filter the panel's filter is cleared: %v", meta)
	}
	if hist, _ := f.b.meta("panel")[waveobj.MetaKey_History].([]any); len(hist) != 1 || hist[0] != f.project {
		t.Fatalf("Back returns to the folder shown before: %v", hist)
	}
	writes := len(f.b.writes)
	_, err = f.s.Show(terminal, ShowRequest{Folder: filepath.Join(f.project, "missing"), Pattern: "x"})
	if err == nil || !strings.Contains(err.Error(), "does not exist") || len(f.b.writes) != writes {
		t.Fatalf("a missing folder fails and changes nothing: %v", err)
	}
	_, err = f.s.Show(terminal, ShowRequest{Folder: filepath.Join(f.project, "README.md")})
	if err == nil || len(f.b.writes) != writes {
		t.Fatalf("a file is not a folder: %v", err)
	}
	if _, err := f.s.Show(terminal, ShowRequest{Folder: "relative/path"}); err == nil {
		t.Fatal("wavesrv takes absolute folders only")
	}
	delete(f.b.ws.Meta, molten.WorkspaceFolderMetaKey)
	delete(f.b.ws.Meta, molten.ProjectMetaKey)
	r, err = f.s.Show(terminal, ShowRequest{Cwd: f.outside})
	if err != nil || r.Folder != f.outside || r.Asked {
		t.Fatalf("a workspace without a folder uses the terminal's: %+v %v", r, err)
	}
}

func TestShowRefusals(t *testing.T) {
	f := makeFixture(t)
	if _, err := f.s.Show(localroute.Caller{IsWindow: true}, ShowRequest{Folder: f.project}); err == nil {
		t.Fatal("a window does not run molten files")
	}
	if _, err := f.s.Show(terminal, ShowRequest{Folder: f.project, Pattern: "a\x07"}); !errors.Is(err, ErrBadPattern) {
		t.Fatalf("control characters: %v", err)
	}
	if _, err := f.s.Show(terminal, ShowRequest{Folder: f.project, Recursive: true}); !errors.Is(err, ErrRecursiveNeedsFilter) {
		t.Fatalf("recursive without a filter: %v", err)
	}
	if len(f.b.writes) != 0 || len(f.b.created) != 0 {
		t.Fatal("a refused request changes nothing")
	}
}

func TestShowWithoutAgentNamesTheTerminal(t *testing.T) {
	f := makeFixture(t)
	r, err := f.s.Show(terminal, ShowRequest{Folder: f.project, Pattern: "read"})
	if err != nil {
		t.Fatal(err)
	}
	meta := f.b.meta(r.Panel)
	if meta[FilterByMetaKey] != FilterByCommand || meta[FilterByNameMetaKey] != nil {
		t.Fatalf("set by the terminal: %v", meta)
	}
}

func TestShowHiddenFollowsThePanel(t *testing.T) {
	f := makeFixture(t)
	writeFile(t, f.project, ".test-hidden")
	f.b.addPanel("panel", waveobj.MetaMapType{waveobj.MetaKey_File: f.project, ShowHiddenMetaKey: false})
	f.b.showHidden = true
	r, _ := f.s.Show(terminal, ShowRequest{Folder: f.project, Pattern: "test"})
	if len(r.Matches) != 0 {
		t.Fatalf("the panel hides hidden files: %+v", r.Matches)
	}
	f.b.SetMeta("panel", waveobj.MetaMapType{ShowHiddenMetaKey: nil})
	r, _ = f.s.Show(terminal, ShowRequest{Folder: f.project, Pattern: "test"})
	if len(r.Matches) != 1 {
		t.Fatalf("the setting when the panel has no choice: %+v", r.Matches)
	}
}

func TestShowOutsideTheProjectAsks(t *testing.T) {
	f := makeFixture(t)
	f.b.agent = "Olivia"
	f.b.addPanel("panel", waveobj.MetaMapType{waveobj.MetaKey_File: f.project, FilterMetaKey: "mine", FilterDirMetaKey: f.project})
	r, err := f.s.Show(terminal, ShowRequest{Folder: f.outside, Pattern: "test"})
	if err != nil || !r.Asked || r.Panel != "panel" || len(r.Matches) != 1 {
		t.Fatalf("outside the project: %+v %v", r, err)
	}
	meta := f.b.meta("panel")
	prev, _ := meta[FilterPrevMetaKey].(map[string]any)
	if prev[FilterMetaKey] != "mine" || prev[FilterDirMetaKey] != f.project {
		t.Fatalf("Stay puts the previous filter back: %v", meta[FilterPrevMetaKey])
	}
	if meta[fileconfine.OriginMetaKey] != fileconfine.OriginAgent || meta[fileconfine.ApprovedMetaKey] != nil {
		t.Fatalf("the gate sees the agent's request, never an approval: %v", meta)
	}
	f.b.SetMeta("panel", waveobj.MetaMapType{fileconfine.ApprovedMetaKey: f.project})
	r, err = f.s.Show(terminal, ShowRequest{Folder: f.outside, Pattern: "out"})
	if err != nil || r.Asked {
		t.Fatalf("an approved panel does not ask again: %+v %v", r, err)
	}
	if v, ok := f.b.meta("panel")[FilterPrevMetaKey]; ok {
		t.Fatalf("no previous filter kept without a question: %v", v)
	}
}

func TestAnswer(t *testing.T) {
	f := makeFixture(t)
	f.b.addPanel("panel", waveobj.MetaMapType{waveobj.MetaKey_File: f.outside})
	var looks int
	f.s.sleep = func(ctx context.Context, d time.Duration) bool {
		looks++
		if looks == 2 {
			f.b.SetMeta("panel", waveobj.MetaMapType{fileconfine.ApprovedMetaKey: f.project})
		}
		return true
	}
	req := AnswerRequest{Panel: "panel", Folder: f.outside}
	got, err := f.s.Answer(context.Background(), terminal, req)
	if err != nil || got.State != AnswerApproved || looks != 2 {
		t.Fatalf("approved after two looks: %+v %v (%d)", got, err, looks)
	}
	f.b.SetMeta("panel", waveobj.MetaMapType{fileconfine.ApprovedMetaKey: nil, waveobj.MetaKey_File: f.project})
	if got, _ := f.s.Answer(context.Background(), terminal, req); got.State != AnswerStayed {
		t.Fatalf("the panel went back: %+v", got)
	}
	f.s.sleep = func(ctx context.Context, d time.Duration) bool { return false }
	f.b.SetMeta("panel", waveobj.MetaMapType{waveobj.MetaKey_File: f.outside})
	if got, _ := f.s.Answer(context.Background(), terminal, req); got.State != AnswerWaiting {
		t.Fatalf("still waiting when the wait ends: %+v", got)
	}
	if got, _ := f.s.Answer(context.Background(), terminal, AnswerRequest{Panel: "gone", Folder: f.outside}); got.State != AnswerClosed {
		t.Fatalf("a closed panel: %+v", got)
	}
	if _, err := f.s.Answer(context.Background(), localroute.Caller{IsWindow: true}, req); err == nil {
		t.Fatal("only a terminal waits for its request")
	}
}

func TestRoutePolicy(t *testing.T) {
	policy := MakeService(&fakeBackend{}).route().Policy
	for _, command := range []string{ShowCommand, AnswerCommand} {
		if !policy.Admits(command, localroute.Caller{IsLocalTerminal: true}) {
			t.Fatalf("%s: a local terminal", command)
		}
		if policy.Admits(command, localroute.Caller{IsWindow: true}) || policy.Admits(command, localroute.Caller{}) {
			t.Fatalf("%s: only terminals", command)
		}
	}
	if !policy.Admits(SearchCommand, localroute.Caller{IsWindow: true}) || policy.Admits(SearchCommand, localroute.Caller{IsLocalTerminal: true}) {
		t.Fatal("the panel's listing is a window's")
	}
}

func TestHandleSearchForPanel(t *testing.T) {
	f := makeFixture(t)
	rtn, err := f.s.handle(context.Background(), SearchCommand, localroute.Caller{IsWindow: true},
		map[string]any{"folder": f.project, "pattern": "test", "recursive": true})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(names(rtn.(Result)), ","); got != "src/test-a.ts,src/ui/test-b.tsx" {
		t.Fatalf("matches %q", got)
	}
	if _, err := f.s.handle(context.Background(), "other", localroute.Caller{IsWindow: true}, nil); err == nil {
		t.Fatal("unknown command")
	}
}
