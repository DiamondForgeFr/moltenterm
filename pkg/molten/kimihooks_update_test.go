// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !windows

package molten

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// #2543: an installed block that differs from the shipped one offers its update with the differences, a newer
// unqualified Kimi Code confirms instead of blocking, and only a known incompatible version stays read-only.

// installKimiBlockForTest writes a managed block as an earlier MoltenTerm would have, with its installation record,
// so the offer sees a clean (not drifted) older installation.
func installKimiBlockForTest(t *testing.T, env AgentEnv, config string, kimiVersion string, entries []AgentHookEntry) string {
	t.Helper()
	definition := currentKimiHookDefinition()
	events := make([]string, 0, len(entries))
	for _, entry := range entries {
		events = append(events, entry.Event)
	}
	block := makeKimiManagedBlock(definition.Version, definition.SHA256, kimiVersion, events, entries) + "\n"
	content := "model = \"k3\"\n\n" + block
	writeTestFile(t, config, content)
	path := filepath.Clean(config)
	state := kimiInstallationsFile{Installations: map[string]kimiInstallation{path: {
		ConfigPath: path, DefinitionVersion: definition.Version, DefinitionSHA256: definition.SHA256,
		KimiVersion: kimiVersion, BlockSHA256: digestKimiBlock([]byte(block)),
	}}}
	if err := saveKimiInstallations(env.DataDir, state); err != nil {
		t.Fatal(err)
	}
	return content
}

func hasKimiChange(changes []AgentHookChange, want AgentHookChange) bool {
	return slices.Contains(changes, want)
}

// The developer's case: hooks installed for 2.6.3, Kimi Code now 2.7.2. The update is offered, not a review.
func TestKimiHooksInstalledForOlderVersionOfferUpdate(t *testing.T) {
	env, config := kimiHooksTestEnv(t)
	installKimiBlockForTest(t, env, config, "2.6.3", AgentStateHooks(AgentIdKimi))
	current := AgentHookDetection{Installed: true, Version: "2.7.2"}
	offer := kimiOffer(env, true, current)
	if offer.Status != HookStatusDefinitionUpdate || offer.Action != HookActionUpdate || offer.UpdateKind != HookUpdateDefinition || !offer.CanApply || !offer.Show || offer.Unqualified {
		t.Fatalf("hooks of 2.6.3 under the qualified 2.7.2: %+v", offer)
	}
	want := []AgentHookChange{{Kind: HookChangeChanged, Field: HookFieldQualifiedVersion, Installed: "2.6.3", Available: "2.7.2"}}
	if !slices.Equal(offer.Changes, want) {
		t.Fatalf("changes: %+v", offer.Changes)
	}
	result, err := ApplyAgentHookMutation(env, kimiRequest(offer, offer.Action), true, current)
	if err != nil {
		t.Fatal(err)
	}
	if result.BackupPath == "" || result.Offer.Status != HookStatusReporting || len(result.Offer.Changes) != 0 {
		t.Fatalf("updated: %+v", result)
	}
}

func TestKimiHooksDifferenceIsListed(t *testing.T) {
	env, config := kimiHooksTestEnv(t)
	older := AgentStateHooks(AgentIdKimi)
	older = slices.DeleteFunc(older, func(e AgentHookEntry) bool { return e.Event == "Interrupt" })
	for i := range older {
		if older[i].Event == "Stop" {
			older[i].Timeout = 10
		}
	}
	older = append(older, AgentHookEntry{Event: "SessionEnd", Command: KimiStateHookCommand, Timeout: KimiStateHookTimeout})
	installKimiBlockForTest(t, env, config, KimiHookQualifiedVersion, older)
	offer := kimiOffer(env, false, qualifiedKimiDetection)
	if offer.Status != HookStatusDefinitionUpdate || !offer.CanApply || !offer.Show {
		t.Fatalf("different hooks: %+v", offer)
	}
	for _, want := range []AgentHookChange{
		{Kind: HookChangeChanged, Event: "Stop", Field: HookFieldTimeout, Installed: "10", Available: "15"},
		{Kind: HookChangeAdded, Event: "Interrupt"},
		{Kind: HookChangeRemoved, Event: "SessionEnd"},
	} {
		if !hasKimiChange(offer.Changes, want) {
			t.Fatalf("missing %+v in %+v", want, offer.Changes)
		}
	}
	if len(offer.Changes) != 3 {
		t.Fatalf("only the differences are listed: %+v", offer.Changes)
	}
}

