// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshserver

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/molten/metaguard"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
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

// guardFixture replaces the window's question, the known connections, name resolution and the block and job
// lookups.
type guardFixture struct {
	lock      sync.Mutex
	prompts   []promptCall
	questions []moltenQuestion
	allow     bool
	remember  bool
	// gate, when set, holds the window's answer until the test lets it go.
	gate chan struct{}
}

func (f *guardFixture) asked() []promptCall {
	f.lock.Lock()
	defer f.lock.Unlock()
	return append([]promptCall(nil), f.prompts...)
}

func (f *guardFixture) last() moltenQuestion {
	f.lock.Lock()
	defer f.lock.Unlock()
	return f.questions[len(f.questions)-1]
}

func setupGuard(t *testing.T) *guardFixture {
	t.Helper()
	f := &guardFixture{}
	savedPrompt, savedKnown, savedBlock, savedJob, savedHosts, savedResolve, savedAsk := moltenRemotePrompt, moltenKnownConnFn, moltenBlockConn, moltenJobConn, moltenHopHostsFn, moltenResolveHost, moltenAsk
	t.Cleanup(func() {
		moltenRemotePrompt, moltenKnownConnFn, moltenBlockConn, moltenJobConn, moltenHopHostsFn, moltenResolveHost, moltenAsk = savedPrompt, savedKnown, savedBlock, savedJob, savedHosts, savedResolve, savedAsk
	})
	moltenAsk = makeMoltenAskState()
	moltenRemotePrompt = func(q moltenQuestion) (bool, bool) {
		f.lock.Lock()
		f.prompts = append(f.prompts, promptCall{q.Server, q.Kind, q.Target})
		f.questions = append(f.questions, q)
		gate := f.gate
		f.lock.Unlock()
		if gate != nil {
			<-gate
		}
		f.lock.Lock()
		defer f.lock.Unlock()
		return f.allow, f.remember
	}
	moltenHopHostsFn = func(conn string) []string {
		host := metaguard.ConnHost(conn)
		if host == "vm-alias" {
			return []string{host, "localhost"}
		}
		return []string{host}
	}
	moltenResolveHost = func(_ context.Context, host string) ([]net.IPAddr, error) {
		switch host {
		case "loop.example":
			return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
		case "new.example", "build.example", "known.example":
			return []net.IPAddr{{IP: net.ParseIP("203.0.113.7")}}, nil
		}
		return nil, errors.New("no such host")
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
// in the window, never refused flat; the question shows the cleaned absolute path.
func TestRemoteLocalFilesAreAsked(t *testing.T) {
	f := setupGuard(t)
	dir := t.TempDir()
	report := filepath.Join(dir, "report.md")
	preview := wshrpc.CommandCreateBlockData{TabId: "t", BlockDef: &waveobj.BlockDef{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "preview", waveobj.MetaKey_File: report, waveobj.MetaKey_Connection: "local"}}}
	_, err := guardAsk(t, "createblock", preview)
	mustGuardRefuse(t, "denied local preview", err)
	if asked := f.asked(); len(asked) != 1 || asked[0] != (promptCall{guardTestConn, moltenAskRead, metaguard.CleanLocalPath(report)}) {
		t.Fatalf("asked %+v", asked)
	}
	f.allow = true
	got, err := guardAsk(t, "createblock", preview)
	if err != nil || createdMeta(t, got)[waveobj.MetaKey_Connection] != "local" {
		t.Fatalf("allowed local preview: %v %v", got, err)
	}
	_, err = guardAsk(t, "fileread", wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "/etc/../etc/passwd\n"}})
	if q := f.last(); q.Target != metaguard.CleanLocalPath("/etc/passwd\n") || !strings.HasPrefix(q.Target, string(filepath.Separator)) {
		t.Fatalf("the question shows %q, not the cleaned absolute path", q.Target)
	}
	if shown := metaguard.ShownPath(f.last().Target); strings.ContainsAny(shown, "\n\r") {
		t.Fatalf("the question prints a control character: %q", shown)
	}
	_ = err
}

