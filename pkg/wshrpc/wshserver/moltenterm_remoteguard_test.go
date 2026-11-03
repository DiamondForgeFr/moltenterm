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
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const guardTestConn = "dev@build.example"

var guardTestHost = metaguard.Remote{Conn: guardTestConn}

const (
	ownBlock    = "11111111-1111-4111-8111-111111111111"
	serverBlock = "22222222-2222-4222-8222-222222222222"
	localBlock  = "33333333-3333-4333-8333-333333333333"
)

type promptCall struct {
	server string
	kind   string
	target string
}

// guardFixture replaces the window's question, the known connections and the block and job lookups.
type guardFixture struct {
	prompts []promptCall
	allow   bool
	always  bool
}

func setupGuard(t *testing.T) *guardFixture {
	t.Helper()
	f := &guardFixture{}
	savedPrompt, savedKnown, savedBlock, savedJob := moltenRemotePrompt, moltenKnownConnFn, moltenBlockConn, moltenJobConn
	t.Cleanup(func() {
		moltenRemotePrompt, moltenKnownConnFn, moltenBlockConn, moltenJobConn = savedPrompt, savedKnown, savedBlock, savedJob
		moltenAskGrantsLock.Lock()
		defer moltenAskGrantsLock.Unlock()
		moltenAskGrants = map[moltenAskGrant]bool{}
	})
	moltenRemotePrompt = func(server string, kind string, target string) (bool, bool) {
		f.prompts = append(f.prompts, promptCall{server, kind, target})
		return f.allow, f.allow && f.always
	}
	moltenKnownConnFn = func(conn string) bool { return conn == "known@server" }
	blocks := map[string]string{ownBlock: guardTestConn, serverBlock: "known@server", localBlock: ""}
	moltenBlockConn = func(_ context.Context, blockId string) string { return blocks[blockId] }
	jobs := map[string]string{"own-job": guardTestConn + ":22", "local-job": "local"}
	moltenJobConn = func(_ context.Context, jobId string) (string, bool) {
		conn, ok := jobs[jobId]
		return conn, ok
	}
	return f
}

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

func guardAsk(t *testing.T, command string, data any) (any, error) {
	t.Helper()
	return moltenCheckRemoteRequest(context.Background(), guardTestHost, command, asWire(t, data))
}

func mustGuardRefuse(t *testing.T, name string, err error) {
	t.Helper()
	if err == nil || !strings.HasPrefix(err.Error(), "refused:") || !strings.HasSuffix(err.Error(), metaguard.RemoteHint) {
		t.Errorf("%s: %v, want a refusal that says why and where to do it", name, err)
	}
}

func createdMeta(t *testing.T, got any) waveobj.MetaMapType {
	t.Helper()
	switch req := got.(type) {
	case wshrpc.CommandCreateBlockData:
		return req.BlockDef.Meta
	case wshrpc.CommandCreateSubBlockData:
		return req.BlockDef.Meta
	}
	t.Fatalf("the handler gets %T", got)
	return nil
}

