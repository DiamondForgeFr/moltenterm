// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/creack/pty"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

// Install on a card of the pour (FR-ONB-007 AC-5, #1667): the click is the developer's intent, so it runs the agent's
// official install command. Only the commands of agentInstallCatalog run, looked up by agent id: the window sends an
// id, never a command, and the first-run route admits windows only, so neither an agent nor the network can start an
// install. The command runs in a login shell given the login PATH (LoginPath), in a pseudo-terminal so an installer
// that asks a question (a password, a confirmation) can be answered from the card; Cancel kills its process group. The
// shell is not interactive: the PATH already holds what the interactive rc adds, and an rc's own prompts (ssh-add's
// passphrase) stay out of the install.

// must match frontend/moltenterm-onboarding/onboarding-agent-model.ts
const (
	CliInstallCommand       = "onboardingcliinstall"
	CliInstallStatusCommand = "onboardingcliinstallstatus"
	CliInstallInputCommand  = "onboardingcliinstallinput"
	CliInstallCancelCommand = "onboardingcliinstallcancel"
)

// What a job runs: the install, or the uninstall of the Library's agent page (#1699). One job per agent at a time.
const (
	CliJobInstall   = "install"
	CliJobUninstall = "uninstall"
)

const (
	CliInstallRunning   = "running"
	CliInstallSucceeded = "succeeded"
	CliInstallFailed    = "failed"
	CliInstallCanceled  = "canceled"
)

// TestInstallDirEnv names a folder of fake installers, <agent id>.sh, run in place of the catalog's commands: the
// tests and the background test instances never run a real installer. It is read from wavesrv's own environment,
// which only whoever starts MoltenTerm sets.
const TestInstallDirEnv = "MOLTENTERM_TEST_AGENT_INSTALL_DIR"

const cliInstallOutputMax = 64 * 1024
const cliInstallTermRows = 24
const cliInstallTermCols = 100
const cliInstallInputMax = 4096

// An installer quiet this long after a line it did not end is taken as waiting for an answer: the card opens its
// output with a field to answer it.
var cliInstallQuietWait = 1500 * time.Millisecond

// After the installer exits, how long its output may still drain from the terminal before the terminal closes.
var cliInstallDrainWait = 2 * time.Second

type CliInstallStatus struct {
	Id        string      `json:"id"`
	Kind      string      `json:"kind,omitempty"`
	Command   string      `json:"command,omitempty"`
	State     string      `json:"state,omitempty"`
	Output    string      `json:"output,omitempty"`
	ExitCode  int         `json:"exitcode,omitempty"`
	Error     string      `json:"error,omitempty"`
	ErrorText *uimsg.Text `json:"errortext,omitempty"`
	Waiting   bool        `json:"waiting,omitempty"`
	// An uninstall's ticked settings folders: the ones moved to the trash, and the one that could not move.
	Trashed        []string    `json:"trashed,omitempty"`
	TrashFailed    string      `json:"trashfailed,omitempty"`
	TrashErrorText *uimsg.Text `json:"trasherrortext,omitempty"`
}

type cliInstallRequest struct {
	Id   string `json:"id"`
	Text string `json:"text,omitempty"`
}

type cliInstallJob struct {
	lock       sync.Mutex
	id         string
	kind       string
	command    string
	state      string
	output     []byte
	exitCode   int
	errText    string
	lastOutput time.Time
	canceled   bool
	pid        int
	term       pty.Pty
	done       chan struct{}
	// runs once the command succeeded, before the job says so (the uninstall's trash)
	after    func() ([]string, *trashFailure)
	trashed  []string
	trashErr *trashFailure
}

var cliJobsLock sync.Mutex
var cliJobs = map[string]*cliInstallJob{}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// installCommands is the catalog's commands for the agent, or the fake installer when TestInstallDirEnv is set.
func installCommands(id string) []string {
	if dir := os.Getenv(TestInstallDirEnv); dir != "" {
		script := filepath.Join(dir, id+".sh")
		if _, err := os.Stat(script); err != nil {
			return nil
		}
		return []string{"sh " + shellQuote(script)}
	}
	return agentInstallCatalog[id].Commands
}

func getCliJob(id string) *cliInstallJob {
	cliJobsLock.Lock()
	defer cliJobsLock.Unlock()
	return cliJobs[id]
}

// putCliJob records job unless one for the same agent still runs, which it returns instead.
func putCliJob(job *cliInstallJob) *cliInstallJob {
	cliJobsLock.Lock()
	defer cliJobsLock.Unlock()
	if old := cliJobs[job.id]; old != nil && old.status().State == CliInstallRunning {
		return old
	}
	cliJobs[job.id] = job
	return job
}

