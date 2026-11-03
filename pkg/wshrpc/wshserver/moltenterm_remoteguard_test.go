// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/metaguard"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

var guardTestHost = metaguard.Remote{Conn: "dev@build.example"}

// asWire is data as the router hands it to the guard: decoded JSON.
func asWire(t *testing.T, data any) any {
	t.Helper()
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	var rtn any
	if err := json.Unmarshal(raw, &rtn); err != nil {
		t.Fatal(err)
	}
	return rtn
}

// #1831: `CreateBlockCommand` of a cmd block with no connection, from an SSH host, ran on this computer. The handler
// gets the block on the host's own connection.
func TestRemoteCreateBlockRunsOnTheHost(t *testing.T) {
	for _, command := range []string{"createblock", "createsubblock"} {
		meta := waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "cmd", waveobj.MetaKey_Cmd: "touch /tmp/pwned"}
		var data any = wshrpc.CommandCreateBlockData{TabId: "tab-1", BlockDef: &waveobj.BlockDef{Meta: meta}}
		if command == "createsubblock" {
			data = wshrpc.CommandCreateSubBlockData{ParentBlockId: "b", BlockDef: &waveobj.BlockDef{Meta: meta}}
		}
		got, err := moltenCheckRemoteRequest(context.Background(), guardTestHost, command, asWire(t, data))
		if err != nil {
			t.Fatalf("%s: %v", command, err)
		}
		var def *waveobj.BlockDef
		switch req := got.(type) {
		case wshrpc.CommandCreateBlockData:
			def = req.BlockDef
		case wshrpc.CommandCreateSubBlockData:
			def = req.BlockDef
		default:
			t.Fatalf("%s: the handler gets %T", command, got)
		}
		if def == nil || def.Meta[waveobj.MetaKey_Connection] != guardTestHost.Conn {
			t.Fatalf("%s: the block runs on %v, not the host's connection", command, def)
		}
		if def.Meta[waveobj.MetaKey_Cmd] != "touch /tmp/pwned" {
			t.Fatalf("%s: the command was changed: %v", command, def.Meta)
		}
	}
	if _, err := moltenCheckRemoteRequest(context.Background(), metaguard.Remote{}, "createblock", asWire(t, wshrpc.CommandCreateBlockData{TabId: "t", BlockDef: &waveobj.BlockDef{Meta: waveobj.MetaMapType{waveobj.MetaKey_Controller: "shell"}}})); err == nil {
		t.Fatal("a host with no known connection opened a local shell")
	}
}

func TestRemoteRequestsThatReachThisComputer(t *testing.T) {
	refused := map[string]any{
		"fileread":              wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "/etc/passwd"}},
		"filewrite":             wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "wsh://local/~/.zshrc"}},
		"filestream":            wshrpc.CommandFileStreamData{Info: &wshrpc.FileInfo{Path: "wsh://local/etc/hosts"}},
		"filecopy":              wshrpc.CommandFileCopyData{SrcUri: "wsh://local/~/.ssh/id_ed25519", DestUri: "wsh://dev@build.example/tmp/k"},
		"filemove":              wshrpc.CommandFileCopyData{SrcUri: "wsh://dev@build.example/tmp/x", DestUri: "wsh://local/~/.zshrc"},
		"filedelete":            wshrpc.CommandDeleteFileData{Path: "wsh://local/~/work"},
		"filelist":              wshrpc.FileListData{Path: "wsh://local/~"},
		"filejoin":              []string{"wsh://local/~", ".ssh"},
		"setconfig":             map[string]any{"term:localshellpath": "/tmp/evil"},
		"startbuilder":          map[string]any{"builderid": "b"},
		"waveaitoolapprove":     map[string]any{"toolcallid": "x"},
		"writetempfile":         map[string]any{"filename": "x"},
		"path":                  wshrpc.PathCommandData{PathType: "config", OpenExternal: true},
		"connconnect":           wshrpc.ConnRequest{Host: "wsl://Ubuntu"},
		"jobcontrollerstartjob": wshrpc.CommandJobControllerStartJobData{ConnName: "local", Cmd: "/bin/sh"},
	}
	for command, data := range refused {
		_, err := moltenCheckRemoteRequest(context.Background(), guardTestHost, command, asWire(t, data))
		if err == nil || !strings.HasPrefix(err.Error(), "refused:") {
			t.Errorf("%s: %v, want a refusal", command, err)
		}
	}
	accepted := map[string]any{
		"fileread":              wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "wsh://dev@build.example/home/dev/notes.txt"}},
		"filecopy":              wshrpc.CommandFileCopyData{SrcUri: "wsh://dev@build.example/tmp/x", DestUri: "wsh://other@host/tmp/x"},
		"path":                  wshrpc.PathCommandData{PathType: "config"},
		"connconnect":           wshrpc.ConnRequest{Host: "other@host"},
		"jobcontrollerstartjob": wshrpc.CommandJobControllerStartJobData{ConnName: "dev@build.example", Cmd: "make"},
		"getmeta":               wshrpc.CommandGetMetaData{ORef: waveobj.MakeORef(waveobj.OType_Tab, "t")},
	}
	for command, data := range accepted {
		if _, err := moltenCheckRemoteRequest(context.Background(), guardTestHost, command, asWire(t, data)); err != nil {
			t.Errorf("%s: %v", command, err)
		}
	}
}