// #1831: `CreateBlockCommand` of a cmd block with no connection, from an SSH host, ran on this computer. The handler
// gets the block on the host's own connection, whatever its view (a terminal, a preview, a sysinfo panel).
func TestRemoteCreateBlockRunsOnTheHost(t *testing.T) {
	setupGuard(t)
	for _, meta := range []waveobj.MetaMapType{
		{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "cmd", waveobj.MetaKey_Cmd: "touch /tmp/pwned"},
		{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "shell", waveobj.MetaKey_Connection: "local"},
		{waveobj.MetaKey_View: "preview", waveobj.MetaKey_File: "/home/dev/notes.txt"},
		{waveobj.MetaKey_View: "sysinfo"},
	} {
		for _, command := range []string{"createblock", "createsubblock"} {
			var data any = wshrpc.CommandCreateBlockData{TabId: "tab-1", BlockDef: &waveobj.BlockDef{Meta: meta}}
			if command == "createsubblock" {
				data = wshrpc.CommandCreateSubBlockData{ParentBlockId: "b", BlockDef: &waveobj.BlockDef{Meta: meta}}
			}
			got, err := guardAsk(t, command, data)
			if err != nil {
				t.Fatalf("%s %v: %v", command, meta, err)
			}
			created := createdMeta(t, got)
			if created[waveobj.MetaKey_Connection] != guardTestConn {
				t.Fatalf("%s %v: the block runs on %v, not the host's connection", command, meta, created[waveobj.MetaKey_Connection])
			}
			if created[waveobj.MetaKey_Cmd] != meta[waveobj.MetaKey_Cmd] {
				t.Fatalf("%s: the command was changed: %v", command, created)
			}
		}
	}
	_, err := moltenCheckRemoteRequest(context.Background(), metaguard.Remote{}, "createblock", asWire(t, wshrpc.CommandCreateBlockData{TabId: "t", BlockDef: &waveobj.BlockDef{Meta: waveobj.MetaMapType{waveobj.MetaKey_Controller: "shell"}}}))
	mustGuardRefuse(t, "a host with no known connection opens a local shell", err)
	_, err = guardAsk(t, "createblock", wshrpc.CommandCreateBlockData{TabId: "t", TargetBlockId: localBlock, TargetAction: "replace", BlockDef: &waveobj.BlockDef{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"}}})
	mustGuardRefuse(t, "replace a local panel", err)
	if _, err = guardAsk(t, "createblock", wshrpc.CommandCreateBlockData{TabId: "t", TargetBlockId: ownBlock, TargetAction: "replace", BlockDef: &waveobj.BlockDef{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"}}}); err != nil {
		t.Errorf("replace its own panel: %v", err)
	}
}

// A preview of this computer's file the host names on purpose, and a file of this computer in wsh file, are asked
// in the window, never refused flat; "always" holds for that server and kind.
func TestRemoteLocalFilesAreAsked(t *testing.T) {
	f := setupGuard(t)
	preview := wshrpc.CommandCreateBlockData{TabId: "t", BlockDef: &waveobj.BlockDef{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "preview", waveobj.MetaKey_File: "/Users/me/report.md", waveobj.MetaKey_Connection: "local"}}}
	_, err := guardAsk(t, "createblock", preview)
	mustGuardRefuse(t, "denied local preview", err)
	if len(f.prompts) != 1 || f.prompts[0] != (promptCall{guardTestConn, moltenAskRead, "/Users/me/report.md"}) {
		t.Fatalf("asked %+v", f.prompts)
	}
	f.allow = true
	got, err := guardAsk(t, "createblock", preview)
	if err != nil || createdMeta(t, got)[waveobj.MetaKey_Connection] != "local" {
		t.Fatalf("allowed local preview: %v %v", got, err)
	}
	copyDown := wshrpc.CommandFileCopyData{SrcUri: "wsh://dev@build.example/tmp/build.log", DestUri: "wsh://local/~/Downloads/build.log"}
	f.always = true
	if _, err := guardAsk(t, "filecopy", copyDown); err != nil {
		t.Fatalf("copy to this computer, allowed always: %v", err)
	}
	if last := f.prompts[len(f.prompts)-1]; last != (promptCall{guardTestConn, moltenAskWrite, "~/Downloads/build.log"}) {
		t.Fatalf("asked %+v", last)
	}
	asked := len(f.prompts)
	f.allow = false
	if _, err := guardAsk(t, "filewrite", wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "wsh://local/~/Downloads/other.log"}}); err != nil {
		t.Fatalf("a write after always: %v", err)
	}
	if len(f.prompts) != asked {
		t.Fatal("always did not hold for this server")
	}
	_, err = guardAsk(t, "fileread", wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "/etc/passwd"}})
	mustGuardRefuse(t, "a read is another kind", err)
	if last := f.prompts[len(f.prompts)-1]; last.kind != moltenAskRead || last.target != "/etc/passwd" {
		t.Fatalf("a bare path names this computer: asked %+v", last)
	}
	other := metaguard.Remote{Conn: "other@host"}
	f.allow = false
	_, err = moltenCheckRemoteRequest(context.Background(), other, "filewrite", asWire(t, wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "wsh://local/~/x"}}))
	mustGuardRefuse(t, "always holds for one server only", err)
}

