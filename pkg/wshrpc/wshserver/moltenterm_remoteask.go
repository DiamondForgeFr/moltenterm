// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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
// confirm instead"): reading or writing a file of this computer from the server's terminal, and making this computer
// connect to another server. One question per server at a time. An answer may be remembered until MoltenTerm
// restarts: an Allow for the folder of the approved path and its subfolders (never a credential, startup or
// MoltenTerm location, never the home folder or wider), a Deny for everything that server asks.

const (
	moltenAskRead      = "read"
	moltenAskWrite     = "write"
	moltenAskConnect   = "connect"
	moltenAskReadVars  = "readvars"
	moltenAskWriteVars = "writevars"
)

const (
	// moltenAskTimeout is how long the window's question waits for an answer, at most.
	moltenAskTimeout = 60 * time.Second
	// moltenAskMinTimeout is the least a question waits, whatever the request's own deadline.
	moltenAskMinTimeout = 5 * time.Second
	// moltenAskOnceTTL is how long one Allow covers the same path, so one user action asks once (an info, then the
	// read or the copy).
	moltenAskOnceTTL = 2 * time.Minute
)

// moltenQuestion is one question to the window.
type moltenQuestion struct {
	Server      string
	Kind        string
	Target      string
	Folder      string
	Sensitive   bool
	Timeout     time.Duration
	TargetLabel string
	TargetText  *uimsg.Text
}

type moltenAskState struct {
	lock    sync.Mutex
	folders map[string][]moltenFolderGrant
	once    map[moltenOnceKey]moltenOnceGrant
	denied  map[string]bool
	slots   map[string]chan struct{}
}

type moltenFolderGrant struct {
	kind   string
	folder string
}

type moltenOnceKey struct {
	conn   string
	target string
}

type moltenOnceGrant struct {
	kind    string
	expires time.Time
}

var moltenAsk = makeMoltenAskState()

func makeMoltenAskState() *moltenAskState {
	return &moltenAskState{folders: map[string][]moltenFolderGrant{}, once: map[moltenOnceKey]moltenOnceGrant{}, denied: map[string]bool{}, slots: map[string]chan struct{}{}}
}

// covers tells whether a granted kind covers kind: a write covers a read of the same files.
func kindCovers(granted string, kind string) bool {
	return granted == kind || (granted == moltenAskWrite && kind == moltenAskRead) || (granted == moltenAskWriteVars && kind == moltenAskReadVars)
}

func (s *moltenAskState) isDenied(conn string) bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	return s.denied[conn]
}

func (s *moltenAskState) isGranted(conn string, q moltenQuestion, now time.Time) bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	if grant, ok := s.once[moltenOnceKey{conn: conn, target: q.Target}]; ok && now.Before(grant.expires) && kindCovers(grant.kind, q.Kind) {
		return true
	}
	if q.Sensitive {
		return false
	}
	for _, grant := range s.folders[conn] {
		if !kindCovers(grant.kind, q.Kind) {
			continue
		}
		if q.Kind == moltenAskConnect {
			if wshutil.NormConnName(grant.folder) == wshutil.NormConnName(q.Target) {
				return true
			}
			continue
		}
		if metaguard.PathWithin(q.Target, grant.folder) {
			return true
		}
	}
	return false
}

func (s *moltenAskState) record(conn string, q moltenQuestion, allowed bool, remember bool, now time.Time) {
	s.lock.Lock()
	defer s.lock.Unlock()
	if !allowed {
		if remember {
			s.denied[conn] = true
		}
		return
	}
	s.once[moltenOnceKey{conn: conn, target: q.Target}] = moltenOnceGrant{kind: q.Kind, expires: now.Add(moltenAskOnceTTL)}
	if remember && q.Folder != "" {
		s.folders[conn] = append(s.folders[conn], moltenFolderGrant{kind: q.Kind, folder: q.Folder})
	}
}

// slot is the one question a server may have open in the window.
func (s *moltenAskState) slot(conn string) chan struct{} {
	s.lock.Lock()
	defer s.lock.Unlock()
	ch := s.slots[conn]
	if ch == nil {
		ch = make(chan struct{}, 1)
		s.slots[conn] = ch
	}
	return ch
}

// moltenRemotePrompt asks the window; tests replace it. It returns whether the developer allowed, and whether to
// remember the answer.
var moltenRemotePrompt = moltenPromptWindow

