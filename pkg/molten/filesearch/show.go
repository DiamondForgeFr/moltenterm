// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package filesearch

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/fileconfine"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	PreviewView = "preview"
	maxHistory  = 20

	AnswerWaiting  = "waiting"
	AnswerApproved = "approved"
	AnswerStayed   = "stayed"
	AnswerClosed   = "closed"

	// An answer request waits this long for the user before it says "waiting"; molten files asks again.
	answerWaitMax  = 20 * time.Second
	answerInterval = 250 * time.Millisecond
)

// Backend is what showing a search needs from wavesrv: its objects, the agents' first names and the settings.
type Backend interface {
	// Block returns nil without an error when the block is gone.
	Block(blockId string) (*waveobj.Block, error)
	TabOfBlock(blockId string) (*waveobj.Tab, error)
	WorkspaceOfTab(tabId string) (*waveobj.Workspace, error)
	SetMeta(blockId string, meta waveobj.MetaMapType) error
	// CreatePanel adds a block with meta to the tab, split to the right of besideBlockId, without taking the focus.
	CreatePanel(tabId string, meta waveobj.MetaMapType, besideBlockId string) (string, error)
	// AgentName: the first name of the agent running in a terminal, "" when none runs.
	AgentName(blockId string) string
	ShowHiddenDefault() bool
}

// ShowRequest: Folder is absolute ("" for the workspace folder); Cwd, the terminal's working directory, is the
// folder of a workspace that has none.
type ShowRequest struct {
	Folder    string `json:"folder,omitempty"`
	Cwd       string `json:"cwd,omitempty"`
	Pattern   string `json:"pattern,omitempty"`
	Recursive bool   `json:"recursive,omitempty"`
}

type ShowResult struct {
	Panel     string  `json:"panel"`
	Created   bool    `json:"created,omitempty"`
	Folder    string  `json:"folder"`
	Pattern   string  `json:"pattern"`
	Recursive bool    `json:"recursive"`
	Matches   []Match `json:"matches"`
	Truncated bool    `json:"truncated"`
	// Asked: the folder is outside the project, the panel asks the user first (FR-FILE-001); wait with AnswerCommand.
	Asked   bool   `json:"asked,omitempty"`
	Project string `json:"project,omitempty"`
}

type AnswerRequest struct {
	Panel  string `json:"panel"`
	Folder string `json:"folder"`
}

type AnswerResult struct {
	State string `json:"state"`
}

// SearchRequest: the file panel's own recursive listing (a window).
type SearchRequest struct {
	Folder     string `json:"folder"`
	Pattern    string `json:"pattern"`
	Recursive  bool   `json:"recursive"`
	ShowHidden bool   `json:"showhidden"`
}

type Service struct {
	B Backend
	// sleep waits between two looks at a panel waiting for the user; tests replace it.
	sleep func(ctx context.Context, d time.Duration) bool
}

