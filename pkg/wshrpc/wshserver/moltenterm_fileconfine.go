// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/fileconfine"
	"github.com/wavetermdev/waveterm/pkg/molten/filesearch"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// moltenFileAsker reads who sent a request from the link it came in on (#662), never from what the request says: a
// window, or a local terminal and the agent running in it.
func moltenFileAsker(ctx context.Context) fileconfine.Asker {
	handler := wshutil.GetRpcResponseHandlerFromContext(ctx)
	if handler == nil {
		return fileconfine.Asker{}
	}
	caller := localroute.Resolve(wshutil.DefaultRouter, handler.GetSource(), handler.GetIngressLinkId())
	if caller.IsUi() {
		return fileconfine.Asker{IsUi: true}
	}
	if caller.IsLocalTerminal && caller.BlockId != "" {
		if run, ok := attention.AgentRun(caller.BlockId); ok && run.Running {
			return fileconfine.Asker{FirstName: run.FirstName}
		}
	}
	return fileconfine.Asker{}
}

// moltenFileMeta is the meta a block gets from a request (FR-FILE-001): only a window approves a file panel to leave
// its project, and a file meta written from a terminal says who asked, so the panel names it.
// A filter written from a terminal names who set it the same way (FR-FILE-002).
func moltenFileMeta(ctx context.Context, meta waveobj.MetaMapType) waveobj.MetaMapType {
	if !fileconfine.TouchesFileMeta(meta) && !filesearch.TouchesFilterMeta(meta) {
		return meta
	}
	asker := moltenFileAsker(ctx)
	rtn, _ := fileconfine.MetaFromAsker(meta, asker)
	return filesearch.FilterMetaFromAsker(rtn, asker.IsUi, asker.FirstName)
}
