// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Update terminal (DS-SHELL-075). Nothing is ever signalled or killed: a shell is replaced only when nothing runs in
// it, and an agent is only asked to exit with its own command, while it is idle.

const (
	// How long an agent has to exit after its exit command (FR-CONT-010 uses the same budget).
	AgentExitTimeout = 10 * time.Second
	// Claude Code takes text followed at once by Enter for a paste: each key or text goes on its own, this much later.
	exitEnterDelay = 300 * time.Millisecond
	// Escape cancels what the agent asks (Claude Code and Codex); Ctrl+U clears the input line.
	keyEscape    = "\x1b"
	keyClearLine = "\x15"
	// How long the companion may look for the agent's session.
	resumeSessionWait = 2 * time.Second
	// How long the new shell has to show its first prompt before the agent's command is typed anyway.
	firstPromptTimeout = 15 * time.Second
	pollInterval       = 200 * time.Millisecond
	// How long the old shell's prompt, drawn when the agent exits, takes to come through the output.
	oldPromptSettle = 500 * time.Millisecond
	// How long a shell's line editor takes to start after its prompt hook.
	lineEditorSettle = 400 * time.Millisecond
	// After the agent exits, the shell takes its terminal back.
	shellBackTimeout = 2 * time.Second
)

// Helpers a shell starts on its own and keeps for its whole life, which end with it at no loss: powerlevel10k's git
// status daemon.
var shellHelperPrefixes = []string{"gitstatusd"}

// TerminalUpdatedNotice is the line written in the pane before the new shell starts.
const TerminalUpdatedNotice = "MoltenTerm: terminal updated to the current shell environment"

// Env is what the update needs from wavesrv; tests replace it.
type Env struct {
	// LoadJob reads a terminal's block and its shell job.
	LoadJob   func(ctx context.Context, blockId string) (*waveobj.Block, *waveobj.Job, error)
	ReadTable func() (*proctree.Table, error)
	ReadArgs  func(pid int32) (string, []string)
	Cwd       func(pid int32) string
	AgentRun  func(blockId string) (molten.AgentRunInfo, bool)
	// FindSession resolves the session of a block's agent (companion.FindResumeSession).
	FindSession func(blockId string, agent string, wait time.Duration) companion.ResumeSession
	SendInput   func(blockId string, data []byte) error
	// Replace starts a fresh shell for the block in cwd, keeping its pane and scrollback (pkg/blockcontroller).
	Replace func(ctx context.Context, blockId string, cwd string, notice string) error
	// WatchPrompt returns a channel told of the block's next prompt marks, and its release.
	WatchPrompt func(blockId string) (<-chan struct{}, func())
	// InputState: what the terminal's input and output tell about its agent (moltenagentinput); nil: nothing known.
	InputState func(blockId string) AgentInputState
	// Current is the app's shell generation (shellutil.MoltenShellGeneration when 0).
	Current int
	Sleep   func(d time.Duration)
	Now     func() time.Time
}

// Updater runs Update terminal, one at a time per terminal.
type Updater struct {
	env     Env
	lock    sync.Mutex
	running map[string]bool
}

func MakeUpdater(env Env) *Updater {
	if env.Sleep == nil {
		env.Sleep = time.Sleep
	}
	if env.Now == nil {
		env.Now = time.Now
	}
	if env.Current == 0 {
		env.Current = shellutil.MoltenShellGeneration
	}
	return &Updater{env: env, running: map[string]bool{}}
}

func (u *Updater) begin(blockId string) bool {
	u.lock.Lock()
	defer u.lock.Unlock()
	if u.running[blockId] {
		return false
	}
	u.running[blockId] = true
	return true
}

func (u *Updater) end(blockId string) {
	u.lock.Lock()
	defer u.lock.Unlock()
	delete(u.running, blockId)
}

// shellState is what runs in a terminal's shell right now.
type shellState struct {
	job   *waveobj.Job
	block *waveobj.Block
	shell *proctree.Proc
	// agent: the coding agent in the foreground, with an adapter that can stop and resume it.
	agent   molten.AgentProcess
	adapter agentcontinuity.AgentAdapter
	// busy: another program in the foreground, or one the shell started in the background.
	busy string
}