func moltenQuestionTexts(q moltenQuestion) (title *uimsg.Text, query *uimsg.Text, remember *uimsg.Text, englishTitle string, englishQuery string, englishRemember string) {
	server, target, folder := q.Server, metaguard.ShownPath(q.Target), metaguard.ShownPath(q.Folder)
	switch q.Kind {
	case moltenAskReadVars:
		title, englishTitle = uimsg.Make("remoteask.readVariablesTitle"), "A server wants to read variables"
		query, englishQuery = uimsg.Make("remoteask.readVariables", "server", server, "path", q.TargetLabel).With("path", q.TargetText), fmt.Sprintf("%s wants to read %s stored by MoltenTerm. It may contain credentials.", server, q.TargetLabel)
	case moltenAskWriteVars:
		title, englishTitle = uimsg.Make("remoteask.writeVariablesTitle"), "A server wants to change variables"
		query, englishQuery = uimsg.Make("remoteask.writeVariables", "server", server, "path", q.TargetLabel).With("path", q.TargetText), fmt.Sprintf("%s wants to change %s stored by MoltenTerm. Variables can affect programs started on this computer.", server, q.TargetLabel)
	case moltenAskRead:
		title, englishTitle = uimsg.Make("remoteask.readTitle"), "A server wants to read a file of this computer"
		query, englishQuery = uimsg.Make("remoteask.read", "server", server, "path", target), fmt.Sprintf("%s wants to read %s on this computer.", server, target)
		if q.Sensitive {
			query, englishQuery = uimsg.Make("remoteask.readSensitive", "server", server, "path", target), fmt.Sprintf("%s wants to read %s on this computer. This location holds credentials or settings that can run programs.", server, target)
		}
	case moltenAskWrite:
		title, englishTitle = uimsg.Make("remoteask.writeTitle"), "A server wants to write a file on this computer"
		query, englishQuery = uimsg.Make("remoteask.write", "server", server, "path", target), fmt.Sprintf("%s wants to write %s on this computer.", server, target)
		if q.Sensitive {
			query, englishQuery = uimsg.Make("remoteask.writeSensitive", "server", server, "path", target), fmt.Sprintf("%s wants to write %s on this computer. This location holds credentials or settings that can run programs.", server, target)
		}
	default:
		title, englishTitle = uimsg.Make("remoteask.connectTitle"), "A server wants this computer to connect to another server"
		query, englishQuery = uimsg.Make("remoteask.connect", "server", server, "target", target), fmt.Sprintf("%s wants this computer to open a connection to %s.", server, target)
	}
	switch {
	case q.Kind == moltenAskConnect:
		remember, englishRemember = uimsg.Make("remoteask.rememberConnect", "server", server, "target", target), fmt.Sprintf("Remember until MoltenTerm restarts (Allow: %s may connect this computer to %s; Deny: refuse everything %s asks)", server, target, server)
	case q.Folder != "" && q.Kind == moltenAskWrite:
		remember, englishRemember = uimsg.Make("remoteask.rememberWrite", "server", server, "folder", folder), fmt.Sprintf("Remember until MoltenTerm restarts (Allow: %s may write files in %s; Deny: refuse everything %s asks)", server, folder, server)
	case q.Folder != "":
		remember, englishRemember = uimsg.Make("remoteask.rememberRead", "server", server, "folder", folder), fmt.Sprintf("Remember until MoltenTerm restarts (Allow: %s may read files in %s; Deny: refuse everything %s asks)", server, folder, server)
	default:
		remember, englishRemember = uimsg.Make("remoteask.rememberDeny", "server", server), fmt.Sprintf("If I deny, refuse everything %s asks until MoltenTerm restarts (this location is asked every time)", server)
	}
	return
}

func moltenPromptWindow(q moltenQuestion) (bool, bool) {
	title, query, remember, englishTitle, englishQuery, englishRemember := moltenQuestionTexts(q)
	ctx, cancel := context.WithTimeout(context.Background(), q.Timeout)
	defer cancel()
	resp, err := userinput.GetUserInput(ctx, &userinput.UserInputRequest{
		ResponseType: "confirm",
		Title:        englishTitle,
		QueryText:    englishQuery,
		CheckBoxMsg:  englishRemember,
		OkLabel:      "Allow",
		CancelLabel:  "Deny",
		MoltenTexts:  map[string]any{"title": title, "querytext": query, "checkboxmsg": remember, "oklabel": uimsg.Make("remoteask.allow"), "cancellabel": uimsg.Make("remoteask.deny")},
	})
	if err != nil || resp == nil {
		return false, false
	}
	return resp.Confirm, resp.CheckboxStat
}

// moltenAskTimeoutFor is how long a question may wait: the request's own deadline, so the answer comes while the
// server still waits for it, bounded by moltenAskTimeout and moltenAskMinTimeout.
func moltenAskTimeoutFor(ctx context.Context) time.Duration {
	wait := moltenAskTimeout
	if deadline, ok := ctx.Deadline(); ok {
		wait = min(wait, time.Until(deadline)-time.Second)
	}
	return max(wait, moltenAskMinTimeout)
}