// #1831 re-review: "always" covered the whole disk. It covers the approved path's folder and its subfolders only; a
// credential, startup or MoltenTerm location is asked every time; a wide folder (home, root) gets no "always".
func TestRemoteAlwaysIsScopedToAFolder(t *testing.T) {
	f := setupGuard(t)
	downloads := filepath.Join(t.TempDir(), "Downloads")
	if err := os.MkdirAll(filepath.Join(downloads, "builds"), 0o755); err != nil {
		t.Fatal(err)
	}
	f.allow, f.remember = true, true
	copyDown := wshrpc.CommandFileCopyData{SrcUri: "wsh://dev@build.example/tmp/build.log", DestUri: "wsh://local/" + filepath.ToSlash(filepath.Join(downloads, "build.log"))}
	if _, err := guardAsk(t, "filecopy", copyDown); err != nil {
		t.Fatalf("copy to this computer: %v", err)
	}
	if q := f.last(); q.Kind != moltenAskWrite || q.Folder != metaguard.CleanLocalPath(downloads) || q.Sensitive {
		t.Fatalf("asked %+v", q)
	}
	asked := len(f.asked())
	f.allow, f.remember = false, false
	for _, inside := range []string{filepath.Join(downloads, "other.log"), filepath.Join(downloads, "builds", "x.bin")} {
		if _, err := guardAsk(t, "filewrite", wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "wsh://local/" + filepath.ToSlash(inside)}}); err != nil {
			t.Fatalf("a write in the remembered folder: %v", err)
		}
	}
	if len(f.asked()) != asked {
		t.Fatal("the remembered folder was asked again")
	}
	home, _ := os.UserHomeDir()
	for _, outside := range []string{filepath.Join(filepath.Dir(downloads), "elsewhere.txt"), filepath.Join(home, ".ssh", "authorized_keys"), filepath.Join(home, ".zshrc"), filepath.Join(home, "Library", "LaunchAgents", "x.plist"), filepath.Join(home, ".config", "autostart", "x.desktop")} {
		before := len(f.asked())
		_, err := guardAsk(t, "filewrite", wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "wsh://local/" + filepath.ToSlash(outside)}})
		mustGuardRefuse(t, "outside the folder "+outside, err)
		if len(f.asked()) != before+1 {
			t.Fatalf("%s was not asked", outside)
		}
	}
	// A credential location is asked every time, even right after an Allow with "remember".
	f.allow, f.remember = true, true
	key := filepath.Join(home, ".ssh", "id_ed25519")
	for i := 0; i < 2; i++ {
		before := len(f.asked())
		moltenAsk.lock.Lock()
		moltenAsk.once = map[moltenOnceKey]moltenOnceGrant{}
		moltenAsk.lock.Unlock()
		if _, err := guardAsk(t, "fileread", wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "wsh://local/" + filepath.ToSlash(key)}}); err != nil {
			t.Fatal(err)
		}
		if q := f.last(); len(f.asked()) != before+1 || !q.Sensitive || q.Folder != "" {
			t.Fatalf("a key read was not asked as sensitive: %+v", q)
		}
	}
	if folder, ok := metaguard.AlwaysFolder(metaguard.CleanLocalPath(filepath.Join(home, "notes.txt"))); ok {
		t.Fatalf("a file of the home folder offers always for %s", folder)
	}
	if _, ok := metaguard.AlwaysFolder("/notes.txt"); ok {
		t.Fatal("a file of the root offers always")
	}
}

// One user action asks once: the info wsh checks before a copy is not asked, and an Allow covers the same path for a
// moment (a write covers a read).
func TestRemoteOneQuestionPerAction(t *testing.T) {
	f := setupGuard(t)
	src := filepath.Join(t.TempDir(), "notes.txt")
	f.allow = true
	if _, err := guardAsk(t, "fileinfo", wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "wsh://local/" + filepath.ToSlash(src)}}); err != nil {
		t.Fatalf("fileinfo: %v", err)
	}
	if len(f.asked()) != 0 {
		t.Fatal("a file's info was asked")
	}
	if _, err := guardAsk(t, "filecopy", wshrpc.CommandFileCopyData{SrcUri: "wsh://local/" + filepath.ToSlash(src), DestUri: "wsh://dev@build.example/tmp/notes.txt"}); err != nil {
		t.Fatalf("copy up: %v", err)
	}
	f.allow = false
	if _, err := guardAsk(t, "fileread", wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "wsh://local/" + filepath.ToSlash(src)}}); err != nil {
		t.Fatalf("a read of the path just allowed: %v", err)
	}
	if asked := f.asked(); len(asked) != 1 {
		t.Fatalf("one copy asked %d times: %+v", len(asked), asked)
	}
	home, _ := os.UserHomeDir()
	_, err := guardAsk(t, "fileinfo", wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "wsh://local/" + filepath.ToSlash(filepath.Join(home, ".ssh", "id_ed25519"))}})
	mustGuardRefuse(t, "a key's info is asked", err)
}