func TestRemoteRequestsThatReachThisComputer(t *testing.T) {
	setupGuard(t)
	refused := map[string]any{
		"filecopy":                          wshrpc.CommandFileCopyData{SrcUri: "wsh://wsl://Ubuntu/etc/shadow", DestUri: "wsh://dev@build.example/tmp/k"},
		"setconfig":                         map[string]any{"term:localshellpath": "/tmp/evil"},
		"startbuilder":                      map[string]any{"builderid": "b"},
		"waveaitoolapprove":                 map[string]any{"toolcallid": "x"},
		"getwaveaichat":                     map[string]any{"chatid": "x"},
		"waveaigettooldiff":                 map[string]any{"chatid": "x"},
		"writetempfile":                     map[string]any{"filename": "x"},
		"path":                              wshrpc.PathCommandData{PathType: "config", OpenExternal: true},
		"connconnect":                       wshrpc.ConnRequest{Host: "wsl://Ubuntu"},
		"jobcontrollerstartjob":             wshrpc.CommandJobControllerStartJobData{ConnName: "local", Cmd: "/bin/sh"},
		"jobcontrollerdeletejob":            "local-job",
		"jobcontrollerexitjob":              "local-job",
		"jobcontrollerdisconnectjob":        "local-job",
		"jobcontrollerreconnectjob":         "local-job",
		"jobcontrollerdetachjob":            "unknown-job",
		"jobcontrollerattachjob":            wshrpc.CommandJobControllerAttachJobData{JobId: "own-job", BlockId: localBlock},
		"jobcontrollerreconnectjobsforconn": "local",
		"deleteblock":                       wshrpc.CommandDeleteBlockData{BlockId: localBlock},
		"controllerdestroy":                 localBlock,
		"controllerinput":                   wshrpc.CommandBlockInputData{BlockId: localBlock, InputData64: "aWQK"},
		"controllerresync":                  wshrpc.CommandControllerResyncData{BlockId: localBlock, ForceRestart: true},
		"debugterm":                         wshrpc.CommandDebugTermData{BlockId: localBlock},
		"wavefilereadstream":                wshrpc.CommandWaveFileReadStreamData{ZoneId: "local-job", Name: "term"},
		"fetchsuggestions":                  wshrpc.FetchSuggestionsData{SuggestionType: "file", FileCwd: "~/.ssh"},
		"setmeta":                           wshrpc.CommandSetMetaData{ORef: waveobj.MakeORef(waveobj.OType_Block, ownBlock), Meta: waveobj.MetaMapType{waveobj.MetaKey_Connection: "dev@localhost"}},
	}
	for command, data := range refused {
		_, err := guardAsk(t, command, data)
		mustGuardRefuse(t, command, err)
	}
	accepted := map[string]any{
		"fileread":               wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "wsh://dev@build.example/home/dev/notes.txt"}},
		"filecopy":               wshrpc.CommandFileCopyData{SrcUri: "wsh://dev@build.example/tmp/x", DestUri: "wsh://known@server/tmp/x"},
		"path":                   wshrpc.PathCommandData{PathType: "config"},
		"connconnect":            wshrpc.ConnRequest{Host: "known@server"},
		"jobcontrollerstartjob":  wshrpc.CommandJobControllerStartJobData{ConnName: guardTestConn, Cmd: "make"},
		"jobcontrollerdeletejob": "own-job",
		"jobcontrollerattachjob": wshrpc.CommandJobControllerAttachJobData{JobId: "own-job", BlockId: ownBlock},
		"controllerinput":        wshrpc.CommandBlockInputData{BlockId: serverBlock, InputData64: "aWQK"},
		"deleteblock":            wshrpc.CommandDeleteBlockData{BlockId: ownBlock},
		"wavefilereadstream":     wshrpc.CommandWaveFileReadStreamData{ZoneId: "own-job", Name: "term"},
		"fetchsuggestions":       wshrpc.FetchSuggestionsData{SuggestionType: "file", FileConnection: guardTestConn},
		"getmeta":                wshrpc.CommandGetMetaData{ORef: waveobj.MakeORef(waveobj.OType_Tab, "t")},
		"setmeta":                wshrpc.CommandSetMetaData{ORef: waveobj.MakeORef(waveobj.OType_Block, ownBlock), Meta: waveobj.MetaMapType{waveobj.MetaKey_Connection: "known@server"}},
	}
	for command, data := range accepted {
		if _, err := guardAsk(t, command, data); err != nil {
			t.Errorf("%s: %v", command, err)
		}
	}
}

