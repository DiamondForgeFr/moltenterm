// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/metaguard"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const moltenJobLookupTimeout = 5 * time.Second

// InstallMoltenRemoteGuard makes every request wavesrv answers pass moltenRemoteGuard, and lets the router check a
// host's job routes (NFR-FORK-001 (12), #1831).
func InstallMoltenRemoteGuard() {
	wshutil.MoltenRequestGuard = moltenRemoteGuard
	wshutil.MoltenJobConn = moltenJobConnById
}

// moltenRemoteGuard leaves every caller but an SSH or WSL host's link as is: a window, a local terminal and wavesrv
// itself keep Wave's behaviour.
func moltenRemoteGuard(ctx context.Context, command string, data any) (any, error) {
	remote, ok := moltenRemoteCaller(ctx)
	if !ok {
		return data, nil
	}
	return moltenCheckRemoteRequest(ctx, remote, command, data)
}

func moltenRemoteCaller(ctx context.Context) (metaguard.Remote, bool) {
	handler := wshutil.GetRpcResponseHandlerFromContext(ctx)
	if handler == nil {
		return metaguard.Remote{}, false
	}
	return metaguard.RemoteOf(wshutil.DefaultRouter, handler.GetIngressLinkId())
}

// moltenBlockConn is a block's connection, "" (this computer) when it has none or cannot be read.
var moltenBlockConn = func(ctx context.Context, blockId string) string {
	if blockId == "" {
		return ""
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil {
		return ""
	}
	return block.Meta.GetString(waveobj.MetaKey_Connection, "")
}

// moltenJobConn is a job's connection, false when there is no such job.
var moltenJobConn = func(ctx context.Context, jobId string) (string, bool) {
	if jobId == "" {
		return "", false
	}
	job, err := wstore.DBGet[*waveobj.Job](ctx, jobId)
	if err != nil || job == nil {
		return "", false
	}
	return job.Connection, true
}

func moltenJobConnById(jobId string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), moltenJobLookupTimeout)
	defer cancel()
	return moltenJobConn(ctx, jobId)
}

// moltenZoneConn is the connection of a wave file zone: a block's, or a job's (a durable session's files).
func moltenZoneConn(ctx context.Context, zoneId string) string {
	if conn, ok := moltenJobConn(ctx, zoneId); ok {
		return conn
	}
	return moltenBlockConn(ctx, zoneId)
}

func moltenDecode[T any](data any) (T, error) {
	var rtn T
	if err := utilfn.ReUnmarshal(&rtn, data); err != nil {
		return rtn, fmt.Errorf("invalid request data: %w", err)
	}
	return rtn, nil
}

func moltenFileDataPath(data wshrpc.FileData) string {
	if data.Info == nil {
		return ""
	}
	return data.Info.Path
}

func moltenCheckRemoteJob(ctx context.Context, remote metaguard.Remote, jobId string, what string) error {
	conn, _ := moltenJobConn(ctx, jobId)
	return metaguard.CheckRemoteConn(remote, conn, what)
}

// moltenRemoteBlockDef is the block definition a host's new block gets: a preview of this computer's file the host
// named on purpose (connection local) is asked in the window; any other block meant for this computer runs on the
// host's connection, and a block on another server is bounded by moltenCheckRemoteHop.
func moltenRemoteBlockDef(remote metaguard.Remote, def *waveobj.BlockDef) (*waveobj.BlockDef, error) {
	if def == nil {
		def = &waveobj.BlockDef{}
	}
	meta := def.Meta
	conn, named := meta[waveobj.MetaKey_Connection].(string)
	if named && wshutil.NormConnName(conn) == "local" && meta.GetString(waveobj.MetaKey_View, "") == "preview" && meta.GetString(waveobj.MetaKey_Controller, "") == "" && meta.GetString(waveobj.MetaKey_Cmd, "") == "" {
		kind := moltenAskRead
		if meta.GetBool(waveobj.MetaKey_Edit, false) {
			kind = moltenAskWrite
		}
		if err := moltenAskRemote(remote, kind, meta.GetString(waveobj.MetaKey_File, "")); err != nil {
			return nil, err
		}
		return def, nil
	}
	if err := moltenCheckRemoteHop(remote, conn); err != nil {
		return nil, err
	}
	forced, err := metaguard.RemoteCreateMeta(remote, meta)
	if err != nil {
		return nil, err
	}
	rtn := *def
	rtn.Meta = forced
	return &rtn, nil
}

