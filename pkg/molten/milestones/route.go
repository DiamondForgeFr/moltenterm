// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package milestones

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentchoice"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/spawns"
	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	// A milestone's tickets with their bodies stay well under this; more is no answer of the forge.
	maxGhOutput = 8 << 20
	dataDirName = "milestones"
	storeName   = "sentences.json"
	// The agent runs in this empty folder of MoltenTerm's own, never in a project's.
	runDirName        = "run"
	clientReadTimeout = 5 * time.Second
)

func dataDir() string {
	return filepath.Join(wavebase.GetWaveDataDir(), "molten", dataDirName)
}

// ghProgram finds the user's gh: wavesrv's PATH first, else the login shell's (one opened from the desktop has a bare
// PATH).
func ghProgram() (string, string) {
	if path, err := exec.LookPath("gh"); err == nil {
		return path, ""
	}
	loginPath := molten.LoginPath()
	return molten.LookPathIn("gh", loginPath), loginPath
}

func liveGh(ctx context.Context, dir string, args ...string) ([]byte, error) {
	program, loginPath := ghProgram()
	if program == "" {
		return nil, fmt.Errorf("gh is not installed")
	}
	cmd := spawns.Command(ctx, program, args...)
	cmd.Dir = dir
	env := os.Environ()
	if loginPath != "" {
		env = append(env, "PATH="+loginPath)
	}
	// Nothing may wait for a prompt: wavesrv has no terminal.
	cmd.Env = append(env, "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1", "GIT_TERMINAL_PROMPT=0")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if lines := strings.Split(msg, "\n"); msg != "" {
			msg = strings.TrimSpace(lines[len(lines)-1])
		}
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("gh %s: %s", args[0], cutRunes(msg, 300))
	}
	if stdout.Len() > maxGhOutput {
		return nil, fmt.Errorf("gh answer too large")
	}
	return stdout.Bytes(), nil
}

func liveValidDir(dir string) bool {
	info, err := os.Stat(dir)
	return err == nil && info.IsDir()
}

// liveAgent is the project's coding agent (the developer's choice for it, else the default, else the first installed:
// agentchoice), when it has a text-only form; Codex, Kimi and the others write no sentence.
func liveAgent(dir string) string {
	choice := agentchoice.Resolve(dir, "")
	if choice.Agent == "" || choice.Missing || agentchoice.TextOnlyPrintArgv(choice.Agent) == nil {
		return ""
	}
	return choice.Agent
}

// SummariesConsentKey is the developer's agreement to the sentences, written by the window in the client's meta when he
// turns them on (the companion's offer, or Settings with its confirmation), removed when he turns them off. A terminal
// cannot write molten:* keys on the client (pkg/molten/metaguard) nor set companion:ticketsummaries (pkg/wshrpc/wshserver
// configguard); an agent writing settings.json by hand gets the setting without the agreement, which counts as off.
// Must match frontend/moltenterm-shell/settings/settings-catalog.ts ConfirmConsentKeys.
const SummariesConsentKey = "molten:ticketsummaries"

// SummariesAgreed: the setting and the developer's agreement agree.
func SummariesAgreed(setting bool, clientMeta map[string]any) bool {
	if !setting {
		return false
	}
	at, ok := clientMeta[SummariesConsentKey].(float64)
	return ok && at > 0
}

func liveSummariesOn() bool {
	if !wconfig.GetWatcher().GetFullConfig().Settings.CompanionTicketSummaries {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), clientReadTimeout)
	defer cancel()
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	return err == nil && client != nil && SummariesAgreed(true, client.Meta)
}

func runDir() (string, error) {
	dir := filepath.Join(dataDir(), runDirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

func liveRunPrint(ctx context.Context, agent string, prompt string) ([]byte, error) {
	dir, err := runDir()
	if err != nil {
		return nil, err
	}
	return agentchoice.RunTextOnly(ctx, dir, agent, prompt)
}

func storePath() string {
	return filepath.Join(dataDir(), storeName)
}

func liveLoad() StoreFile {
	data, err := os.ReadFile(storePath())
	if err != nil {
		return StoreFile{}
	}
	var file StoreFile
	if err := json.Unmarshal(data, &file); err != nil {
		return StoreFile{}
	}
	return file
}

func liveSave(file StoreFile) {
	data, err := json.Marshal(file)
	if err == nil {
		err = os.MkdirAll(dataDir(), 0o700)
	}
	if err == nil {
		err = fileutil.AtomicWriteFile(storePath(), data, 0o600)
	}
	if err != nil {
		log.Printf("[milestones] the tickets' sentences could not be saved: %v\n", err)
	}
}

func livePublish(sig Signal) {
	wps.Broker.Publish(wps.WaveEvent{Event: Event, Scopes: []string{sig.Dir}, Data: sig})
}

// Live is wavesrv's service.
func Live() *Service {
	return MakeService(Env{
		Gh:          liveGh,
		ValidDir:    liveValidDir,
		Agent:       liveAgent,
		SummariesOn: liveSummariesOn,
		RunPrint:    liveRunPrint,
		RecordUse:   attention.RecordHeadlessUse,
		Publish:     livePublish,
		Load:        liveLoad,
		Save:        liveSave,
	})
}

// route lets in the windows and Electron main only: a program in a terminal would otherwise make the developer's gh
// read a forge, or spend the developer's subscription on sentences.
func (s *Service) route() localroute.Route {
	return localroute.Route{
		Id:     RouteId,
		Policy: localroute.Policy{Default: localroute.AllowUi},
		Handler: func(_ context.Context, command string, _ localroute.Caller, data any) (any, error) {
			if command != GetCommand {
				return nil, fmt.Errorf("unknown milestones command %q", command)
			}
			var req GetRequest
			if err := utilfn.ReUnmarshal(&req, data); err != nil {
				return nil, err
			}
			return s.Get(req), nil
		},
	}
}

var startOnce sync.Once

// Start registers the route the companions ask; wavesrv calls it once, from Mission Control's start.
func Start() {
	startOnce.Do(func() {
		if _, err := localroute.Register(wshutil.DefaultRouter, Live().route()); err != nil {
			log.Printf("[milestones] route not started: %v\n", err)
		}
	})
}