func (u *Updater) inspect(ctx context.Context, blockId string) (shellState, *Outcome) {
	block, job, err := u.env.LoadJob(ctx, blockId)
	if err != nil {
		return shellState{}, &Outcome{Status: StatusUnavailable, Message: fmt.Sprintf("This terminal cannot be read: %v", err)}
	}
	isCommand := block != nil && block.Meta.GetString(waveobj.MetaKey_Cmd, "") != ""
	if !IsLocalShellJob(job, isCommand) {
		return shellState{}, &Outcome{Status: StatusUnavailable, Message: "Only a local terminal's shell can be updated."}
	}
	table, err := u.env.ReadTable()
	if err != nil || table == nil {
		return shellState{}, &Outcome{Status: StatusUnavailable, Message: "MoltenTerm cannot see what runs in this terminal on this system."}
	}
	pid := int32(job.CmdPid)
	if !table.Same(pid, job.CmdStartTs) {
		return shellState{}, &Outcome{Status: StatusUnavailable, Message: "This terminal's shell has ended."}
	}
	st := shellState{job: job, block: block, shell: table.Get(pid)}
	if table.Running(pid) {
		fg := table.Foreground(pid)
		if agent, ok := molten.FindAgentProcess(fg, u.env.ReadArgs); ok {
			if adapter := agentcontinuity.Find(agent.Agent); adapter != nil {
				st.agent, st.adapter = agent, adapter
				return st, nil
			}
		}
		st.busy = firstOther(fg, pid, st.shell.Name)
		if st.busy == "" {
			st.busy = "a program"
		}
		return st, nil
	}
	st.busy = firstOther(table.Descendants(pid), pid, st.shell.Name)
	return st, nil
}

// firstOther names the first process that is not the shell, a copy of it (a subshell, an async prompt worker) or one
// of its helpers.
func firstOther(procs []*proctree.Proc, shellPid int32, shellName string) string {
	for _, p := range procs {
		if p.Pid == shellPid || p.Name == shellName || shellHelper(p.Name) {
			continue
		}
		return filepath.Base(p.Name)
	}
	return ""
}

func shellHelper(name string) bool {
	base := filepath.Base(name)
	for _, prefix := range shellHelperPrefixes {
		if strings.HasPrefix(base, prefix) {
			return true
		}
	}
	return false
}

// logicalCwd keeps the folder as the shell named it ($PWD, from OSC 7: /tmp/x) when it is the folder the process is in
// (/private/tmp/x): Claude Code files its sessions under the folder's name, so a resumed session must start there.
func logicalCwd(physical string, block *waveobj.Block) string {
	if block == nil {
		return physical
	}
	logical := block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
	if logical == "" || physical == "" || logical == physical {
		return physical
	}
	resolved, err := filepath.EvalSymlinks(logical)
	if err != nil || filepath.Clean(resolved) != filepath.Clean(physical) {
		return physical
	}
	return logical
}

func busyOutcome(program string) *Outcome {
	return &Outcome{
		Status:  StatusBusy,
		Program: program,
		Message: fmt.Sprintf("Finish or stop %s first: updating the terminal replaces its shell.", program),
	}
}

// Check tells what Update terminal would do now, without doing anything.
func (u *Updater) Check(ctx context.Context, req Request) Outcome {
	st, out := u.inspect(ctx, req.BlockId)
	if out != nil {
		return *out
	}
	if st.adapter != nil {
		name := st.adapter.Name()
		if busy := u.agentBusy(req.BlockId, st.agent.Agent, name); busy != nil {
			return *busy
		}
		return Outcome{
			Status:    StatusNeedConfirm,
			Agent:     st.agent.Agent,
			AgentName: name,
			Message:   fmt.Sprintf("Restart %s with MoltenTerm's integration? The conversation resumes.", name),
		}
	}
	if st.busy != "" {
		return *busyOutcome(st.busy)
	}
	return Outcome{Status: StatusReady, Message: "The shell is at its prompt: it is replaced in the same folder."}
}