// A host makes this computer connect to another server only for a known connection, or after the window's
// confirmation; never to this computer's own SSH server.
func TestRemoteHopToAnotherServer(t *testing.T) {
	f := setupGuard(t)
	for _, host := range []string{"me@localhost", "127.0.0.1", "root@127.0.0.2:2222", "[::1]:22", "me@LOCALHOST."} {
		_, err := guardAsk(t, "connconnect", wshrpc.ConnRequest{Host: host})
		mustGuardRefuse(t, "loopback "+host, err)
	}
	if len(f.prompts) != 0 {
		t.Fatalf("a loopback address was asked: %+v", f.prompts)
	}
	_, err := guardAsk(t, "connconnect", wshrpc.ConnRequest{Host: "new@server"})
	mustGuardRefuse(t, "an unknown server, denied", err)
	if len(f.prompts) != 1 || f.prompts[0] != (promptCall{guardTestConn, moltenAskConnect, "new@server"}) {
		t.Fatalf("asked %+v", f.prompts)
	}
	f.allow = true
	if _, err := guardAsk(t, "createblock", wshrpc.CommandCreateBlockData{TabId: "t", BlockDef: &waveobj.BlockDef{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "shell", waveobj.MetaKey_Connection: "new@server"}}}); err != nil {
		t.Fatalf("wsh ssh -n to an allowed server: %v", err)
	}
}

func TestRemoteListedJobsAndConfig(t *testing.T) {
	jobs := []*waveobj.Job{
		{OID: "own", Connection: guardTestConn, CmdEnv: map[string]string{"TOKEN": "x"}, JobAuthToken: "secret"},
		{OID: "local", Connection: "local", CmdEnv: map[string]string{"WAVETERM_JWT": "y"}, JobAuthToken: "secret"},
	}
	listed := moltenListJobsFor(guardTestHost, jobs)
	if len(listed) != 1 || listed[0].OID != "own" || listed[0].CmdEnv != nil || listed[0].JobAuthToken != "" {
		t.Fatalf("listed %+v", listed)
	}
	if jobs[0].JobAuthToken != "secret" {
		t.Fatal("the stored job was changed")
	}
	config := wconfig.FullConfigType{
		WaveAIModes: map[string]wconfig.AIModeConfigType{"m": {APIToken: "sk-1"}},
		Connections: map[string]wconfig.ConnKeywords{"c": {SshIdentityFile: []string{"~/.ssh/id_ed25519"}}},
		Presets:     map[string]waveobj.MetaMapType{"p": {"ai:apitoken": "sk-2", "bg": "red"}},
	}
	config.Settings.AiApiToken = "sk-3"
	got := metaguard.RemoteListedConfig(config)
	if got.WaveAIModes["m"].APIToken != "" || got.Connections["c"].SshIdentityFile != nil || got.Presets["p"]["ai:apitoken"] != nil || got.Settings.AiApiToken != "" || got.Presets["p"]["bg"] != "red" {
		t.Fatalf("listed config %+v", got)
	}
	if config.WaveAIModes["m"].APIToken != "sk-1" || config.Presets["p"]["ai:apitoken"] != "sk-2" {
		t.Fatal("the stored config was changed")
	}
}