func (job *cliInstallJob) status() CliInstallStatus {
	job.lock.Lock()
	defer job.lock.Unlock()
	rtn := CliInstallStatus{
		Id:       job.id,
		Kind:     job.kind,
		Command:  job.command,
		State:    job.state,
		Output:   string(job.output),
		ExitCode: job.exitCode,
		Error:    job.errText,
	}
	if job.errText != "" {
		rtn.ErrorText = uimsg.Make("onboarding.installNotRun", "detail", job.errText)
	}
	rtn.Trashed = job.trashed
	if job.trashErr != nil {
		rtn.TrashFailed = job.trashErr.Path
		rtn.TrashErrorText = uimsg.Make("onboarding.trashFailed", "path", job.trashErr.Path, "detail", job.trashErr.Err.Error())
	}
	if job.state == CliInstallRunning && len(job.output) > 0 && job.output[len(job.output)-1] != '\n' {
		rtn.Waiting = time.Since(job.lastOutput) >= cliInstallQuietWait
	}
	return rtn
}

func (job *cliInstallJob) appendOutput(chunk []byte) {
	job.lock.Lock()
	defer job.lock.Unlock()
	job.output = append(job.output, chunk...)
	if over := len(job.output) - cliInstallOutputMax; over > 0 {
		cut := job.output[over:]
		for len(cut) > 0 && !utf8.RuneStart(cut[0]) {
			cut = cut[1:]
		}
		job.output = append([]byte(nil), cut...)
	}
	job.lastOutput = time.Now()
}

func (job *cliInstallJob) finish(waitErr error) {
	job.lock.Lock()
	defer job.lock.Unlock()
	job.term = nil
	switch {
	case job.canceled:
		job.state = CliInstallCanceled
	case waitErr == nil:
		job.state = CliInstallSucceeded
	default:
		job.state = CliInstallFailed
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			job.exitCode = exitErr.ExitCode()
		} else {
			job.errText = waitErr.Error()
		}
	}
}

func (job *cliInstallJob) isCanceled() bool {
	job.lock.Lock()
	defer job.lock.Unlock()
	return job.canceled
}

func (job *cliInstallJob) setTrashed(moved []string, failure *trashFailure) {
	job.lock.Lock()
	defer job.lock.Unlock()
	job.trashed = moved
	job.trashErr = failure
}

func (job *cliInstallJob) terminal() pty.Pty {
	job.lock.Lock()
	defer job.lock.Unlock()
	return job.term
}

// markCanceled returns the process to kill, 0 when the job no longer runs.
func (job *cliInstallJob) markCanceled() int {
	job.lock.Lock()
	defer job.lock.Unlock()
	if job.state != CliInstallRunning {
		return 0
	}
	job.canceled = true
	return job.pid
}

func (job *cliInstallJob) setProcess(pid int, term pty.Pty) {
	job.lock.Lock()
	defer job.lock.Unlock()
	job.pid = pid
	job.term = term
}

// StartCliInstall runs the agent's first catalog command, or returns the install of that agent already running.
func StartCliInstall(id string) (CliInstallStatus, error) {
	profile, err := molten.FindAgent(id)
	if err != nil {
		return CliInstallStatus{}, err
	}
	commands := installCommands(profile.Id)
	if len(commands) == 0 {
		return CliInstallStatus{}, uimsg.Errorf(uimsg.Make("onboarding.noInstallCommand", "agent", profile.Name),
			"MoltenTerm has no install command for %s", profile.Name)
	}
	if runtime.GOOS == "windows" {
		return CliInstallStatus{}, uimsg.Errorf(uimsg.Make("onboarding.installUnsupported", "agent", profile.Name),
			"installing %s from MoltenTerm is not available on this system", profile.Name)
	}
	return startCliJob(profile.Id, CliJobInstall, commands[0], nil)
}

// startCliJob runs a catalog command for the agent, or returns the job of that agent already running: an install and
// an uninstall of one agent never run together.
func startCliJob(id string, kind string, command string, after func() ([]string, *trashFailure)) (CliInstallStatus, error) {
	job := &cliInstallJob{
		id:         id,
		kind:       kind,
		command:    command,
		after:      after,
		state:      CliInstallRunning,
		lastOutput: time.Now(),
		done:       make(chan struct{}),
	}
	if kept := putCliJob(job); kept != job {
		return kept.status(), nil
	}
	if err := job.start(); err != nil {
		job.finish(err)
		close(job.done)
		return job.status(), nil
	}
	return job.status(), nil
}