// Run updates the terminal: an idle shell is replaced; a confirmed, idle agent is restarted on its session.
func (u *Updater) Run(ctx context.Context, req Request) Outcome {
	if !u.begin(req.BlockId) {
		return Outcome{Status: StatusBusy, Message: "This terminal is already being updated."}
	}
	defer u.end(req.BlockId)
	st, out := u.inspect(ctx, req.BlockId)
	if out != nil {
		return *out
	}
	// The list the window acted on may be older than this terminal: a current shell is never replaced.
	run, hasRun := u.env.AgentRun(req.BlockId)
	if _, outdated := Assess(st.job, false, run, hasRun, u.env.Current); !outdated {
		return Outcome{Status: StatusUpToDate, Message: "This terminal is already up to date."}
	}
	if st.adapter != nil {
		return u.restartAgent(ctx, req, st)
	}
	if st.busy != "" {
		return *busyOutcome(st.busy)
	}
	cwd := logicalCwd(u.env.Cwd(st.shell.Pid), st.block)
	if err := u.env.Replace(ctx, req.BlockId, cwd, TerminalUpdatedNotice); err != nil {
		return Outcome{Status: StatusFailed, Message: fmt.Sprintf("The new shell did not start: %v", err)}
	}
	return Outcome{Status: StatusUpdated, Message: "Terminal updated."}
}

// agentBusy: an agent in a turn or waiting for an answer is never typed into (NFR-CONT-004).
func (u *Updater) agentBusy(blockId string, agent string, name string) *Outcome {
	run, ok := u.env.AgentRun(blockId)
	if !ok || !run.Running || (run.State != molten.AgentStateWorking && run.State != molten.AgentStateWaiting) {
		return nil
	}
	rtn := &Outcome{Status: StatusAgentBusy, Agent: agent, AgentName: name}
	if run.State == molten.AgentStateWaiting {
		rtn.Message = fmt.Sprintf("%s is waiting for your answer: answer it, then update the terminal.", name)
	} else {
		rtn.Message = fmt.Sprintf("%s is working: update the terminal once its turn ends.", name)
	}
	return rtn
}

// ResumeCommand is the command line that starts an agent again on a session: by id when the session is sure, else
// on the agent's most recent session of the folder (guessed). Shared with FR-CONT-010's Resume <previous agent>.
func ResumeCommand(adapter agentcontinuity.AgentAdapter, agent string, session companion.ResumeSession) (string, bool) {
	args := adapter.LastSessionArgs()
	guessed := true
	if session.Sure {
		if id := companion.SessionIdFromPath(agent, session.Path); id != "" {
			if resume, err := adapter.ResumeArgs(id); err == nil {
				args, guessed = resume, false
			}
		}
	}
	return strings.Join(append([]string{adapter.Executable()}, args...), " "), guessed
}

