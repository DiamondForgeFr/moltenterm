// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshserver

import (
	"context"
	"fmt"
	"net/url"

	"github.com/wavetermdev/waveterm/pkg/molten/metaguard"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Variable files have the same zone names as other wave files, including the documented client, tab and workspace
// scopes. Authorizing the zone, rather than reserving filenames, preserves --varfile without an output-file bypass.
func moltenCheckVars(ctx context.Context, data wshrpc.CommandVarData, write bool) error {
	caller := moltenMetaCaller(ctx, true)
	if caller.Trusted {
		return nil
	}
	if remote, ok := moltenRemoteCaller(ctx); ok {
		return moltenCheckRemoteVars(ctx, remote, data, write)
	}
	if caller.Local && data.ZoneId != "" {
		if data.ZoneId == wstore.GetClientId() || data.ZoneId == caller.WorkspaceId {
			return nil
		}
		if moltenInWorkspace(ctx, caller, waveobj.MakeORef(waveobj.OType_Tab, data.ZoneId)) {
			return nil
		}
		return moltenCheckZoneRead(ctx, data.ZoneId)
	}
	return fmt.Errorf("refused: only a verified terminal or the MoltenTerm window can access variable files")
}

func moltenCheckRemoteVars(ctx context.Context, remote metaguard.Remote, data wshrpc.CommandVarData, write bool) error {
	conn := moltenZoneConn(ctx, data.ZoneId)
	if metaguard.CheckRemoteBlock(remote, conn, "access the variables of") == nil {
		return moltenCheckRemoteHop(ctx, remote, conn)
	}
	kind := moltenAskReadVars
	if write {
		kind = moltenAskWriteVars
	}
	// These are logical filestore files, not filesystem paths. Exact grants must never cover a directory or another
	// zone; a variable file may hold credentials or the environment consumed when a local panel restarts.
	target := (&url.URL{Scheme: "wavefile", Host: data.ZoneId, Path: "/" + data.FileName}).String()
	label, text := moltenVarTargetLabel(ctx, data)
	return moltenAskQuestion(ctx, remote, moltenQuestion{Kind: kind, Target: target, TargetLabel: label, TargetText: text, Sensitive: true})
}

func moltenVarTargetLabel(ctx context.Context, data wshrpc.CommandVarData) (string, *uimsg.Text) {
	if data.ZoneId != "" && data.ZoneId == wstore.GetClientId() {
		return fmt.Sprintf("shared variables / %s", data.FileName), uimsg.Make("remoteask.variablesShared", "file", data.FileName)
	}
	if ws, err := wstore.DBGet[*waveobj.Workspace](ctx, data.ZoneId); err == nil && ws != nil {
		name := ws.Name
		if name == "" {
			name = ws.OID
		}
		return fmt.Sprintf("workspace %s / %s", name, data.FileName), uimsg.Make("remoteask.variablesWorkspace", "name", name, "file", data.FileName)
	}
	if tab, err := wstore.DBGet[*waveobj.Tab](ctx, data.ZoneId); err == nil && tab != nil {
		name := tab.Name
		if name == "" {
			name = tab.OID
		}
		return fmt.Sprintf("view %s / %s", name, data.FileName), uimsg.Make("remoteask.variablesTab", "name", name, "file", data.FileName)
	}
	if block, err := wstore.DBGet[*waveobj.Block](ctx, data.ZoneId); err == nil && block != nil {
		name := block.Meta.GetString(waveobj.MetaKey_FrameTitle, block.OID)
		return fmt.Sprintf("panel %s / %s", name, data.FileName), uimsg.Make("remoteask.variablesPanel", "name", name, "file", data.FileName)
	}
	return fmt.Sprintf("variable file %s / %s", data.ZoneId, data.FileName), uimsg.Make("remoteask.variablesFile", "name", data.ZoneId, "file", data.FileName)
}