func (job *cliInstallJob) start() error {
	shell := shellutil.DetectLocalShellPath()
	cmd := exec.Command(shell, "-l", "-c", job.command)
	cmd.Env = append(os.Environ(), "PATH="+molten.LoginPath(), "TERM=dumb", "NO_COLOR=1")
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	term, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: cliInstallTermRows, Cols: cliInstallTermCols})
	if err != nil {
		return fmt.Errorf("starting the install: %w", err)
	}
	job.setProcess(cmd.Process.Pid, term)
	log.Printf("molten: %s of %s with %q (pid %d)\n", job.kind, job.id, job.command, cmd.Process.Pid)
	drained := make(chan struct{})
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:onboarding:cliinstall:read", recover())
		}()
		defer close(drained)
		buf := make([]byte, 4096)
		for {
			n, err := term.Read(buf)
			if n > 0 {
				job.appendOutput(buf[:n])
			}
			// EOF, or EIO once the installer and its children closed the terminal
			if err != nil {
				return
			}
		}
	}()
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:onboarding:cliinstall:wait", recover())
		}()
		waitErr := cmd.Wait()
		select {
		case <-drained:
		case <-time.After(cliInstallDrainWait):
		}
		term.Close()
		if waitErr == nil && job.after != nil && !job.isCanceled() {
			job.setTrashed(job.after())
		}
		job.finish(waitErr)
		close(job.done)
		log.Printf("molten: %s of %s ended: %v\n", job.kind, job.id, waitErr)
	}()
	return nil
}

func CliInstallStatusOf(id string) CliInstallStatus {
	job := getCliJob(id)
	if job == nil {
		return CliInstallStatus{Id: id}
	}
	return job.status()
}

// SendCliInstallInput types the developer's answer into the installer's terminal, Enter included.
func SendCliInstallInput(id string, text string) (CliInstallStatus, error) {
	job := getCliJob(id)
	if job == nil {
		return CliInstallStatus{Id: id}, fmt.Errorf("no install of %s is running", id)
	}
	if len(text) > cliInstallInputMax {
		return job.status(), fmt.Errorf("answer too long")
	}
	term := job.terminal()
	if term == nil {
		return job.status(), fmt.Errorf("the install of %s has ended", id)
	}
	if _, err := term.Write([]byte(text + "\r")); err != nil {
		return job.status(), err
	}
	return job.status(), nil
}

// CancelCliInstall kills the installer's process group and waits for it to end.
func CancelCliInstall(ctx context.Context, id string) (CliInstallStatus, error) {
	job := getCliJob(id)
	if job == nil {
		return CliInstallStatus{Id: id}, nil
	}
	pid := job.markCanceled()
	if pid == 0 {
		return job.status(), nil
	}
	if err := killProcessGroup(pid); err != nil {
		log.Printf("molten: canceling the install of %s: %v\n", id, err)
	}
	select {
	case <-job.done:
	case <-ctx.Done():
	}
	return job.status(), nil
}

func readCliInstallRequest(data any) (cliInstallRequest, error) {
	var req cliInstallRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return req, err
	}
	if req.Id == "" {
		return req, fmt.Errorf("no agent id")
	}
	return req, nil
}

func handleCliInstall(ctx context.Context, source string, data any) (any, error) {
	req, err := readCliInstallRequest(data)
	if err != nil {
		return nil, err
	}
	return StartCliInstall(req.Id)
}

func handleCliInstallStatus(ctx context.Context, source string, data any) (any, error) {
	req, err := readCliInstallRequest(data)
	if err != nil {
		return nil, err
	}
	return CliInstallStatusOf(req.Id), nil
}

func handleCliInstallInput(ctx context.Context, source string, data any) (any, error) {
	req, err := readCliInstallRequest(data)
	if err != nil {
		return nil, err
	}
	return SendCliInstallInput(req.Id, req.Text)
}

func handleCliInstallCancel(ctx context.Context, source string, data any) (any, error) {
	req, err := readCliInstallRequest(data)
	if err != nil {
		return nil, err
	}
	return CancelCliInstall(ctx, req.Id)
}

func init() {
	HandleCommand(CliInstallCommand, handleCliInstall)
	HandleCommand(CliInstallStatusCommand, handleCliInstallStatus)
	HandleCommand(CliInstallInputCommand, handleCliInstallInput)
	HandleCommand(CliInstallCancelCommand, handleCliInstallCancel)
}