// moltenCheckRemoteRequest is what an SSH or WSL host's request becomes: refused, asked in the window, rewritten (a
// block it creates for this computer runs on its own connection) or unchanged.
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
		if req.TargetBlockId != "" && req.TargetAction == "replace" {
			if err := metaguard.CheckRemoteBlock(remote, moltenBlockConn(ctx, req.TargetBlockId), "replace"); err != nil {
				return nil, err
			}
		}
		if req.BlockDef, err = moltenRemoteBlockDef(remote, req.BlockDef); err != nil {
			return nil, err
		}
		return req, nil
	case "createsubblock":
		req, err := moltenDecode[wshrpc.CommandCreateSubBlockData](data)
		if err != nil {
			return nil, err
		}
		if req.BlockDef, err = moltenRemoteBlockDef(remote, req.BlockDef); err != nil {
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
		if err := metaguard.CheckRemoteMetaWrite(remote, req.ORef, blockConn, req.Meta); err != nil {
			return nil, err
		}
		if conn, ok := req.Meta[waveobj.MetaKey_Connection].(string); ok {
			return data, moltenCheckRemoteHop(remote, conn)
		}
		return data, nil
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
	case "controllerdestroy", "blockjobstatus":
		blockId, err := moltenDecode[string](data)
		if err != nil {
			return nil, err
		}
		return data, metaguard.CheckRemoteBlock(remote, moltenBlockConn(ctx, blockId), "act on")
	case "deleteblock", "deletesubblock":
		req, err := moltenDecode[wshrpc.CommandDeleteBlockData](data)
		if err != nil {
			return nil, err
		}
		return data, metaguard.CheckRemoteBlock(remote, moltenBlockConn(ctx, req.BlockId), "close")
	case "debugterm":
		req, err := moltenDecode[wshrpc.CommandDebugTermData](data)
		if err != nil {
			return nil, err
		}
		return data, metaguard.CheckRemoteBlock(remote, moltenBlockConn(ctx, req.BlockId), "read the terminal of")
	case "wavefilereadstream":
		req, err := moltenDecode[wshrpc.CommandWaveFileReadStreamData](data)
		if err != nil {
			return nil, err
		}
		return data, metaguard.CheckRemoteBlock(remote, moltenZoneConn(ctx, req.ZoneId), "read the files of")
	case "fetchsuggestions":
		req, err := moltenDecode[wshrpc.FetchSuggestionsData](data)
		if err != nil {
			return nil, err
		}
		if req.SuggestionType != "file" {
			return data, nil
		}
		return data, metaguard.CheckRemoteConn(remote, req.FileConnection, "list the folders of")
	case "fileinfo", "fileread":
		req, err := moltenDecode[wshrpc.FileData](data)
		if err != nil {
			return nil, err
		}
		return data, moltenCheckRemotePath(remote, moltenFileDataPath(req), moltenAskRead)
	case "filecreate", "filemkdir", "filewrite", "fileappend":
		req, err := moltenDecode[wshrpc.FileData](data)
		if err != nil {
			return nil, err
		}
		return data, moltenCheckRemotePath(remote, moltenFileDataPath(req), moltenAskWrite)
	case "filestream":
		req, err := moltenDecode[wshrpc.CommandFileStreamData](data)
		if err != nil {
			return nil, err
		}
		path := ""
		if req.Info != nil {
			path = req.Info.Path
		}
		return data, moltenCheckRemotePath(remote, path, moltenAskRead)
	case "filedelete":
		req, err := moltenDecode[wshrpc.CommandDeleteFileData](data)
		if err != nil {
			return nil, err
		}
		return data, moltenCheckRemotePath(remote, req.Path, moltenAskWrite)
	case "filelist", "fileliststream":
		req, err := moltenDecode[wshrpc.FileListData](data)
		if err != nil {
			return nil, err
		}
		return data, moltenCheckRemotePath(remote, req.Path, moltenAskRead)
	case "filecopy", "filemove":
		req, err := moltenDecode[wshrpc.CommandFileCopyData](data)
		if err != nil {
			return nil, err
		}
		srcKind := moltenAskRead
		if command == "filemove" {
			srcKind = moltenAskWrite
		}
		if err := moltenCheckRemotePath(remote, req.SrcUri, srcKind); err != nil {
			return nil, err
		}
		return data, moltenCheckRemotePath(remote, req.DestUri, moltenAskWrite)
	case "filejoin":
		paths, err := moltenDecode[[]string](data)
		if err != nil {
			return nil, err
		}
		if len(paths) == 0 {
			return data, nil
		}
		return data, moltenCheckRemotePath(remote, paths[0], moltenAskRead)
	case "path":
		req, err := moltenDecode[wshrpc.PathCommandData](data)
		if err != nil {
			return nil, err
		}
		if req.Open || req.OpenExternal {
			return nil, fmt.Errorf("refused: an SSH or WSL host cannot open MoltenTerm's folders on this computer." + metaguard.RemoteHint)
		}
		return data, nil
	case "connconnect":
		req, err := moltenDecode[wshrpc.ConnRequest](data)
		if err != nil {
			return nil, err
		}
		return data, moltenCheckRemoteConnTarget(remote, req.Host, "connect to")
	case "connensure", "connreinstallwsh":
		req, err := moltenDecode[wshrpc.ConnExtData](data)
		if err != nil {
			return nil, err
		}
		return data, moltenCheckRemoteConnTarget(remote, req.ConnName, "set up")
	case "conndisconnect", "jobcontrollerreconnectjobsforconn":
		connName, err := moltenDecode[string](data)
		if err != nil {
			return nil, err
		}
		return data, moltenCheckRemoteConnTarget(remote, connName, "act on")
	case "jobcontrollerstartjob":
		req, err := moltenDecode[wshrpc.CommandJobControllerStartJobData](data)
		if err != nil {
			return nil, err
		}
		return data, moltenCheckRemoteConnTarget(remote, req.ConnName, "start a job on")
	case "jobcontrollerdeletejob", "jobcontrollerexitjob", "jobcontrollerdisconnectjob", "jobcontrollerreconnectjob", "jobcontrollerdetachjob":
		jobId, err := moltenDecode[string](data)
		if err != nil {
			return nil, err
		}
		return data, moltenCheckRemoteJob(ctx, remote, jobId, "act on a job of")
	case "jobcontrollerattachjob":
		req, err := moltenDecode[wshrpc.CommandJobControllerAttachJobData](data)
		if err != nil {
			return nil, err
		}
		if err := moltenCheckRemoteJob(ctx, remote, req.JobId, "attach a job of"); err != nil {
			return nil, err
		}
		return data, metaguard.CheckRemoteBlock(remote, moltenBlockConn(ctx, req.BlockId), "attach a job to")
	}
	return data, nil
}

