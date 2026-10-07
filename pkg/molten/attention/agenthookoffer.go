// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The hook setup offer of a terminal's agent (#221, pkg/molten/agenthooks.go), asked by the pane header.

func hookOfferEnv() (molten.AgentEnv, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return molten.AgentEnv{}, err
	}
	return molten.AgentEnv{Home: home, DataDir: wavebase.GetWaveDataDir(), Getenv: os.Getenv}, nil
}

// An agent whose hooks reported once is set up, even where the offer cannot look (a settings folder set in the
// shell's startup files): the next runs remember it.
func rememberHookedAgent(agent string) {
	defer func() {
		panichandler.PanicHandler("molten:rememberHookedAgent", recover())
	}()
	if molten.FindAgentKind(agent) == nil {
		return
	}
	if err := molten.MarkAgentHooksSeen(wavebase.GetWaveDataDir(), agent); err != nil {
		log.Printf("molten: hooks of %s not remembered: %v\n", agent, err)
	}
}

// AgentHookOffer tells whether the header of a terminal offers its agent's hook setup. The agent's configuration
// lives on the machine it runs on: a remote terminal is not offered anything.
func AgentHookOffer(ctx context.Context, blockId string) (molten.AgentHookOffer, error) {
	offer := molten.AgentHookOffer{BlockId: blockId}
	run, ok := defaultAgentStates.runOf(blockId)
	if !ok || !run.Running {
		return offer, nil
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return offer, err
	}
	if block == nil {
		return offer, fmt.Errorf("block %s not found", blockId)
	}
	if conn := block.Meta.GetString(waveobj.MetaKey_Connection, ""); conn != "" && conn != "local" && !strings.HasPrefix(conn, "local:") {
		offer.Agent, offer.AgentName, offer.Reason = run.Agent, molten.AgentDisplayName(run.Agent), molten.HookOfferRemote
		return offer, nil
	}
	if IsAgentIntegrated(blockId) {
		offer.Agent, offer.AgentName, offer.Reason = run.Agent, molten.AgentDisplayName(run.Agent), molten.HookOfferIntegrated
		return offer, nil
	}
	env, err := hookOfferEnv()
	if err != nil {
		return offer, err
	}
	cwd := block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
	rtn := molten.MakeAgentHookOffer(env, run.Agent, wavebase.ExpandHomeDirSafe(cwd), defaultAgentStates.isAgentHooked(run.Agent))
	rtn.BlockId = blockId
	return rtn, nil
}

func DismissAgentHookOffer(agent string) error {
	if !molten.ValidAgentId(agent) {
		return fmt.Errorf("invalid agent name %q", agent)
	}
	env, err := hookOfferEnv()
	if err != nil {
		return err
	}
	return molten.DeclineAgentHooksOffer(env.DataDir, agent)
}
