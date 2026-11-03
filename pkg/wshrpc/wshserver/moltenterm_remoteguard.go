// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/molten/metaguard"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// InstallMoltenRemoteGuard makes every request wavesrv answers pass moltenRemoteGuard (NFR-FORK-001 (12), #1831).
func InstallMoltenRemoteGuard() {
	wshutil.MoltenRequestGuard = moltenRemoteGuard
}

// moltenRemoteGuard leaves every caller but an SSH or WSL host's link as is: a window, a local terminal and wavesrv
// itself keep Wave's behaviour.
func moltenRemoteGuard(ctx context.Context, command string, data any) (any, error) {
	handler := wshutil.GetRpcResponseHandlerFromContext(ctx)
	if handler == nil {
		return data, nil
	}
	remote, ok := metaguard.RemoteOf(wshutil.DefaultRouter, handler.GetIngressLinkId())
	if !ok {
		return data, nil
	}
	return moltenCheckRemoteRequest(ctx, remote, command, data)
}

// moltenBlockConn is a block's connection, "" (this computer) when it has none or cannot be read.
func moltenBlockConn(ctx context.Context, blockId string) string {
	if blockId == "" {
		return ""
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil {
		return ""
	}
	return block.Meta.GetString(waveobj.MetaKey_Connection, "")
}

func moltenDecode[T any](data any) (T, error) {
	var rtn T
	if err := utilfn.ReUnmarshal(&rtn, data); err != nil {
		return rtn, fmt.Errorf("invalid request data: %w", err)
	}
	return rtn, nil
}

func moltenCheckRemotePaths(remote metaguard.Remote, paths ...string) error {
	for _, path := range paths {
		if err := metaguard.CheckRemotePath(remote, path); err != nil {
			return err
		}
	}
	return nil
}

func moltenFileDataPath(data wshrpc.FileData) string {
	if data.Info == nil {
		return ""
	}
	return data.Info.Path
}

// moltenCheckRemoteRequest is what an SSH or WSL host's request becomes: refused, rewritten (a block it creates runs
// on its own connection) or unchanged.
func moltenCheckRemoteRequest(ctx context.Context, remote metaguard.Remote, command string, data any) (any, error) {
	if err := metaguard.CheckRemoteCommand(command); err != nil {
		return nil, err
	}
	switch command {
	case "createblock":
		req, err := moltenDecode[wshrpc.CommandCreateBlockData](data)
		if err != nil {
			return nil, err
		}
		if req.BlockDef == nil {
			req.BlockDef = &waveobj.BlockDef{}
		}
		if req.BlockDef.Meta, err = metaguard.RemoteCreateMeta(remote, req.BlockDef.Meta); err != nil {
			return nil, err
		}
		return req, nil
	case "createsubblock":
		req, err := moltenDecode[wshrpc.CommandCreateSubBlockData](data)
		if err != nil {
			return nil, err
		}
		if req.BlockDef == nil {
			req.BlockDef = &waveobj.BlockDef{}
		}
		if req.BlockDef.Meta, err = metaguard.RemoteCreateMeta(remote, req.BlockDef.Meta); err != nil {
			return nil, err
		}
		return req, nil
	case "setmeta":
		req, err := moltenDecode[wshrpc.CommandSetMetaData](data)
		if err != nil {
			return nil, err
		}
		blockConn := ""
		if req.ORef.OType == waveobj.OType_Block {
			blockConn = moltenBlockConn(ctx, req.ORef.OID)
		}
		return data, metaguard.CheckRemoteMetaWrite(remote, req.ORef, blockConn, req.Meta)
	case "controllerresync":
		req, err := moltenDecode[wshrpc.CommandControllerResyncData](data)
		if err != nil {
			return nil, err
		}
		return data, metaguard.CheckRemoteBlock(remote, moltenBlockConn(ctx, req.BlockId), "restart")
	case wshrpc.Command_ControllerInput:
		req, err := moltenDecode[wshrpc.CommandBlockInputData](data)
		if err != nil {
			return nil, err
		}
		return data, metaguard.CheckRemoteBlock(remote, moltenBlockConn(ctx, req.BlockId), "type into")
	case "controllerappendoutput":
		req, err := moltenDecode[wshrpc.CommandControllerAppendOutputData](data)
		if err != nil {
			return nil, err
		}
		return data, metaguard.CheckRemoteBlock(remote, moltenBlockConn(ctx, req.BlockId), "write the output of")
	case "controllerdestroy":
		blockId, err := moltenDecode[string](data)
		if err != nil {
			return nil, err
		}
		return data, metaguard.CheckRemoteBlock(remote, moltenBlockConn(ctx, blockId), "stop")
	case "filecreate", "filemkdir", "fileinfo", "filewrite", "fileread", "fileappend":
		req, err := moltenDecode[wshrpc.FileData](data)
		if err != nil {
			return nil, err
		}
		return data, moltenCheckRemotePaths(remote, moltenFileDataPath(req))
	case "filestream":
		req, err := moltenDecode[wshrpc.CommandFileStreamData](data)
		if err != nil {
			return nil, err
		}
		path := ""
		if req.Info != nil {
			path = req.Info.Path
		}
		return data, moltenCheckRemotePaths(remote, path)
	case "filedelete":
		req, err := moltenDecode[wshrpc.CommandDeleteFileData](data)
		if err != nil {
			return nil, err
		}
		return data, moltenCheckRemotePaths(remote, req.Path)
	case "filelist", "fileliststream":
		req, err := moltenDecode[wshrpc.FileListData](data)
		if err != nil {
			return nil, err
		}
		return data, moltenCheckRemotePaths(remote, req.Path)
	case "filecopy", "filemove":
		req, err := moltenDecode[wshrpc.CommandFileCopyData](data)
		if err != nil {
			return nil, err
		}
		return data, moltenCheckRemotePaths(remote, req.SrcUri, req.DestUri)
	case "filejoin":
		paths, err := moltenDecode[[]string](data)
		if err != nil {
			return nil, err
		}
		if len(paths) == 0 {
			return data, nil
		}
		return data, moltenCheckRemotePaths(remote, paths[0])
	case "path":
		req, err := moltenDecode[wshrpc.PathCommandData](data)
		if err != nil {
			return nil, err
		}
		if req.Open || req.OpenExternal {
			return nil, fmt.Errorf("refused: an SSH or WSL host cannot open MoltenTerm's folders on this computer."+metaguard.RemoteHint)
		}
		return data, nil
	case "connconnect":
		req, err := moltenDecode[wshrpc.ConnRequest](data)
		if err != nil {
			return nil, err
		}
		return data, metaguard.CheckRemoteConn(remote, req.Host, "connect to")
	case "connensure", "connreinstallwsh":
		req, err := moltenDecode[wshrpc.ConnExtData](data)
		if err != nil {
			return nil, err
		}
		return data, metaguard.CheckRemoteConn(remote, req.ConnName, "set up")
	case "conndisconnect":
		connName, err := moltenDecode[string](data)
		if err != nil {
			return nil, err
		}
		return data, metaguard.CheckRemoteConn(remote, connName, "disconnect")
	case "jobcontrollerstartjob":
		req, err := moltenDecode[wshrpc.CommandJobControllerStartJobData](data)
		if err != nil {
			return nil, err
		}
		return data, metaguard.CheckRemoteConn(remote, req.ConnName, "start a job on")
	}
	return data, nil
}