func MakeService(b Backend) *Service {
	return &Service{B: b, sleep: sleepCtx}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func isLocalConn(conn string) bool {
	return conn == "" || conn == "local" || strings.HasPrefix(conn, "local:")
}

func isLocalPanel(block *waveobj.Block) bool {
	return block != nil && block.Meta.GetString(waveobj.MetaKey_View, "") == PreviewView &&
		isLocalConn(block.Meta.GetString(waveobj.MetaKey_Connection, ""))
}

func isDir(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(wavebase.ExpandHomeDirSafe(path))
	return err == nil && info.IsDir()
}

func metaNumber(meta waveobj.MetaMapType, key string) float64 {
	switch v := meta[key].(type) {
	case float64:
		return v
	case int64:
		return float64(v)
	case int:
		return float64(v)
	}
	return 0
}

// PickPanel returns the file panel a terminal's `molten files` uses in its tab (AC-1): the one its last run used,
// else the tab's most recently focused panel showing a folder (the first such panel when none was focused yet), else
// nil for a new one. A panel showing a file is not taken over: the developer may be reading or editing it.
func (s *Service) PickPanel(term *waveobj.Block, tab *waveobj.Tab) *waveobj.Block {
	inTab := func(id string) bool {
		for _, blockId := range tab.BlockIds {
			if blockId == id {
				return true
			}
		}
		return false
	}
	if last := term.Meta.GetString(LastPanelMetaKey, ""); last != "" && inTab(last) {
		if block, err := s.B.Block(last); err == nil && isLocalPanel(block) {
			return block
		}
	}
	var best *waveobj.Block
	bestTs := -1.0
	for _, blockId := range tab.BlockIds {
		if blockId == term.OID {
			continue
		}
		block, err := s.B.Block(blockId)
		if err != nil || !isLocalPanel(block) {
			continue
		}
		file := block.Meta.GetString(waveobj.MetaKey_File, "")
		if file != "" && !isDir(file) {
			continue
		}
		if ts := metaNumber(block.Meta, FocusedTsMetaKey); ts > bestTs {
			best, bestTs = block, ts
		}
	}
	return best
}

func (s *Service) showHidden(panel *waveobj.Block) bool {
	if panel != nil {
		if v, ok := panel.Meta[ShowHiddenMetaKey].(bool); ok {
			return v
		}
	}
	return s.B.ShowHiddenDefault()
}

// filterOf: the panel's filter keys as they are, what Stay puts back after a request outside the project.
func filterOf(panel *waveobj.Block) map[string]any {
	rtn := map[string]any{}
	if panel == nil {
		return rtn
	}
	for _, key := range []string{FilterMetaKey, FilterRecursiveMetaKey, FilterDirMetaKey, FilterByMetaKey, FilterByNameMetaKey} {
		if v, ok := panel.Meta[key]; ok && v != nil {
			rtn[key] = v
		}
	}
	return rtn
}

func historyWith(meta waveobj.MetaMapType, cur string) []any {
	var rtn []any
	if list, ok := meta[waveobj.MetaKey_History].([]any); ok {
		rtn = append(rtn, list...)
	}
	rtn = append(rtn, cur)
	if len(rtn) > maxHistory {
		rtn = rtn[len(rtn)-maxHistory:]
	}
	return rtn
}

func resolveFolder(req ShowRequest, ws *waveobj.Workspace) (string, error) {
	folder := req.Folder
	if folder == "" {
		folder = molten.WorkspaceFolder(ws.Meta)
	}
	if folder == "" {
		folder = req.Cwd
	}
	if folder == "" {
		return "", fmt.Errorf("no folder: give one, the workspace has no folder")
	}
	folder = wavebase.ExpandHomeDirSafe(folder)
	if !filepath.IsAbs(folder) {
		return "", fmt.Errorf("the folder %s is not an absolute path", folder)
	}
	folder = filepath.Clean(folder)
	info, err := os.Stat(folder)
	if errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("the folder %s does not exist", folder)
	}
	if err != nil {
		return "", fmt.Errorf("the folder %s cannot be read: %v", folder, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is not a folder", folder)
	}
	return folder, nil
}

// Show opens the search in the file panel of the caller's tab and returns the matches. Nothing is changed when the
// request fails.
func (s *Service) Show(caller localroute.Caller, req ShowRequest) (ShowResult, error) {
	if !caller.IsLocalTerminal || caller.BlockId == "" {
		return ShowResult{}, fmt.Errorf("molten files runs in a MoltenTerm terminal on this computer")
	}
	if err := ValidatePattern(req.Pattern); err != nil {
		return ShowResult{}, err
	}
	if req.Recursive && req.Pattern == "" {
		return ShowResult{}, ErrRecursiveNeedsFilter
	}
	term, err := s.B.Block(caller.BlockId)
	if err != nil || term == nil {
		return ShowResult{}, fmt.Errorf("this terminal's pane was not found")
	}
	tab, err := s.B.TabOfBlock(term.OID)
	if err != nil || tab == nil {
		return ShowResult{}, fmt.Errorf("this terminal's tab was not found")
	}
	ws, err := s.B.WorkspaceOfTab(tab.OID)
	if err != nil || ws == nil {
		return ShowResult{}, fmt.Errorf("this terminal's workspace was not found")
	}
	folder, err := resolveFolder(req, ws)
	if err != nil {
		return ShowResult{}, err
	}
	panel := s.PickPanel(term, tab)
	found, err := Search(folder, req.Pattern, req.Recursive, s.showHidden(panel))
	if err != nil {
		return ShowResult{}, err
	}
	rtn := ShowResult{Folder: folder, Pattern: req.Pattern, Recursive: req.Recursive,
		Matches: found.Matches, Truncated: found.Truncated}
	project := ws.Meta.GetString(molten.ProjectMetaKey, "")
	if project != "" {
		check := fileconfine.Check(folder, project)
		approved := panel != nil && panel.Meta.GetString(fileconfine.ApprovedMetaKey, "") == project
		rtn.Asked = !check.Inside && !approved
		rtn.Project = wavebase.ExpandHomeDirSafe(project)
	}
	meta := FilterMeta(folder, req.Pattern, rtn.Recursive)
	meta[waveobj.MetaKey_File] = folder
	meta[FilterPrevMetaKey] = nil
	if rtn.Asked {
		meta[FilterPrevMetaKey] = filterOf(panel)
	}
	if panel != nil {
		if cur := panel.Meta.GetString(waveobj.MetaKey_File, ""); cur != "" && cur != folder {
			meta[waveobj.MetaKey_History] = historyWith(panel.Meta, cur)
			meta[waveobj.MetaKey_HistoryForward] = []any{}
		}
		meta[waveobj.MetaKey_Edit] = nil
	}
	name := s.B.AgentName(term.OID)
	meta, _ = fileconfine.MetaFromAsker(meta, fileconfine.Asker{FirstName: name})
	meta = FilterMetaFromAsker(meta, false, name)
	if panel != nil {
		if err := s.B.SetMeta(panel.OID, meta); err != nil {
			return ShowResult{}, err
		}
		rtn.Panel = panel.OID
	} else {
		for k, v := range meta {
			if v == nil {
				delete(meta, k)
			}
		}
		meta[waveobj.MetaKey_View] = PreviewView
		id, err := s.B.CreatePanel(tab.OID, meta, term.OID)
		if err != nil {
			return ShowResult{}, err
		}
		rtn.Panel, rtn.Created = id, true
	}
	if term.Meta.GetString(LastPanelMetaKey, "") != rtn.Panel {
		_ = s.B.SetMeta(term.OID, waveobj.MetaMapType{LastPanelMetaKey: rtn.Panel})
	}
	return rtn, nil
}

func (s *Service) answerState(panelId string, folder string, project string) string {
	panel, err := s.B.Block(panelId)
	if err != nil || panel == nil {
		return AnswerClosed
	}
	if panel.Meta.GetString(waveobj.MetaKey_File, "") != folder {
		return AnswerStayed
	}
	if project != "" && panel.Meta.GetString(fileconfine.ApprovedMetaKey, "") == project {
		return AnswerApproved
	}
	return AnswerWaiting
}

// Answer waits for the user's answer to a request outside the project, up to answerWaitMax: approved, stayed (the
// panel went back), closed (the panel is gone), or still waiting.
func (s *Service) Answer(ctx context.Context, caller localroute.Caller, req AnswerRequest) (AnswerResult, error) {
	if !caller.IsLocalTerminal || caller.BlockId == "" {
		return AnswerResult{}, fmt.Errorf("molten files runs in a MoltenTerm terminal on this computer")
	}
	if req.Panel == "" || req.Folder == "" {
		return AnswerResult{}, fmt.Errorf("give the panel and the folder")
	}
	callerTab, err := s.B.TabOfBlock(caller.BlockId)
	if err != nil || callerTab == nil {
		return AnswerResult{}, fmt.Errorf("this terminal's tab was not found")
	}
	panelTab, err := s.B.TabOfBlock(req.Panel)
	if err != nil || panelTab == nil {
		return AnswerResult{State: AnswerClosed}, nil
	}
	if panelTab.OID != callerTab.OID {
		return AnswerResult{}, fmt.Errorf("the file panel is not in this terminal's tab")
	}
	ws, err := s.B.WorkspaceOfTab(panelTab.OID)
	if err != nil || ws == nil {
		return AnswerResult{}, fmt.Errorf("this terminal's workspace was not found")
	}
	project := ws.Meta.GetString(molten.ProjectMetaKey, "")
	deadline := time.Now().Add(answerWaitMax)
	for {
		state := s.answerState(req.Panel, req.Folder, project)
		if state != AnswerWaiting || !time.Now().Before(deadline) {
			return AnswerResult{State: state}, nil
		}
		if !s.sleep(ctx, answerInterval) {
			return AnswerResult{State: AnswerWaiting}, nil
		}
	}
}

// SearchForPanel is the file panel's recursive listing: the same matches as `molten files` gives.
func SearchForPanel(req SearchRequest) (Result, error) {
	folder := wavebase.ExpandHomeDirSafe(req.Folder)
	if !filepath.IsAbs(folder) {
		return Result{}, fmt.Errorf("the folder %s is not an absolute path", req.Folder)
	}
	return Search(filepath.Clean(folder), req.Pattern, req.Recursive, req.ShowHidden)
}