// One question per server at a time, and a remembered Deny refuses everything that server asks until restart.
func TestRemotePromptFlood(t *testing.T) {
	f := setupGuard(t)
	f.gate = make(chan struct{})
	dir := t.TempDir()
	errs := make(chan error, 5)
	for i := 0; i < 5; i++ {
		path := filepath.Join(dir, "f"+string(rune('a'+i)))
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			_, err := moltenCheckRemoteRequest(ctx, guardTestHost, "fileread", asWire(t, wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "wsh://local/" + filepath.ToSlash(path)}}))
			errs <- err
		}()
	}
	deadline := time.After(time.Minute)
	for len(f.asked()) == 0 {
		select {
		case <-deadline:
			t.Fatal("no question was asked")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if n := len(f.asked()); n != 1 {
		t.Fatalf("%d questions open at once for one server", n)
	}
	f.lock.Lock()
	f.allow, f.remember = false, true
	f.lock.Unlock()
	close(f.gate)
	for i := 0; i < 5; i++ {
		mustGuardRefuse(t, "after a remembered deny", <-errs)
	}
	if n := len(f.asked()); n != 1 {
		t.Fatalf("a denied server was asked again (%d questions)", n)
	}
	_, err := guardAsk(t, "connconnect", wshrpc.ConnRequest{Host: "new@new.example"})
	if err == nil || !strings.Contains(err.Error(), "you denied") {
		t.Fatalf("a denied server's other request: %v", err)
	}
	other := metaguard.Remote{Conn: "other@host"}
	f.lock.Lock()
	f.gate, f.allow, f.remember = nil, true, false
	f.lock.Unlock()
	if _, err := moltenCheckRemoteRequest(context.Background(), other, "fileread", asWire(t, wshrpc.FileData{Info: &wshrpc.FileInfo{Path: "wsh://local/" + filepath.ToSlash(filepath.Join(dir, "x"))}})); err != nil {
		t.Fatalf("another server is not denied: %v", err)
	}
}

// The question waits as long as the request does (wsh file waits 75 s on a server), within the bounds.
func TestRemoteAskTimeoutFollowsTheRequest(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	if got := moltenAskTimeoutFor(ctx); got != moltenAskTimeout {
		t.Errorf("a 75 s request: the question waits %v", got)
	}
	short, cancelShort := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelShort()
	if got := moltenAskTimeoutFor(short); got > 20*time.Second || got < 15*time.Second {
		t.Errorf("a 20 s request: the question waits %v", got)
	}
	tiny, cancelTiny := context.WithTimeout(context.Background(), time.Second)
	defer cancelTiny()
	if got := moltenAskTimeoutFor(tiny); got != moltenAskMinTimeout {
		t.Errorf("a 1 s request: the question waits %v", got)
	}
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
		"fetchsuggestions":                  wshrpc.FetchSuggestionsData{SuggestionType: "file", FileCwd: "~/.ssh", FileConnection: guardTestConn},
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
		"fetchsuggestions":       wshrpc.FetchSuggestionsData{SuggestionType: "bookmark", Query: "x"},
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
// confirmation; never to this computer's own SSH server, by name, numeric form, alias or DNS answer.
func TestRemoteHopToAnotherServer(t *testing.T) {
	f := setupGuard(t)
	for _, host := range []string{"me@localhost", "127.0.0.1", "root@127.0.0.2:2222", "[::1]:22", "me@LOCALHOST.", "127.1", "2130706433", "0x7f.1", "0177.0.0.1", "me@loop.example", "vm-alias", "0"} {
		_, err := guardAsk(t, "connconnect", wshrpc.ConnRequest{Host: host})
		mustGuardRefuse(t, "loopback "+host, err)
	}
	if asked := f.asked(); len(asked) != 0 {
		t.Fatalf("a loopback address was asked: %+v", asked)
	}
	_, err := guardAsk(t, "connconnect", wshrpc.ConnRequest{Host: "new@new.example"})
	mustGuardRefuse(t, "an unknown server, denied", err)
	if asked := f.asked(); len(asked) != 1 || asked[0] != (promptCall{guardTestConn, moltenAskConnect, "new@new.example"}) {
		t.Fatalf("asked %+v", asked)
	}
	f.allow = true
	if _, err := guardAsk(t, "createblock", wshrpc.CommandCreateBlockData{TabId: "t", BlockDef: &waveobj.BlockDef{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "shell", waveobj.MetaKey_Connection: "new@new.example"}}}); err != nil {
		t.Fatalf("wsh ssh -n to an allowed server: %v", err)
	}
}

// #2119: an SSH or WSL host's link, as the router knows it, is refused this computer's secrets, the events that carry
// its API tokens or other connections' questions, the AI modes' tokens and other workspaces' MoltenTerm keys through
// blockinfo. A window and a local terminal keep them.
func TestRemoteSecretsTokensAndEvents(t *testing.T) {
	e := routetest.Make(t)
	saved := wshutil.DefaultRouter
	wshutil.DefaultRouter = e.Router
	t.Cleanup(func() { wshutil.DefaultRouter = saved })
	ctxOf := func(from routetest.From) context.Context {
		return wshutil.WithCallerContext(context.Background(), from.Source, from.Link)
	}
	remote := e.Forged()[0]
	if remote.Name != "remote terminal" {
		t.Fatalf("the first forged caller is %q", remote.Name)
	}
	value := "sk-new"
	secretRequests := map[string]any{
		"getsecrets":      []string{"OPENAI_KEY"},
		"getsecretsnames": nil,
		"setsecrets":      map[string]*string{"OPENAI_KEY": &value},
	}
	for command, data := range secretRequests {
		_, err := moltenRemoteGuard(ctxOf(remote), command, asWire(t, data))
		mustGuardRefuse(t, "remote "+command, err)
		for _, from := range []routetest.From{e.Window(), e.Terminal()} {
			if _, err := moltenRemoteGuard(ctxOf(from), command, asWire(t, data)); err != nil {
				t.Errorf("%s %s: %v", from.Name, command, err)
			}
		}
	}
	for _, event := range []string{wps.Event_Config, wps.Event_AIModeConfig, wps.Event_UserInput} {
		req := wps.SubscriptionRequest{Event: event, AllScopes: true}
		mustGuardRefuse(t, "remote eventsub "+event, WshServerImpl.EventSubCommand(ctxOf(remote), req))
		_, err := WshServerImpl.EventReadHistoryCommand(ctxOf(remote), wshrpc.CommandEventReadHistoryData{Event: event, MaxItems: 1})
		mustGuardRefuse(t, "remote history "+event, err)
		for _, from := range []routetest.From{e.Window(), e.Terminal()} {
			if err := moltenCheckSubscribe(ctxOf(from), req); err != nil {
				t.Errorf("%s %s: %v", from.Name, event, err)
			}
		}
	}
	if err := moltenCheckSubscribe(ctxOf(remote), wps.SubscriptionRequest{Event: wps.Event_BlockClose, AllScopes: true}); err != nil {
		t.Errorf("remote blockclose (wsh editor): %v", err)
	}
	modes := map[string]wconfig.AIModeConfigType{"m": {APIToken: "sk-1", Model: "gpt"}}
	if got := moltenListedAIModes(ctxOf(remote), modes); got["m"].APIToken != "" || got["m"].Model != "gpt" {
		t.Errorf("remote AI modes %+v", got)
	}
	if got := moltenListedAIModes(ctxOf(e.Window()), modes); got["m"].APIToken != "sk-1" {
		t.Errorf("the window's AI modes %+v", got)
	}
	block := &waveobj.Block{OID: localBlock, Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "web", "molten:browser:open": "x"}}
	if got := moltenListedBlock(ctxOf(remote), block); got.Meta["molten:browser:open"] != nil || got.Meta[waveobj.MetaKey_View] != "web" {
		t.Errorf("remote blockinfo meta %+v", got.Meta)
	}
	if block.Meta["molten:browser:open"] != "x" {
		t.Fatal("the stored block was changed")
	}
	if got := moltenListedBlock(ctxOf(e.Window()), block); got.Meta["molten:browser:open"] != "x" {
		t.Errorf("the window's blockinfo meta %+v", got.Meta)
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