func TestKimiHooksUnqualifiedNewerVersionConfirmsThenUpdates(t *testing.T) {
	env, config := kimiHooksTestEnv(t)
	before := installKimiBlockForTest(t, env, config, "2.6.3", AgentStateHooks(AgentIdKimi))
	newer := AgentHookDetection{Installed: true, Version: "2.9.0"}
	offer := kimiOffer(env, false, newer)
	if offer.Status != HookStatusDefinitionUpdate || offer.Action != HookActionUpdate || !offer.CanApply || !offer.Unqualified || !offer.Show || len(offer.Changes) == 0 {
		t.Fatalf("a newer version must offer the update, asking first: %+v", offer)
	}
	if _, err := ApplyAgentHookMutation(env, kimiRequest(offer, offer.Action), false, newer); err == nil || !strings.Contains(err.Error(), "not qualified") {
		t.Fatalf("an unconfirmed write must be refused: %v", err)
	}
	if got := readTestConfig(t, config); got != before {
		t.Fatalf("refused write changed the config: %q", got)
	}
	req := kimiRequest(offer, offer.Action)
	req.ConfirmUnqualified = true
	result, err := ApplyAgentHookMutation(env, req, false, newer)
	if err != nil {
		t.Fatal(err)
	}
	if result.BackupPath == "" || readTestConfig(t, result.BackupPath) != before {
		t.Fatalf("the update keeps a backup of the previous config: %+v", result)
	}
	if got := readTestConfig(t, config); got != "model = \"k3\"\n\n"+currentKimiHookDefinition().Block+"\n" {
		t.Fatalf("updated config: %q", got)
	}
	if result.Offer.Status != HookStatusNotReporting || result.Offer.UpdateKind != "" || len(result.Offer.Changes) != 0 {
		t.Fatalf("after the update: %+v", result.Offer)
	}
}

func TestKimiHooksUnqualifiedInstallConfirms(t *testing.T) {
	env, config := kimiHooksTestEnv(t)
	newer := AgentHookDetection{Installed: true, Version: "2.9.0"}
	offer := kimiOffer(env, false, newer)
	if offer.Status != HookStatusAbsent || offer.Action != HookActionInstall || !offer.CanApply || !offer.Unqualified {
		t.Fatalf("install on a newer version: %+v", offer)
	}
	req := kimiRequest(offer, offer.Action)
	req.ConfirmUnqualified = true
	if _, err := ApplyAgentHookMutation(env, req, false, newer); err != nil {
		t.Fatal(err)
	}
	if got := readTestConfig(t, config); got != currentKimiHookDefinition().Block+"\n" {
		t.Fatalf("installed config: %q", got)
	}
}

func TestKimiHooksKnownIncompatibleVersionStaysReadOnly(t *testing.T) {
	env, config := kimiHooksTestEnv(t)
	before := installKimiBlockForTest(t, env, config, "2.6.3", AgentStateHooks(AgentIdKimi))
	markKimiIncompatible(t, "2.4.0")
	old := AgentHookDetection{Installed: true, Version: "2.4.0"}
	offer := kimiOffer(env, false, old)
	if offer.Status != HookStatusCompatibilityReview || offer.Action != HookActionReview || offer.CanApply || offer.Unqualified || !offer.CanRemove {
		t.Fatalf("known incompatible version: %+v", offer)
	}
	req := kimiRequest(offer, HookActionUpdate)
	req.ConfirmUnqualified = true
	if _, err := ApplyAgentHookMutation(env, req, false, old); err == nil {
		t.Fatal("a known incompatible version must not be written, even confirmed")
	}
	if got := readTestConfig(t, config); got != before {
		t.Fatalf("config changed: %q", got)
	}
}

func TestKimiHooksNoDifferenceOffersNoUpdate(t *testing.T) {
	env, config := kimiHooksTestEnv(t)
	if _, err := applyKimiForTest(env, kimiOffer(env, false, qualifiedKimiDetection)); err != nil {
		t.Fatal(err)
	}
	for _, version := range []string{KimiHookQualifiedVersion, "2.9.0"} {
		offer := kimiOffer(env, true, AgentHookDetection{Installed: true, Version: version})
		if offer.Status != HookStatusReporting || offer.UpdateKind != "" || offer.CanApply || len(offer.Changes) != 0 || offer.Show {
			t.Fatalf("%s, nothing differs: %+v", version, offer)
		}
	}
	if got := readTestConfig(t, config); got != currentKimiHookDefinition().Block+"\n" {
		t.Fatalf("config: %q", got)
	}
}