func moltenCheckRemoteConnTarget(remote metaguard.Remote, conn string, what string) error {
	if err := metaguard.CheckRemoteConn(remote, conn, what); err != nil {
		return err
	}
	return moltenCheckRemoteHop(remote, conn)
}

// moltenListedJobs is the job list a caller gets: an SSH or WSL host sees only the jobs it reaches (its own
// connection's and other servers'), without their environment or job token.
func moltenListedJobs(ctx context.Context, jobs []*waveobj.Job) []*waveobj.Job {
	remote, ok := moltenRemoteCaller(ctx)
	if !ok {
		return jobs
	}
	return moltenListJobsFor(remote, jobs)
}

func moltenListJobsFor(remote metaguard.Remote, jobs []*waveobj.Job) []*waveobj.Job {
	var rtn []*waveobj.Job
	for _, job := range jobs {
		if job == nil || metaguard.CheckRemoteConn(remote, job.Connection, "list") != nil {
			continue
		}
		listed := *job
		listed.CmdEnv = nil
		listed.JobAuthToken = ""
		rtn = append(rtn, &listed)
	}
	return rtn
}

// moltenListedConfig is the configuration a caller gets: an SSH or WSL host gets it without API tokens and SSH key
// paths.
func moltenListedConfig(ctx context.Context, config wconfig.FullConfigType) wconfig.FullConfigType {
	if _, ok := moltenRemoteCaller(ctx); !ok {
		return config
	}
	return metaguard.RemoteListedConfig(config)
}