func moltenAskVerb(kind string) string {
	if kind == moltenAskReadVars {
		return "read variables from"
	}
	if kind == moltenAskWriteVars {
		return "change variables in"
	}
	if kind == moltenAskConnect {
		return "connect this computer to"
	}
	return kind
}

// moltenAskRemote asks the window whether the server may do kind on target (a cleaned path of this computer, or a
// connection), one question per server at a time.
func moltenAskRemote(ctx context.Context, remote metaguard.Remote, kind string, target string) error {
	q := moltenQuestion{Kind: kind, Target: target}
	if kind != moltenAskConnect {
		q.Target = metaguard.CleanLocalPath(target)
		q.Sensitive = metaguard.IsSensitiveLocalPath(q.Target)
		q.Folder, _ = metaguard.AlwaysFolder(q.Target)
	} else {
		q.Folder = target
	}
	return moltenAskQuestion(ctx, remote, q)
}

func moltenAskQuestion(ctx context.Context, remote metaguard.Remote, q moltenQuestion) error {
	server := remote.Conn
	if server == "" {
		return fmt.Errorf("refused: an SSH or WSL host whose connection is unknown cannot %s %s."+metaguard.RemoteHint, moltenAskVerb(q.Kind), q.Target)
	}
	conn := wshutil.NormConnName(server)
	q.Server = server
	if err := moltenAskPreCheck(conn, server, q); err != errMoltenAskNeeded {
		return err
	}
	slot := moltenAsk.slot(conn)
	select {
	case slot <- struct{}{}:
	case <-ctx.Done():
		return fmt.Errorf("refused: %s already has a question waiting in the MoltenTerm window; answer it, then run this again."+metaguard.RemoteHint, server)
	}
	defer func() { <-slot }()
	if err := moltenAskPreCheck(conn, server, q); err != errMoltenAskNeeded {
		return err
	}
	q.Timeout = moltenAskTimeoutFor(ctx)
	allowed, remember := moltenRemotePrompt(q)
	moltenAsk.record(conn, q, allowed, remember, time.Now())
	if !allowed {
		return fmt.Errorf("refused: %s was not allowed to %s %s (asked in the MoltenTerm window)."+metaguard.RemoteHint, server, moltenAskVerb(q.Kind), metaguard.ShownPath(q.Target))
	}
	return nil
}

var errMoltenAskNeeded = fmt.Errorf("ask")

func moltenAskPreCheck(conn string, server string, q moltenQuestion) error {
	if moltenAsk.isDenied(conn) {
		return fmt.Errorf("refused: you denied %s everything it asks until MoltenTerm restarts."+metaguard.RemoteHint, server)
	}
	if moltenAsk.isGranted(conn, q, time.Now()) {
		return nil
	}
	return errMoltenAskNeeded
}

// moltenCheckRemotePath lets a host use a path of a server, asks the window for a path of this computer (read or
// write), and refuses the rest (a WSL distribution, another scheme).
func moltenCheckRemotePath(ctx context.Context, remote metaguard.Remote, path string, kind string) error {
	if err := metaguard.CheckRemotePath(remote, path); err == nil {
		return moltenCheckRemoteHopPath(ctx, remote, path)
	}
	local, ok := metaguard.LocalPath(path)
	if !ok {
		return metaguard.CheckRemotePath(remote, path)
	}
	return moltenAskRemote(ctx, remote, kind, local)
}

func moltenCheckRemoteHopPath(ctx context.Context, remote metaguard.Remote, path string) error {
	host, ok := metaguard.PathHost(path)
	if !ok {
		return nil
	}
	return moltenCheckRemoteHop(ctx, remote, host)
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

// moltenKnownConnFn and moltenLoopbackConnFn are moltenKnownConn and moltenIsLoopbackTarget; tests replace them.
var moltenKnownConnFn = moltenKnownConn
var moltenLoopbackConnFn = moltenIsLoopbackTarget

// moltenCheckRemoteHop bounds a request that makes this computer act on another SSH server: never this computer's
// own SSH server (the name, its configured HostName and the addresses they resolve to), a known connection as is,
// any other after the window's confirmation. The connection is then marked as a server's request, so its dial
// refuses a loopback address too (DNS that changes in between).
func moltenCheckRemoteHop(ctx context.Context, remote metaguard.Remote, conn string) error {
	if !metaguard.OtherServer(remote, conn) {
		return nil
	}
	if moltenLoopbackConnFn(ctx, conn) {
		return fmt.Errorf("refused: an SSH or WSL host cannot make this computer connect to %q, which is this computer."+metaguard.RemoteHint, conn)
	}
	if !moltenKnownConnFn(conn) {
		if err := moltenAskRemote(ctx, remote, moltenAskConnect, conn); err != nil {
			return err
		}
	}
	moltenMarkServerRequested(conn)
	return nil
}
