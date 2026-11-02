// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The end of a sign-in run from the card (FR-ONB-007 AC-5b, #1733). Several agents keep their sign-in in the system
// keychain, where no credentials file shows it, so the window reports the end of the sign-in terminal and wavesrv
// checks it itself: the block must be that agent's sign-in terminal and its command must have ended with 0. Then the
// vendor's documented status command, where there is one, has the last word; elsewhere the successful exit is the
// proof. A confirmed sign-in is recorded per agent in the data folder and ListAgents reads it back. The status
// command runs only here, after a sign-in the user started: listing the agents never starts one.

// must match frontend/moltenterm-onboarding/onboarding-agent-model.ts
const AgentSignInDoneCommand = "onboardingagentsignindone"

const (
	SignInCheckedByStatus = "status"
	SignInCheckedByExit   = "exit"
)

// The status commands answer from what they keep locally; Cursor's may ask its server.
const signInStatusTimeout = 15 * time.Second

const signInStatusOutputMax = 64 * 1024

// Cursor documents no exit code for agent status: an output saying the user is out counts as not signed in, whatever
// the code.
var signInStatusOutRe = regexp.MustCompile(`(?i)\bnot\s+(logged|signed)\s+in\b|\bnot\s+authenticated\b|\bunauthenticated\b|\blogged\s+out\b`)

// SignInExit is the sign-in terminal's command as its controller knows it.
type SignInExit struct {
	Ended    bool
	ExitCode int
}

// The block controllers live above this package (pkg/blockcontroller imports it): they hand their reader in at init.
var signInExitLock sync.Mutex
var signInExitFn func(blockId string) (SignInExit, bool)

// UseSignInExit sets how the end of a block's command is read; pkg/blockcontroller calls it at init.
func UseSignInExit(fn func(blockId string) (SignInExit, bool)) {
	signInExitLock.Lock()
	defer signInExitLock.Unlock()
	signInExitFn = fn
}

func getSignInExitFn() func(blockId string) (SignInExit, bool) {
	signInExitLock.Lock()
	defer signInExitLock.Unlock()
	return signInExitFn
}

type agentSignInDoneRequest struct {
	Id      string `json:"id"`
	BlockId string `json:"blockid"`
}

type AgentSignInDoneResult struct {
	// The command ended and its exit code; false while it runs or when its controller is gone.
	Ended    bool `json:"ended"`
	ExitCode int  `json:"exitcode"`
	SignedIn bool `json:"signedin"`
	// SignInCheckedByStatus or SignInCheckedByExit, when signed in.
	CheckedBy string `json:"checkedby,omitempty"`
}

type signInRecord struct {
	SignedInAt string `json:"signedinat"`
	CheckedBy  string `json:"checkedby"`
}

func signInRecordPath(dataDir string, id string) string {
	return filepath.Join(dataDir, "molten", "agent-signin", id+".json")
}

// signInRecorded tells whether a sign-in run from the card was confirmed for the agent.
func signInRecorded(dataDir string, id string) bool {
	if dataDir == "" || id == "" {
		return false
	}
	info, err := os.Stat(signInRecordPath(dataDir, id))
	return err == nil && info.Mode().IsRegular()
}