func (u *Updater) restartAgent(ctx context.Context, req Request, st shellState) Outcome {
	agent := st.agent.Agent
	name := st.adapter.Name()
	base := Outcome{Agent: agent, AgentName: name}
	if !req.Confirmed {
		base.Status = StatusNeedConfirm
		base.Message = fmt.Sprintf("Restart %s with MoltenTerm's integration? The conversation resumes.", name)
		return base
	}
	if busy := u.agentBusy(req.BlockId, agent, name); busy != nil {
		return *busy
	}
	cwd := u.env.Cwd(st.agent.Pid)
	if cwd == "" {
		cwd = u.env.Cwd(st.shell.Pid)
	}
	cwd = logicalCwd(cwd, st.block)
	session := u.env.FindSession(req.BlockId, agent, resumeSessionWait)
	command, guessed := ResumeCommand(st.adapter, agent, session)
	switch u.StopAgent(req.BlockId, st.adapter, st.agent, st.shell.Pid) {
	case StopChanged:
		base.Status = StatusBusy
		base.Message = fmt.Sprintf("%s is no longer the program in the foreground: nothing was typed. Update the terminal again.", name)
		return base
	case StopStuck:
		base.Status = StatusAgentStuck
		base.Message = fmt.Sprintf("%s did not exit within %d s and is still running. Exit it yourself, then update the terminal.", name, int(AgentExitTimeout/time.Second))
		return base
	}
	// The agent is gone: anything that holds the terminal now (a program it left in the foreground, a background job)
	// keeps the shell.
	after, out := u.inspect(ctx, req.BlockId)
	if out != nil {
		base.Status = StatusFailed
		base.Message = fmt.Sprintf("%s exited, but the terminal cannot be updated: %s Start it again with: %s", name, out.Message, command)
		base.Command = command
		return base
	}
	if after.adapter != nil || after.busy != "" {
		program := after.busy
		if after.adapter != nil {
			program = after.adapter.Name()
		}
		base.Status = StatusBusy
		base.Program = program
		base.Command = command
		base.Message = fmt.Sprintf("%s exited, but %s now runs in the terminal, so its shell was kept. Finish it, update the terminal, then start %s with: %s", name, program, name, command)
		return base
	}
	prompts, release := u.env.WatchPrompt(req.BlockId)
	defer release()
	// The old shell shows its prompt again once the agent exits: that mark is not the new shell's first prompt.
	u.env.Sleep(oldPromptSettle)
	select {
	case <-prompts:
	default:
	}
	notice := fmt.Sprintf("%s; %s starts again on its session", TerminalUpdatedNotice, name)
	if err := u.env.Replace(ctx, req.BlockId, cwd, notice); err != nil {
		base.Status = StatusFailed
		base.Message = fmt.Sprintf("%s exited but the new shell did not start: %v. Start it again with: %s", name, err, command)
		base.Command = command
		return base
	}
	select {
	case <-prompts:
		// The mark comes from the hook that runs just before the prompt is drawn: text sent at once would be echoed
		// before the line editor starts, then drawn again.
		u.env.Sleep(lineEditorSettle)
	case <-time.After(firstPromptTimeout):
		// Without a prompt, something else may read the terminal (a question of the user's startup files): type nothing.
		base.Status = StatusFailed
		base.Command = command
		base.Message = fmt.Sprintf("The terminal is updated, but its new shell did not show a prompt, so %s was not started. Start it with: %s", name, command)
		return base
	case <-ctx.Done():
		base.Status = StatusFailed
		base.Command = command
		base.Message = fmt.Sprintf("The terminal is updated, but %s was not started. Start it with: %s", name, command)
		return base
	}
	if err := u.env.SendInput(req.BlockId, []byte(command+"\r")); err != nil {
		base.Status = StatusFailed
		base.Message = fmt.Sprintf("The terminal is updated but %s could not be started: %v. Start it with: %s", name, err, command)
		base.Command = command
		return base
	}
	base.Status = StatusUpdated
	base.Command = command
	base.Guessed = guessed
	if guessed {
		base.Message = fmt.Sprintf("Terminal updated. MoltenTerm could not tell which %s session ran here, so %s reopens its most recent one in this folder (%s).", name, name, command)
	} else {
		base.Message = fmt.Sprintf("Terminal updated; %s resumes its session (%s).", name, command)
	}
	return base
}

// What StopAgent did.
const (
	StopExited  = "exited"
	StopChanged = "changed"
	StopStuck   = "stuck"
)

// StopAgent asks an idle agent to exit with its own commands and waits for its process to end; it never signals it.
// First it checks the agent is still the program in the foreground (nothing is typed otherwise), then it sends
// Escape, which answers No to a question the agent may be asking (an agent without hooks looks idle while it asks),
// clears an unsent draft, and types the exit command. Shared with FR-CONT-010.
func (u *Updater) StopAgent(blockId string, adapter agentcontinuity.AgentAdapter, agent molten.AgentProcess, shellPid int32) string {
	exit := adapter.Exit()
	sent, err := u.sendToForegroundAgent(blockId, agent, shellPid, []string{keyEscape, keyClearLine, exit.Command, "\r"})
	if !sent {
		return StopChanged
	}
	if err != nil {
		return StopStuck
	}
	deadline := u.env.Now().Add(AgentExitTimeout)
	for {
		table, err := u.env.ReadTable()
		if err == nil && !table.Same(agent.Pid, agent.StartMs) {
			break
		}
		if !u.env.Now().Before(deadline) {
			return StopStuck
		}
		u.env.Sleep(pollInterval)
	}
	back := u.env.Now().Add(shellBackTimeout)
	for {
		table, err := u.env.ReadTable()
		if (err == nil && !table.Running(shellPid)) || !u.env.Now().Before(back) {
			// The agent is gone; whatever holds the terminal now is checked again by the caller's next step.
			return StopExited
		}
		u.env.Sleep(pollInterval)
	}
}

func inForeground(table *proctree.Table, shellPid int32, pid int32) bool {
	for _, p := range table.Foreground(shellPid) {
		if p.Pid == pid {
			return true
		}
	}
	return false
}
