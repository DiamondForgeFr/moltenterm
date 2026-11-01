// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Sign in on an agent's card (FR-ONB-007 AC-5b, #1723): most agents sign in from their own CLI, so the card opens a
// terminal panel running the procedure the vendor documents. The window sends the agent's id; wavesrv builds the
// command from agentInstallCatalog and answers the terminal's block meta, which the window creates in its workspace.
// Like Install, the route answers windows only, so neither an agent nor the network can start a sign-in, and no
// command text comes from the window: the one line it sends is printed above the command, quoted, never run.

// must match frontend/moltenterm-onboarding/onboarding-agent-model.ts
const AgentSignInCommand = "onboardingagentsignin"

// How an agent signs in from its CLI.
const (
	// a shell command signs in (codex login), then ends
	SignInKindCommand = "command"
	// the agent starts and the user types Slash in it (/login)
	SignInKindSlash = "slash"
	// the agent asks for a sign-in when it starts without one
	SignInKindFirstRun = "firstrun"
)

// What the sign-in does, for the card's one line.
const (
	SignInOpensBrowser      = "browser"
	SignInOpensDevice       = "device"
	SignInOpensKey          = "key"
	SignInOpensBrowserOrKey = "browserorkey"
)

// The day every procedure of the catalog was checked on its sources.
const SignInCheckedOn = "2026-11-01"

// SignInBlockMetaKey marks the sign-in terminal with its agent's id.
const SignInBlockMetaKey = "molten:agentsignin"

// TestSignInDirEnv names a folder of fake sign-ins, <agent id>.sh, run in place of the agents' CLIs: the tests and
// the background test instances never start a real agent. Read from wavesrv's own environment, as TestInstallDirEnv.
const TestSignInDirEnv = "MOLTENTERM_TEST_AGENT_SIGNIN_DIR"

const signInNoteMax = 300

type agentSignIn struct {
	Kind string
	// after the executable; none starts the agent itself
	Args  []string
	Slash string
	Opens string
	// the vendor's pages the procedure comes from
	Sources []string
}

// AgentSignIn is what the card shows: Command is the line the terminal runs, without the fake of the tests.
type AgentSignIn struct {
	Kind      string   `json:"kind"`
	Command   string   `json:"command"`
	Slash     string   `json:"slash,omitempty"`
	Opens     string   `json:"opens,omitempty"`
	CheckedOn string   `json:"checkedon"`
	Sources   []string `json:"sources,omitempty"`
}

type agentSignInRequest struct {
	Id string `json:"id"`
	// the translated line printed above the command
	Note string `json:"note,omitempty"`
}

type AgentSignInResult struct {
	Meta waveobj.MetaMapType `json:"meta"`
}

func signInCommandLine(executable string, args []string) string {
	parts := []string{executable}
	for _, a := range args {
		parts = append(parts, utilfn.ShellQuote(a, false, -1))
	}
	return strings.Join(parts, " ")
}

func signInEntry(profile molten.AgentProfile) *AgentSignIn {
	s := agentInstallCatalog[profile.Id].SignIn
	if s.Kind == "" || profile.Executable == "" {
		return nil
	}
	return &AgentSignIn{
		Kind:      s.Kind,
		Command:   signInCommandLine(profile.Executable, s.Args),
		Slash:     s.Slash,
		Opens:     s.Opens,
		CheckedOn: SignInCheckedOn,
		Sources:   s.Sources,
	}
}

// signInLine is the catalog's procedure for the agent, or its fake when TestSignInDirEnv is set.
func signInLine(id string) (string, error) {
	profile, err := molten.FindAgent(id)
	if err != nil {
		return "", err
	}
	entry := signInEntry(profile)
	if entry == nil {
		return "", fmt.Errorf("%s has no sign-in in MoltenTerm's catalog", profile.Name)
	}
	if dir := os.Getenv(TestSignInDirEnv); dir != "" {
		script := filepath.Join(dir, id+".sh")
		if _, err := os.Stat(script); err != nil {
			return "", fmt.Errorf("no fake sign-in for %s in %s", id, dir)
		}
		return "sh " + shellQuote(script), nil
	}
	return entry.Command, nil
}

// cleanNote keeps the note one printable line.
func cleanNote(note string) string {
	note = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, note)
	note = strings.TrimSpace(note)
	if r := []rune(note); len(r) > signInNoteMax {
		note = string(r[:signInNoteMax])
	}
	return note
}

// SignInBlockMeta is the sign-in terminal: a command block, kept open when the command ends so its last words stay
// readable, in the login shell's PATH where the detection found the agent.
func SignInBlockMeta(id string, note string, pathList string) (waveobj.MetaMapType, error) {
	line, err := signInLine(id)
	if err != nil {
		return nil, err
	}
	if note = cleanNote(note); note != "" && runtime.GOOS != "windows" {
		line = "printf '%s\\n\\n' " + shellQuote(note) + "; " + line
	}
	meta := waveobj.MetaMapType{
		waveobj.MetaKey_View:           "term",
		waveobj.MetaKey_Controller:     "cmd",
		waveobj.MetaKey_Cmd:            line,
		waveobj.MetaKey_CmdCloseOnExit: false,
		// Runs on the click only: a panel kept across a restart never starts the sign-in again by itself.
		waveobj.MetaKey_CmdRunOnce: true,
		SignInBlockMetaKey:         id,
	}
	if pathList != "" {
		meta[waveobj.MetaKey_CmdEnv] = map[string]any{"PATH": pathList}
	}
	return meta, nil
}

func handleAgentSignIn(ctx context.Context, source string, data any) (any, error) {
	var req agentSignInRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	meta, err := SignInBlockMeta(req.Id, req.Note, molten.LoginPath())
	if err != nil {
		return nil, err
	}
	return AgentSignInResult{Meta: meta}, nil
}

func init() {
	HandleCommand(AgentSignInCommand, handleAgentSignIn)
}
