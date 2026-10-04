// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"time"

	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	// The part of a job's output a reattached pane shows: what fits its terminal file, with room for what follows.
	// A terminal block's output file, as blockcontroller.DefaultTermMaxFileSize (blockcontroller starts this package,
	// so it cannot be imported here).
	termFileMaxSize  = 2 * 1024 * 1024
	historyCopyBytes = termFileMaxSize / 2
	// The copy starts mid-stream: ST ends an escape sequence the cut left open, then the colours are reset.
	reattachedNotice = "\x1b\\\x1b[0m\r\n\x1b[90m— reattached by MoltenTerm —\x1b[0m\r\n"
	// The copy starts after a line end found this far into the tail at most.
	lineStartSearch = 4096
)

// liveOps are the actions' changes in wavesrv.
type liveOps struct{}

func (liveOps) TerminateJob(ctx context.Context, jobId string) error {
	return jobcontroller.TerminateJobManager(ctx, jobId)
}

// TerminateAndDetachJob leaves the block alone: the block a replaced session still points at runs another job.
func (liveOps) TerminateAndDetachJob(ctx context.Context, jobId string) error {
	err := jobcontroller.TerminateJobManager(ctx, jobId)
	if detachErr := jobcontroller.DetachJobFromBlock(ctx, jobId, false); detachErr != nil && err == nil {
		err = detachErr
	}
	return err
}

func (liveOps) DeletePane(ctx context.Context, blockId string) error {
	return wcore.DeleteBlock(ctx, blockId, false)
}

func (liveOps) DetachJob(ctx context.Context, jobId string) error {
	return jobcontroller.DetachJobFromBlock(ctx, jobId, false)
}

func (liveOps) CreatePane(ctx context.Context, tabId string, session molten.DurableSession) (string, error) {
	meta := waveobj.MetaMapType{
		waveobj.MetaKey_View:       "term",
		waveobj.MetaKey_Controller: "shell",
	}
	if session.Connection != "" {
		meta[waveobj.MetaKey_Connection] = session.Connection
	}
	if session.Folder != "" {
		meta[waveobj.MetaKey_CmdCwd] = session.Folder
	}
	if session.Worktree != nil && session.Worktree.Path != "" {
		meta[molten.WorktreeMetaKey] = session.Worktree.Path
	}
	block, err := wcore.CreateBlock(ctx, tabId, &waveobj.BlockDef{Meta: meta}, nil)
	if err != nil {
		return "", err
	}
	return block.OID, nil
}

func appendRange(ctx context.Context, jobId string, blockId string, from int64, to int64) error {
	if to <= from {
		return nil
	}
	_, data, err := filestore.WFS.ReadAt(ctx, jobId, jobcontroller.JobOutputFileName, from, to-from)
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return nil
	}
	return filestore.WFS.AppendData(ctx, blockId, wavebase.BlockFile_Term, data)
}

// lineStart moves a copy's start just past the next line end, so it does not begin inside an escape sequence.
func lineStart(ctx context.Context, jobId string, start int64, end int64) int64 {
	_, data, err := filestore.WFS.ReadAt(ctx, jobId, jobcontroller.JobOutputFileName, start, min(lineStartSearch, end-start))
	if err != nil {
		return start
	}
	if idx := bytes.IndexByte(data, '\n'); idx >= 0 {
		return start + int64(idx) + 1
	}
	return start
}

// CopyHistory copies the tail of the job's output, then what came meanwhile, just before the job is attached (from
// then on its output reaches the block too). Bytes that arrive between the second copy and the attach (a few
// milliseconds) are not in the pane: the output loop lives in Wave's job controller, which is not locked for this.
func (liveOps) CopyHistory(ctx context.Context, jobId string, blockId string) error {
	err := filestore.WFS.MakeFile(ctx, blockId, wavebase.BlockFile_Term, nil, wshrpc.FileOpts{MaxSize: termFileMaxSize, Circular: true})
	if err != nil && err != fs.ErrExist {
		return fmt.Errorf("cannot make the pane's terminal file: %w", err)
	}
	file, err := filestore.WFS.Stat(ctx, jobId, jobcontroller.JobOutputFileName)
	if err != nil {
		// A job without output yet: nothing to copy.
		return filestore.WFS.AppendData(ctx, blockId, wavebase.BlockFile_Term, []byte(reattachedNotice))
	}
	end := file.Size
	start := max(end-historyCopyBytes, file.DataStartIdx(), 0)
	if start > 0 {
		start = lineStart(ctx, jobId, start, end)
	}
	if err := appendRange(ctx, jobId, blockId, start, end); err != nil {
		return err
	}
	if again, err := filestore.WFS.Stat(ctx, jobId, jobcontroller.JobOutputFileName); err == nil && again.Size > end {
		if err := appendRange(ctx, jobId, blockId, end, again.Size); err != nil {
			return err
		}
	}
	return filestore.WFS.AppendData(ctx, blockId, wavebase.BlockFile_Term, []byte(reattachedNotice))
}

func (liveOps) AttachJob(ctx context.Context, jobId string, blockId string) error {
	return jobcontroller.AttachJobToBlock(ctx, jobId, blockId)
}

func (liveOps) InsertPane(ctx context.Context, tabId string, blockId string) error {
	err := wcore.QueueLayoutActionForTab(ctx, tabId, waveobj.LayoutActionData{
		ActionType: wcore.LayoutActionDataType_Insert,
		BlockId:    blockId,
		Focused:    true,
	})
	if err != nil {
		return err
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Block, blockId))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Tab, tabId))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_LayoutState, tab.LayoutState))
	return nil
}

func (liveOps) WorkspaceOfTab(ctx context.Context, tabId string) (string, error) {
	wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return "", err
	}
	if wsId == "" {
		return "", fmt.Errorf("tab %s is in no workspace", tabId)
	}
	return wsId, nil
}

func (liveOps) ActiveTab(ctx context.Context, workspaceId string) (string, error) {
	ws, err := wcore.GetWorkspace(ctx, workspaceId)
	if err != nil {
		return "", err
	}
	return ws.ActiveTabId, nil
}

func (liveOps) SetActiveTab(ctx context.Context, workspaceId string, tabId string) error {
	if err := wcore.SetActiveTab(ctx, workspaceId, tabId); err != nil {
		return err
	}
	// A window already showing the workspace is told, or it would keep showing its old tab.
	if windowId, _ := wstore.DBFindWindowForWorkspaceId(ctx, workspaceId); windowId != "" {
		wcore.SendActiveTabUpdate(ctx, workspaceId, tabId)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Workspace, workspaceId))
	return nil
}

func (liveOps) FocusBlock(ctx context.Context, tabId string, blockId string) error {
	oref := waveobj.MakeORef(waveobj.OType_Tab, tabId)
	meta := waveobj.MetaMapType{molten.FocusBlockMetaKey: map[string]any{"blockid": blockId, "ts": time.Now().UnixMilli()}}
	if err := wstore.UpdateObjectMeta(ctx, oref, meta, false); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(oref)
	return nil
}

func (liveOps) ConnectHost(ctx context.Context, connection string) error {
	if conncontroller.IsLocalConnName(connection) {
		return nil
	}
	return conncontroller.EnsureConnection(ctx, connection)
}

func (liveOps) ReconnectJob(ctx context.Context, jobId string) error {
	return jobcontroller.ReconnectJob(ctx, jobId, nil)
}
