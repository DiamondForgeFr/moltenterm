// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentchoice"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/molten/spawns"
	"github.com/wavetermdev/waveterm/pkg/molten/termupdate"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	// RouteId is the route the windows call; the commands must match frontend/moltenterm-shell/boss/brokk-session.ts.
	RouteId        = "molten:brokk"
	SessionCommand = "moltenbrokksession"
	SayCommand     = "moltenbrokksay"
	ReplyCommand   = "moltenbrokkreply"

	findTimeout = 5 * time.Second
	// Say waits for an agent just started: the window waits a little longer than startWait.
	sayTimeout = startWait + 20*time.Second
)

func liveFind(ctx context.Context) (Found, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, findTimeout)
	defer cancel()
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		return Found{}, false, err
	}
	for _, block := range blocks {
		if block == nil || block.Meta[BlockMetaKey] != true {
			continue
		}
		tabId, _ := wstore.DBFindTabForBlockId(ctx, block.OID)
		workspaceId := ""
		if tabId != "" {
			workspaceId, _ = wstore.DBFindWorkspaceForTabId(ctx, tabId)
		}
		return Found{BlockId: block.OID, TabId: tabId, WorkspaceId: workspaceId}, true, nil
	}
	return Found{}, false, nil
}

// answerReader follows his session's transcript, as the companion links it to his terminal: one reader, kept while
// the transcript stays the same, so each call reads only what was appended.
type answerReader struct {
	lock   sync.Mutex
	agent  string
	path   string
	reader *companion.SessionReader
}

func (a *answerReader) read(blockId string, index int) (Answer, bool) {
	agent, path, ok := companion.LinkedSession(blockId)
	if !ok || path == "" {
		return Answer{}, false
	}
	a.lock.Lock()
	defer a.lock.Unlock()
	if a.reader == nil || a.agent != agent || a.path != path {
		if a.reader != nil {
			a.reader.Close()
			a.reader = nil
		}
		reader, err := companion.OpenSessionReader(agent, path)
		if err != nil {
			log.Printf("[brokksession] his transcript cannot be read: %v\n", err)
			return Answer{}, false
		}
		a.reader, a.agent, a.path = reader, agent, path
	}
	if _, err := a.reader.Poll(); err != nil {
		log.Printf("[brokksession] his transcript cannot be read: %v\n", err)
		return Answer{}, false
	}
	view, found := a.reader.AnswerAt(index)
	if !found {
		return Answer{}, true
	}
	return Answer{Index: view.Index, Rev: view.Rev, At: view.At, Markdown: view.Markdown}, true
}

