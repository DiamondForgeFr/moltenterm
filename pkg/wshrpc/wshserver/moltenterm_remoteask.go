// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/metaguard"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/userinput"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// What a server asks that the developer may want is asked in the window, never refused flat (#1831, "never block,
// confirm instead"): copying a file to or from this computer from the server's terminal, and making this computer
// connect to another server. The answer "always" holds for that server and that kind of request until MoltenTerm
// restarts.

const (
	moltenAskRead    = "read"
	moltenAskWrite   = "write"
	moltenAskConnect = "connect"
)

// moltenAskTimeout is how long the window's question waits for an answer.
const moltenAskTimeout = 60 * time.Second

type moltenAskGrant struct {
	conn string
	kind string
}

var moltenAskGrantsLock sync.Mutex
var moltenAskGrants = map[moltenAskGrant]bool{}

func moltenAskGranted(conn string, kind string) bool {
	moltenAskGrantsLock.Lock()
	defer moltenAskGrantsLock.Unlock()
	return moltenAskGrants[moltenAskGrant{conn: wshutil.NormConnName(conn), kind: kind}]
}

func moltenGrantAsk(conn string, kind string) {
	moltenAskGrantsLock.Lock()
	defer moltenAskGrantsLock.Unlock()
	moltenAskGrants[moltenAskGrant{conn: wshutil.NormConnName(conn), kind: kind}] = true
}

// moltenRemotePrompt asks the window; tests replace it. It returns whether the developer allowed, and "always".
var moltenRemotePrompt = moltenPromptWindow

func moltenAskTexts(server string, kind string, target string) (title *uimsg.Text, query *uimsg.Text, englishTitle string, englishQuery string) {
	switch kind {
	case moltenAskRead:
		return uimsg.Make("remoteask.readTitle"), uimsg.Make("remoteask.read", "server", server, "path", target),
			"A server wants to read a file of this computer",
			fmt.Sprintf("%s wants to read %s on this computer.", server, target)
	case moltenAskWrite:
		return uimsg.Make("remoteask.writeTitle"), uimsg.Make("remoteask.write", "server", server, "path", target),
			"A server wants to write a file on this computer",
			fmt.Sprintf("%s wants to write %s on this computer.", server, target)
	}
	return uimsg.Make("remoteask.connectTitle"), uimsg.Make("remoteask.connect", "server", server, "target", target),
		"A server wants this computer to connect to another server",
		fmt.Sprintf("%s wants this computer to open a connection to %s.", server, target)
}

func moltenPromptWindow(server string, kind string, target string) (bool, bool) {
	title, query, englishTitle, englishQuery := moltenAskTexts(server, kind, target)
	always := uimsg.Make("remoteask.always", "server", server)
	allow := uimsg.Make("remoteask.allow")
	deny := uimsg.Make("remoteask.deny")
	ctx, cancel := context.WithTimeout(context.Background(), moltenAskTimeout)
	defer cancel()
	resp, err := userinput.GetUserInput(ctx, &userinput.UserInputRequest{
		ResponseType: "confirm",
		Title:        englishTitle,
		QueryText:    englishQuery,
		CheckBoxMsg:  fmt.Sprintf("Always allow %s to do this until MoltenTerm restarts", server),
		OkLabel:      "Allow",
		CancelLabel:  "Deny",
		MoltenTexts:  map[string]any{"title": title, "querytext": query, "checkboxmsg": always, "oklabel": allow, "cancellabel": deny},
	})
	if err != nil || resp == nil {
		return false, false
	}
	return resp.Confirm, resp.Confirm && resp.CheckboxStat
}

// moltenAskRemote asks the window whether the server may do kind on target; a refusal says the developer did not
// allow it.
func moltenAskRemote(remote metaguard.Remote, kind string, target string) error {
	server := remote.Conn
	if server == "" {
		server = "A server"
	}
	if remote.Conn != "" && moltenAskGranted(remote.Conn, kind) {
		return nil
	}
	allowed, always := moltenRemotePrompt(server, kind, target)
	if !allowed {
		verb := kind
		if kind == moltenAskConnect {
			verb = "connect this computer to"
		}
		return fmt.Errorf("refused: %s was not allowed to %s %s (asked in the MoltenTerm window)."+metaguard.RemoteHint, server, verb, target)
	}
	if always && remote.Conn != "" {
		moltenGrantAsk(remote.Conn, kind)
	}
	return nil
}

// moltenCheckRemotePath lets a host use a path of a server, asks the window for a path of this computer (read or
// write), and refuses the rest (a WSL distribution, another scheme).
func moltenCheckRemotePath(remote metaguard.Remote, path string, kind string) error {
	if err := metaguard.CheckRemotePath(remote, path); err == nil {
		return moltenCheckRemoteHopPath(remote, path)
	}
	local, ok := metaguard.LocalPath(path)
	if !ok {
		return metaguard.CheckRemotePath(remote, path)
	}
	return moltenAskRemote(remote, kind, local)
}

func moltenCheckRemoteHopPath(remote metaguard.Remote, path string) error {
	host, ok := metaguard.PathHost(path)
	if !ok {
		return nil
	}
	return moltenCheckRemoteHop(remote, host)
}

// moltenKnownConn tells whether conn is configured (connections.json) or already connected: a host may ask for it
// without the window's confirmation.
func moltenKnownConn(conn string) bool {
	norm := wshutil.NormConnName(conn)
	for name := range wconfig.GetWatcher().GetFullConfig().Connections {
		if wshutil.NormConnName(name) == norm {
			return true
		}
	}
	for _, status := range conncontroller.GetAllConnStatus() {
		if wshutil.NormConnName(status.Connection) == norm {
			return true
		}
	}
	return false
}

// moltenKnownConnFn is moltenKnownConn; tests replace it.
var moltenKnownConnFn = moltenKnownConn

// moltenCheckRemoteHop bounds a request that makes this computer act on another SSH server: never a loopback
// address (this computer's own SSH server), a known connection as is, any other after the window's confirmation.
func moltenCheckRemoteHop(remote metaguard.Remote, conn string) error {
	if !metaguard.OtherServer(remote, conn) {
		return nil
	}
	if metaguard.IsLoopbackConn(conn) {
		return fmt.Errorf("refused: an SSH or WSL host cannot make this computer connect to %q, which is this computer."+metaguard.RemoteHint, conn)
	}
	if moltenKnownConnFn(conn) {
		return nil
	}
	return moltenAskRemote(remote, moltenAskConnect, conn)
}