func recordSignIn(dataDir string, id string, checkedBy string) error {
	path := signInRecordPath(dataDir, id)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(signInRecord{SignedInAt: time.Now().UTC().Format(time.RFC3339), CheckedBy: checkedBy})
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

func clearSignIn(dataDir string, id string) error {
	err := os.Remove(signInRecordPath(dataDir, id))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// signInStatusCmd is the vendor's status command for the agent in the login PATH, its fake <id>-status.sh when
// TestSignInDirEnv is set, or nil when there is none to run (none documented, or no fake: a test never starts a real
// agent).
func signInStatusCmd(ctx context.Context, profile molten.AgentProfile, pathList string) (*exec.Cmd, error) {
	args := agentInstallCatalog[profile.Id].SignIn.StatusArgs
	if len(args) == 0 {
		return nil, nil
	}
	var cmd *exec.Cmd
	if dir := os.Getenv(TestSignInDirEnv); dir != "" {
		script := filepath.Join(dir, profile.Id+"-status.sh")
		if _, err := os.Stat(script); err != nil {
			return nil, nil
		}
		cmd = exec.CommandContext(ctx, "sh", script)
	} else {
		exe := molten.LookPathIn(profile.Executable, pathList)
		if exe == "" {
			return nil, fmt.Errorf("%s is not in the login shell's PATH", profile.Executable)
		}
		cmd = exec.CommandContext(ctx, exe, args...)
	}
	env := os.Environ()
	if pathList != "" {
		env = append(env, "PATH="+pathList)
	}
	cmd.Env = env
	return cmd, nil
}

// statusSaysSignedIn reads the status command's answer: exit code 0 and no output saying the user is out.
func statusSaysSignedIn(exitErr error, output string) bool {
	return exitErr == nil && !signInStatusOutRe.MatchString(output)
}

// runSignInStatus asks the agent's status command; ran is false when there is none to run.
func runSignInStatus(profile molten.AgentProfile, pathList string) (ran bool, signedIn bool, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), signInStatusTimeout)
	defer cancel()
	cmd, err := signInStatusCmd(ctx, profile, pathList)
	if err != nil || cmd == nil {
		return false, false, err
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	runErr := cmd.Run()
	if ctx.Err() != nil {
		return true, false, fmt.Errorf("%s status did not answer in time", profile.Name)
	}
	output := out.String()
	if len(output) > signInStatusOutputMax {
		output = output[:signInStatusOutputMax]
	}
	return true, statusSaysSignedIn(runErr, output), nil
}

// CheckSignInDone checks the end of the agent's sign-in terminal and records a confirmed sign-in.
func CheckSignInDone(ctx context.Context, env molten.AgentEnv, id string, blockId string, pathList string) (AgentSignInDoneResult, error) {
	var rtn AgentSignInDoneResult
	profile, err := molten.FindAgent(id)
	if err != nil {
		return rtn, err
	}
	if signInEntry(profile) == nil {
		return rtn, fmt.Errorf("%s has no sign-in in MoltenTerm's catalog", profile.Name)
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return rtn, err
	}
	if block == nil || block.Meta.GetString(SignInBlockMetaKey, "") != profile.Id {
		return rtn, fmt.Errorf("block %s is not %s's sign-in terminal", blockId, profile.Name)
	}
	return checkSignInExit(env, profile, blockId, pathList)
}

func checkSignInExit(env molten.AgentEnv, profile molten.AgentProfile, blockId string, pathList string) (AgentSignInDoneResult, error) {
	var rtn AgentSignInDoneResult
	fn := getSignInExitFn()
	if fn == nil {
		return rtn, nil
	}
	exit, ok := fn(blockId)
	if !ok || !exit.Ended {
		return rtn, nil
	}
	rtn.Ended = true
	rtn.ExitCode = exit.ExitCode
	if exit.ExitCode != 0 {
		return rtn, nil
	}
	ran, statusSignedIn, err := runSignInStatus(profile, pathList)
	if err != nil {
		return rtn, err
	}
	if ran && !statusSignedIn {
		return rtn, clearSignIn(env.DataDir, profile.Id)
	}
	rtn.CheckedBy = SignInCheckedByExit
	if ran {
		rtn.CheckedBy = SignInCheckedByStatus
	}
	if err := recordSignIn(env.DataDir, profile.Id, rtn.CheckedBy); err != nil {
		return rtn, err
	}
	rtn.SignedIn = true
	return rtn, nil
}

func handleAgentSignInDone(ctx context.Context, source string, data any) (any, error) {
	var req agentSignInDoneRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.BlockId) == "" {
		return nil, fmt.Errorf("no sign-in terminal named")
	}
	env, err := agentEnv()
	if err != nil {
		return nil, err
	}
	return CheckSignInDone(ctx, env, req.Id, req.BlockId, molten.LoginPath())
}

func init() {
	HandleCommand(AgentSignInDoneCommand, handleAgentSignInDone)
}