func liveFolder() (string, error) {
	dir := filepath.Join(wavebase.GetWaveDataDir(), FolderName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := WriteBrief(dir); err != nil {
		log.Printf("[brokksession] his brief could not be written: %v\n", err)
	}
	return dir, nil
}

func livePickAgent(dir string) (string, string, bool) {
	choice := agentchoice.Resolve(dir, "")
	if choice.Agent == "" {
		return "", choice.ChosenName, choice.Missing
	}
	return choice.Agent, molten.AgentDisplayName(choice.Agent), false
}

func liveChosenAgent(dir string) (string, bool) {
	choice := agentchoice.Resolve(dir, "")
	if !choice.Explicit() || choice.Missing || choice.Agent == "" {
		return "", false
	}
	return choice.Agent, true
}

// liveRunPrint runs the agent's quick, read-only form with the login shell's PATH, since a window opened from the
// desktop has a bare one. Nothing is printed on a terminal; stderr is kept for the error.
func liveRunPrint(ctx context.Context, dir string, agent string, prompt string) ([]byte, error) {
	argv := agentchoice.QuickPrintArgv(agent, dir)
	if argv == nil {
		return nil, fmt.Errorf("%s has no non-interactive form", agent)
	}
	path := molten.LoginPath()
	program := molten.LookPathIn(argv[0], path)
	if program == "" {
		return nil, fmt.Errorf("%s is not on the login PATH", argv[0])
	}
	cmd := spawns.Command(ctx, program, argv[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PATH="+path)
	cmd.Stdin = strings.NewReader(prompt)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("%s: %s", argv[0], msg)
	}
	return stdout.Bytes(), nil
}

func liveType(ctx context.Context, blockId string, line string) TypeOutcome {
	// A hand-off's path would refuse a message past its short line (#2236): the developer's text is typed whole.
	out := termupdate.TypeMessageLine(ctx, blockId, line)
	if out.Result == termupdate.InputSent {
		return TypeOutcome{Sent: true, Unsubmitted: !out.Submitted, Message: out.Message}
	}
	switch out.Reason {
	case termupdate.InputReasonWorking, termupdate.InputReasonWaiting, termupdate.InputReasonBusy, termupdate.InputReasonNotForeground:
		return TypeOutcome{Retry: true, Message: out.Message}
	case termupdate.InputReasonTerminalGone:
		return TypeOutcome{Gone: true, Message: out.Message}
	case termupdate.InputReasonNoAgent:
		return TypeOutcome{NoAgent: true, Message: out.Message}
	}
	return TypeOutcome{Message: out.Message}
}

func liveSleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// sessionCommandLine starts his agent in a mode that asks before acting, whatever the developer's own default is (a
// bypass default would give him full reach, #2220). Codex keeps its sandbox to his folder and asks to step out of it.
// The other agents of the catalog have no flag MoltenTerm knows to be the asking one: they start in their own default.
func sessionCommandLine(agent string) string {
	switch agent {
	case molten.AgentIdClaude:
		return reviewsession.CommandLine(agent, []string{"--permission-mode", "default"})
	case molten.AgentIdCodex:
		return reviewsession.CommandLine(agent, []string{"--sandbox", "workspace-write", "--ask-for-approval", "on-request"})
	}
	return reviewsession.CommandLine(agent, nil)
}

// Live is wavesrv's service: the agent choice, the hidden tabs of the agents MoltenTerm starts and the guarded path that
// types a prompt into an agent.
func Live() *Service {
	return MakeService(Env{
		Find:        liveFind,
		Folder:      liveFolder,
		PickAgent:   livePickAgent,
		CommandLine: sessionCommandLine,
		AgentTab: func(ctx context.Context, workspaceId string, name string, meta waveobj.MetaMapType) (string, error) {
			return wcore.CreateAgentTab(ctx, workspaceId, name, meta, true)
		},
		CloseTab: wcore.CloseAgentTab,
		OpenTerminal: func(ctx context.Context, tabId string, meta waveobj.MetaMapType, line string) (string, error) {
			return reviewsession.OpenTerminal(ctx, tabId, "", meta, line)
		},
		Type:       liveType,
		Ready:      termupdate.AgentTakesLine,
		Sleep:      liveSleep,
		ReadAnswer: (&answerReader{}).read,

		ChosenAgent: liveChosenAgent,
		RunPrint:    liveRunPrint,
	})
}

var startOnce sync.Once

// Start registers the route the windows talk to Brokk's session on; wavesrv calls it once, from Mission Control's start.
func Start() {
	startOnce.Do(func() {
		if _, err := localroute.Register(wshutil.DefaultRouter, Live().route()); err != nil {
			log.Printf("[brokksession] route not started: %v\n", err)
		}
	})
}

// route lets in the windows and Electron main only (#2220): a program or an agent in a terminal would otherwise start
// his session and type into it, read his conversation, or spend the developer's subscription on phrasings.
func (s *Service) route() localroute.Route {
	return localroute.Route{
		Id:     RouteId,
		Policy: localroute.Policy{Default: localroute.AllowUi},
		Handler: func(ctx context.Context, command string, _ localroute.Caller, data any) (any, error) {
			return s.handle(ctx, command, data)
		},
	}
}

// logUntaken leaves a line for a message his agent did not take: the window words the reason, and without this line a
// failure leaves no trace in the log (#2236). Never the text of the message.
func logUntaken(rtn Result) {
	if rtn.Status == StatusSent {
		return
	}
	log.Printf("[brokksession] a message was not taken as sent: %s %s: %s\n", rtn.Status, rtn.Reason, rtn.Message)
}

func (s *Service) handle(ctx context.Context, command string, data any) (any, error) {
	var req Request
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	switch command {
	case SessionCommand:
		return s.Session(ctx), nil
	case SayCommand:
		ctx, cancel := context.WithTimeout(ctx, sayTimeout)
		defer cancel()
		rtn := s.Say(ctx, req)
		logUntaken(rtn)
		return rtn, nil
	case ReplyCommand:
		var reply ReplyRequest
		if err := utilfn.ReUnmarshal(&reply, data); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(ctx, findTimeout)
		defer cancel()
		rtn := s.Reply(ctx, reply)
		// The window counts a reading that failed as one, as it does a call that failed; "none" would end the exchange.
		if rtn.Status == StatusFailed {
			return nil, fmt.Errorf("his session could not be looked for")
		}
		return rtn, nil
	case PhraseCommand:
		var phrase PhraseRequest
		if err := utilfn.ReUnmarshal(&phrase, data); err != nil {
			return nil, err
		}
		return s.Phrase(ctx, phrase), nil
	}
	return nil, fmt.Errorf("unknown Brokk session command %q", command)
}
