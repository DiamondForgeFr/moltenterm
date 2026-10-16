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
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
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

// restartTexts words an agent restart for the action that asked for it: Update terminal, or the Sessions view's
// Restart with current settings (restart.go).
type restartTexts struct {
	// restart: Restart with current settings, which picks its own codes (pick).
	restart bool
	notice  string
	// again: how to retry, as a sentence start and inside a sentence.
	again      string
	againLower string
	done       string
	doneStatus string
}

var updateTexts = restartTexts{
	notice:     TerminalUpdatedNotice,
	again:      "Update the terminal",
	againLower: "update the terminal",
	done:       "Terminal updated.",
	doneStatus: StatusUpdated,
}

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
	// EffortLevels: the effort levels an agent takes for a model, in its order (#549); EffortKeysRemapped: the user
	// moved the agent's effort keys; ClearEffort: forget a run's effort until its agent reports it again.
	EffortLevels       func(agent string, model string) []string
	EffortKeysRemapped func(agent string) bool
	ClearEffort        func(blockId string, agent string)
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
		return shellState{}, outcomeUnreadable(err)
	}
	isCommand := block != nil && block.Meta.GetString(waveobj.MetaKey_Cmd, "") != ""
	if !IsLocalShellJob(job, isCommand) {
		return shellState{}, outcomeNotLocal()
	}
	table, err := u.env.ReadTable()
	if err != nil || table == nil {
		return shellState{}, outcomeCannotSee()
	}
	pid := int32(job.CmdPid)
	if !table.Same(pid, job.CmdStartTs) {
		return shellState{}, outcomeShellEnded()
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
		Status:      StatusBusy,
		Program:     program,
		Message:     fmt.Sprintf("Finish or stop %s first: updating the terminal replaces its shell.", program),
		MessageText: uimsg.Make("termupdate.update.programbusy", "program", program),
	}
}

func needConfirmOutcome(agent string, name string) Outcome {
	return Outcome{
		Status:      StatusNeedConfirm,
		Agent:       agent,
		AgentName:   name,
		Message:     fmt.Sprintf("Restart %s with MoltenTerm's integration? The conversation resumes.", name),
		MessageText: uimsg.Make("termupdate.update.needconfirm", "agent", name),
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
		if busy := u.agentBusy(req.BlockId, st.agent.Agent, name, updateTexts); busy != nil {
			return *busy
		}
		return needConfirmOutcome(st.agent.Agent, name)
	}
	if st.busy != "" {
		return *busyOutcome(st.busy)
	}
	return Outcome{Status: StatusReady, MessageText: uimsg.Make("termupdate.update.ready"),
		Message: "The shell is at its prompt: it is replaced in the same folder."}
}

// Run updates the terminal: an idle shell is replaced; a confirmed, idle agent is restarted on its session.
func (u *Updater) Run(ctx context.Context, req Request) Outcome {
	if !u.begin(req.BlockId) {
		return Outcome{Status: StatusBusy, MessageText: uimsg.Make("termupdate.update.already"), Message: "This terminal is already being updated."}
	}
	defer u.end(req.BlockId)
	st, out := u.inspect(ctx, req.BlockId)
	if out != nil {
		return *out
	}
	// The list the window acted on may be older than this terminal: a current shell is never replaced.
	run, hasRun := u.env.AgentRun(req.BlockId)
	if _, outdated := Assess(st.job, false, run, hasRun, u.env.Current); !outdated {
		return Outcome{Status: StatusUpToDate, MessageText: uimsg.Make("termupdate.update.uptodate"), Message: "This terminal is already up to date."}
	}
	if st.adapter != nil {
		if !req.Confirmed {
			return needConfirmOutcome(st.agent.Agent, st.adapter.Name())
		}
		return u.restartAgent(ctx, req.BlockId, st, updateTexts)
	}
	if st.busy != "" {
		return *busyOutcome(st.busy)
	}
	cwd := logicalCwd(u.env.Cwd(st.shell.Pid), st.block)
	if err := u.env.Replace(ctx, req.BlockId, cwd, TerminalUpdatedNotice); err != nil {
		return Outcome{Status: StatusFailed, MessageText: uimsg.Make("termupdate.update.shellfailed", "detail", uimsg.Detail(err)),
			Message: fmt.Sprintf("The new shell did not start: %v", err)}
	}
	return Outcome{Status: StatusUpdated, MessageText: uimsg.Make("termupdate.update.updated"), Message: "Terminal updated."}
}

// agentBusy: an agent in a turn or waiting for an answer is never typed into (NFR-CONT-004).
func (u *Updater) agentBusy(blockId string, agent string, name string, texts restartTexts) *Outcome {
	run, ok := u.env.AgentRun(blockId)
	if !ok || !run.Running || (run.State != molten.AgentStateWorking && run.State != molten.AgentStateWaiting) {
		return nil
	}
	rtn := &Outcome{Status: StatusAgentBusy, Agent: agent, AgentName: name}
	if run.State == molten.AgentStateWaiting {
		rtn.Message = fmt.Sprintf("%s is waiting for your answer: answer it, then %s.", name, texts.againLower)
		rtn.MessageText = texts.pick(uimsg.Make("termupdate.update.agentwaiting", "agent", name),
			uimsg.Make("termupdate.restart.agentwaiting", "agent", name))
	} else {
		rtn.Message = fmt.Sprintf("%s is working: %s once its turn ends.", name, texts.againLower)
		rtn.MessageText = texts.pick(uimsg.Make("termupdate.update.agentworking", "agent", name),
			uimsg.Make("termupdate.restart.agentworking", "agent", name))
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

// restartAgent ends an idle agent with its own exit command and starts it again on its session in a fresh shell of
// the same pane. extraArgs go after the resume arguments (a permission mode, already checked by the caller).
func (u *Updater) restartAgent(ctx context.Context, blockId string, st shellState, texts restartTexts, extraArgs ...string) Outcome {
	agent := st.agent.Agent
	name := st.adapter.Name()
	base := Outcome{Agent: agent, AgentName: name}
	if busy := u.agentBusy(blockId, agent, name, texts); busy != nil {
		return *busy
	}
	cwd := u.env.Cwd(st.agent.Pid)
	if cwd == "" {
		cwd = u.env.Cwd(st.shell.Pid)
	}
	cwd = logicalCwd(cwd, st.block)
	session := u.env.FindSession(blockId, agent, resumeSessionWait)
	command, guessed := ResumeCommand(st.adapter, agent, session)
	if len(extraArgs) > 0 {
		command += " " + strings.Join(extraArgs, " ")
	}
	switch u.StopAgent(blockId, st.adapter, st.agent, st.shell.Pid) {
	case StopChanged:
		base.Status = StatusBusy
		base.Message = fmt.Sprintf("%s is no longer the program in the foreground: nothing was typed. %s again.", name, texts.again)
		base.MessageText = texts.pick(uimsg.Make("termupdate.update.agentgone", "agent", name),
			uimsg.Make("termupdate.restart.agentgone", "agent", name))
		return base
	case StopStuck:
		seconds := fmt.Sprintf("%d", int(AgentExitTimeout/time.Second))
		base.Status = StatusAgentStuck
		base.Message = fmt.Sprintf("%s did not exit within %s s and is still running. Exit it yourself, then %s.", name, seconds, texts.againLower)
		base.MessageText = texts.pick(uimsg.Make("termupdate.update.agentstuck", "agent", name, "seconds", seconds),
			uimsg.Make("termupdate.restart.agentstuck", "agent", name, "seconds", seconds))
		return base
	case StopNoInput:
		base.Status = StatusFailed
		base.Message = fmt.Sprintf("MoltenTerm could not type in this terminal, so %s kept running. Show its pane once, then %s.", name, texts.againLower)
		base.MessageText = texts.pick(uimsg.Make("termupdate.update.noinput", "agent", name),
			uimsg.Make("termupdate.restart.noinput", "agent", name))
		return base
	}
	// The agent is gone: anything that holds the terminal now (a program it left in the foreground, a background job)
	// keeps the shell.
	after, out := u.inspect(ctx, blockId)
	if out != nil {
		base.Status = StatusFailed
		base.Message = fmt.Sprintf("%s exited, but the terminal cannot be updated: %s Start it again with: %s", name, out.Message, command)
		base.MessageText = uimsg.Make("termupdate.update.exitedunavailable", "agent", name, "detail", out.Message, "command", command)
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
		base.Message = fmt.Sprintf("%s exited, but %s now runs in the terminal, so its shell was kept. Finish it, %s, then start %s with: %s", name, program, texts.againLower, name, command)
		base.MessageText = texts.pick(uimsg.Make("termupdate.update.shellkept", "agent", name, "program", program, "command", command),
			uimsg.Make("termupdate.restart.shellkept", "agent", name, "program", program, "command", command))
		return base
	}
	prompts, release := u.env.WatchPrompt(blockId)
	defer release()
	// The old shell shows its prompt again once the agent exits: that mark is not the new shell's first prompt.
	u.env.Sleep(oldPromptSettle)
	select {
	case <-prompts:
	default:
	}
	notice := fmt.Sprintf("%s; %s starts again on its session", texts.notice, name)
	if err := u.env.Replace(ctx, blockId, cwd, notice); err != nil {
		base.Status = StatusFailed
		base.Message = fmt.Sprintf("%s exited but the new shell did not start: %v. Start it again with: %s", name, err, command)
		base.MessageText = uimsg.Make("termupdate.update.exitedshellfailed", "agent", name, "detail", uimsg.Detail(err), "command", command)
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
		base.Message = fmt.Sprintf("The new shell did not show a prompt, so %s was not started. Start it with: %s", name, command)
		base.MessageText = uimsg.Make("termupdate.update.noprompt", "agent", name, "command", command)
		return base
	case <-ctx.Done():
		base.Status = StatusFailed
		base.Command = command
		base.Message = fmt.Sprintf("The new shell started, but %s was not. Start it with: %s", name, command)
		base.MessageText = uimsg.Make("termupdate.update.notstarted", "agent", name, "command", command)
		return base
	}
	if err := u.env.SendInput(blockId, []byte(command+"\r")); err != nil {
		base.Status = StatusFailed
		base.Message = fmt.Sprintf("The new shell started but %s could not be: %v. Start it with: %s", name, err, command)
		base.MessageText = uimsg.Make("termupdate.update.startfailed", "agent", name, "detail", uimsg.Detail(err), "command", command)
		base.Command = command
		return base
	}
	base.Status = texts.doneStatus
	base.Command = command
	base.Guessed = guessed
	if guessed {
		base.Message = fmt.Sprintf("%s MoltenTerm could not tell which %s session ran here, so %s reopens its most recent one in this folder (%s).", texts.done, name, name, command)
		base.MessageText = texts.pick(uimsg.Make("termupdate.update.doneguessed", "agent", name, "command", command),
			uimsg.Make("termupdate.restart.doneguessed", "agent", name, "command", command))
	} else {
		base.Message = fmt.Sprintf("%s %s resumes its session (%s).", texts.done, name, command)
		base.MessageText = texts.pick(uimsg.Make("termupdate.update.done", "agent", name, "command", command),
			uimsg.Make("termupdate.restart.done", "agent", name, "command", command))
	}
	return base
}

// What StopAgent did.
const (
	StopExited  = "exited"
	StopChanged = "changed"
	StopStuck   = "stuck"
	// StopNoInput: the terminal took no input (its pane was not opened since MoltenTerm started, so no controller
	// runs for it): the agent was never asked to exit.
	StopNoInput = "noinput"
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
		return StopNoInput
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
