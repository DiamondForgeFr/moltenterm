// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !windows

package molten

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

var qualifiedKimiDetection = AgentHookDetection{Installed: true, Version: KimiHookQualifiedVersion}

func kimiHooksTestEnv(t *testing.T) (AgentEnv, string) {
	t.Helper()
	env := testAgentEnv(t)
	home := filepath.Join(env.Home, "kimi-home")
	env.Getenv = func(name string) string {
		if name == "KIMI_CODE_HOME" {
			return home
		}
		return ""
	}
	useTestHookBackups(t, env)
	return env, filepath.Join(home, "config.toml")
}

// markKimiIncompatible records a version as known incompatible for one test.
func markKimiIncompatible(t *testing.T, version string) {
	t.Helper()
	kimiHookIncompatibleVersions[version] = true
	t.Cleanup(func() { delete(kimiHookIncompatibleVersions, version) })
}

func kimiOffer(env AgentEnv, hooked bool, detection AgentHookDetection) AgentHookOffer {
	return MakeAgentHookOfferDetected(env, AgentIdKimi, "", hooked, detection)
}

func kimiRequest(offer AgentHookOffer, action string) AgentHookMutationRequest {
	return AgentHookMutationRequest{BlockId: "block-kimi", Agent: AgentIdKimi, Action: action, UpdateKey: offer.UpdateKey, ExpectedDigest: offer.ConfigDigest}
}

func applyKimiForTest(env AgentEnv, offer AgentHookOffer) (AgentHookMutationResult, error) {
	return ApplyAgentHookMutation(env, kimiRequest(offer, offer.Action), false, qualifiedKimiDetection)
}

func removeKimiForTest(env AgentEnv, offer AgentHookOffer, detection AgentHookDetection) (AgentHookMutationResult, error) {
	hooked := offer.Status == HookStatusReporting
	return RemoveAgentHookMutation(env, kimiRequest(offer, HookActionRemove), hooked, detection)
}

func readTestConfig(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestKimiManagedInstallLifecycle(t *testing.T) {
	env, config := kimiHooksTestEnv(t)
	offer := kimiOffer(env, false, qualifiedKimiDetection)
	if !offer.Show || !offer.Persistent || !offer.CanApply || offer.Action != HookActionInstall || offer.Status != HookStatusAbsent || offer.File != "~/kimi-home/config.toml" {
		t.Fatalf("initial offer: %+v", offer)
	}
	if len(offer.Events) != 11 || offer.DefinitionVersion != KimiHookDefinitionVersion || offer.DefinitionSHA256 == "" || offer.UpdateKey == "" {
		t.Fatalf("definition metadata: %+v", offer)
	}
	result, err := applyKimiForTest(env, offer)
	if err != nil {
		t.Fatal(err)
	}
	if result.BackupPath != "" || result.Offer.Status != HookStatusNotReporting || result.Offer.CanApply || !result.Offer.CanRemove || !result.Offer.Show {
		t.Fatalf("installed, awaiting restart: %+v", result)
	}
	content := readTestConfig(t, config)
	definition := currentKimiHookDefinition()
	if content != definition.Block+"\n" || !strings.Contains(content, "molten agent hook --agent kimi") {
		t.Fatalf("managed config: %q", content)
	}
	installations, err := readKimiInstallations(env.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	installation := installations.Installations[filepath.Clean(config)]
	if installation.DefinitionSHA256 != definition.SHA256 || installation.BlockSHA256 != digestKimiBlock([]byte(definition.Block+"\n")) || !installation.CreatedFile {
		t.Fatalf("installation state: %+v", installation)
	}
	active := kimiOffer(env, true, qualifiedKimiDetection)
	if active.Status != HookStatusReporting || active.Show || active.Reason != HookOfferHooked || !active.CanRemove {
		t.Fatalf("reporting installation: %+v", active)
	}
	removed, err := removeKimiForTest(env, active, qualifiedKimiDetection)
	if err != nil {
		t.Fatal(err)
	}
	if removed.Offer.Status != HookStatusAbsent || removed.BackupPath == "" {
		t.Fatalf("removal result: %+v", removed)
	}
	if _, err := os.Stat(config); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("MoltenTerm-created empty config remains: %v", err)
	}
	installations, err = readKimiInstallations(env.DataDir)
	if err != nil || len(installations.Installations) != 0 {
		t.Fatalf("state after removal: %+v, %v", installations, err)
	}
}

func TestKimiManagedMutationPreservesUserBytesAndPermissions(t *testing.T) {
	env, config := kimiHooksTestEnv(t)
	original := "# my settings\nmodel = \"k3\"\n\n[[hooks]]\nevent = \"Stop\"\ncommand = \"afplay done.wav\"\n"
	writeTestFile(t, config, original)
	if err := os.Chmod(config, 0640); err != nil {
		t.Fatal(err)
	}
	offer := kimiOffer(env, false, qualifiedKimiDetection)
	result, err := applyKimiForTest(env, offer)
	if err != nil {
		t.Fatal(err)
	}
	installed := readTestConfig(t, config)
	if !strings.HasPrefix(installed, original+"\n") || strings.Count(installed, "# my settings") != 1 || result.BackupPath == "" {
		t.Fatalf("user content not preserved: %q", installed)
	}
	if backup := readTestConfig(t, result.BackupPath); backup != original {
		t.Fatalf("backup does not match the inspected configuration:\n got %q\nwant %q", backup, original)
	}
	if info, err := os.Stat(config); err != nil || info.Mode().Perm() != 0640 {
		t.Fatalf("permissions: %v, %v", info.Mode(), err)
	}
	edited := strings.Replace(installed, "# my settings", "# my settings\n# added after installation", 1)
	writeTestFile(t, config, edited)
	drifted := kimiOffer(env, true, qualifiedKimiDetection)
	if drifted.Status != HookStatusReporting || !drifted.CanRemove {
		t.Fatalf("later user edit outside block must not be drift: %+v", drifted)
	}
	removed, err := removeKimiForTest(env, drifted, qualifiedKimiDetection)
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Replace(edited, currentKimiHookDefinition().Block+"\n", "", 1)
	if got := readTestConfig(t, config); got != want {
		t.Fatalf("removal discarded later edits:\n got %q\nwant %q", got, want)
	}
	if removed.Offer.Managed {
		t.Fatalf("managed state remains after removal: %+v", removed.Offer)
	}
}

func TestKimiManagedDriftAndCompatibilityPrecedeReports(t *testing.T) {
	env, config := kimiHooksTestEnv(t)
	if _, err := applyKimiForTest(env, kimiOffer(env, false, qualifiedKimiDetection)); err != nil {
		t.Fatal(err)
	}
	content := readTestConfig(t, config)
	writeTestFile(t, config, strings.Replace(content, "timeout = 15", "timeout = 14", 1))
	drift := kimiOffer(env, true, qualifiedKimiDetection)
	if drift.Status != HookStatusDrift || drift.UpdateKind != HookUpdateRepair || !drift.Show || !drift.CanApply || !drift.CanRemove {
		t.Fatalf("edited managed block: %+v", drift)
	}
	repaired, err := ApplyAgentHookMutation(env, kimiRequest(drift, drift.Action), true, qualifiedKimiDetection)
	if err != nil || repaired.Offer.Status != HookStatusReporting {
		t.Fatalf("repair: %+v, %v", repaired, err)
	}
	unknown := AgentHookDetection{Installed: true, Version: "9.8.7"}
	markKimiIncompatible(t, unknown.Version)
	review := kimiOffer(env, true, unknown)
	if review.Status != HookStatusCompatibilityReview || review.UpdateKind != HookUpdateCompatibility || !review.Show || review.CanApply || !review.CanRemove {
		t.Fatalf("compatibility review: %+v", review)
	}
	if _, err := removeKimiForTest(env, review, unknown); err != nil {
		t.Fatalf("safe removal does not require a qualified version: %v", err)
	}
}

func TestKimiManagedWholeBlockDeletionIsRepair(t *testing.T) {
	env, config := kimiHooksTestEnv(t)
	if _, err := applyKimiForTest(env, kimiOffer(env, false, qualifiedKimiDetection)); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(config); err != nil {
		t.Fatal(err)
	}
	offer := kimiOffer(env, true, qualifiedKimiDetection)
	if offer.Status != HookStatusDrift || !offer.CanApply || offer.CanRemove || !offer.Show {
		t.Fatalf("deleted managed block: %+v", offer)
	}
	if _, err := applyKimiForTest(env, offer); err != nil {
		t.Fatal(err)
	}
	if got := readTestConfig(t, config); got != currentKimiHookDefinition().Block+"\n" {
		t.Fatalf("repaired config: %q", got)
	}
}

func TestKimiManagedDefinitionMetadataChangesOfferUpdate(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit string
		with string
	}{
		{"version", "# definition-version: 1", "# definition-version: 2"},
		{"fingerprint", currentKimiHookDefinition().SHA256, strings.Repeat("0", 64)},
		{"events", "# events: SessionStart,", "# events: "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env, config := kimiHooksTestEnv(t)
			if _, err := applyKimiForTest(env, kimiOffer(env, false, qualifiedKimiDetection)); err != nil {
				t.Fatal(err)
			}
			content := strings.Replace(readTestConfig(t, config), tc.edit, tc.with, 1)
			writeTestFile(t, config, content)
			installations, err := readKimiInstallations(env.DataDir)
			if err != nil {
				t.Fatal(err)
			}
			installation := installations.Installations[filepath.Clean(config)]
			inspection := inspectKimiConfig(config)
			if inspection.ErrorCode != "" || !inspection.HasBlock {
				t.Fatalf("edited block: %+v", inspection)
			}
			installation.BlockSHA256 = digestKimiBlock(inspection.Block)
			installations.Installations[filepath.Clean(config)] = installation
			if err := saveKimiInstallations(env.DataDir, installations); err != nil {
				t.Fatal(err)
			}
			offer := kimiOffer(env, true, qualifiedKimiDetection)
			if offer.Status != HookStatusDefinitionUpdate || offer.Action != HookActionUpdate || offer.UpdateKind != HookUpdateDefinition || !offer.CanApply || !offer.Show {
				t.Fatalf("%s change: %+v", tc.name, offer)
			}
		})
	}
}

func TestKimiManagedFailsClosedWithoutMutation(t *testing.T) {
	t.Run("invalid TOML", func(t *testing.T) {
		env, config := kimiHooksTestEnv(t)
		writeTestFile(t, config, "not = [valid")
		offer := kimiOffer(env, false, qualifiedKimiDetection)
		if offer.Status != HookStatusInvalid || offer.ErrorCode != "invalid-toml" || offer.CanApply || offer.CanRemove {
			t.Fatalf("offer: %+v", offer)
		}
		if got := readTestConfig(t, config); got != "not = [valid" {
			t.Fatalf("changed: %q", got)
		}
	})
	t.Run("incomplete markers", func(t *testing.T) {
		env, config := kimiHooksTestEnv(t)
		writeTestFile(t, config, kimiHookStartMarker+"\n")
		offer := kimiOffer(env, false, qualifiedKimiDetection)
		if offer.ErrorCode != "markers" || offer.CanApply || offer.CanRemove {
			t.Fatalf("offer: %+v", offer)
		}
	})
	t.Run("legacy manual hooks", func(t *testing.T) {
		env, config := kimiHooksTestEnv(t)
		writeTestFile(t, config, kimiHooksSnippet)
		offer := kimiOffer(env, false, qualifiedKimiDetection)
		if offer.Status != HookStatusManual || offer.Show || offer.Reason != HookOfferConfigured || offer.CanApply || offer.CanRemove || offer.Managed {
			t.Fatalf("legacy manual configuration: %+v", offer)
		}
	})
	t.Run("duplicate legacy handlers conflict", func(t *testing.T) {
		env, config := kimiHooksTestEnv(t)
		duplicate := fmt.Sprintf("[[hooks]]\nevent = \"Stop\"\ncommand = %q\n\n[[hooks]]\nevent = \"Stop\"\ncommand = %q\n", KimiStateHookCommand, KimiStateHookCommand)
		writeTestFile(t, config, duplicate)
		offer := kimiOffer(env, true, qualifiedKimiDetection)
		if offer.Status != HookStatusConflict || offer.ErrorCode != "conflict" || offer.CanApply || offer.CanRemove {
			t.Fatalf("duplicate handlers: %+v", offer)
		}
	})
	t.Run("deleted managed block replaced by manual hooks", func(t *testing.T) {
		env, config := kimiHooksTestEnv(t)
		if _, err := applyKimiForTest(env, kimiOffer(env, false, qualifiedKimiDetection)); err != nil {
			t.Fatal(err)
		}
		writeTestFile(t, config, kimiHooksSnippet)
		offer := kimiOffer(env, true, qualifiedKimiDetection)
		if offer.Status != HookStatusConflict || offer.CanApply || offer.CanRemove {
			t.Fatalf("repair would duplicate manual hooks: %+v", offer)
		}
		if got := readTestConfig(t, config); got != kimiHooksSnippet {
			t.Fatalf("manual replacement changed: %q", got)
		}
	})
	t.Run("managed and unmanaged conflict", func(t *testing.T) {
		env, config := kimiHooksTestEnv(t)
		if _, err := applyKimiForTest(env, kimiOffer(env, false, qualifiedKimiDetection)); err != nil {
			t.Fatal(err)
		}
		writeTestFile(t, config, readTestConfig(t, config)+"\n"+kimiHooksSnippet+"\n")
		offer := kimiOffer(env, false, qualifiedKimiDetection)
		if offer.Status != HookStatusConflict || offer.CanApply || offer.CanRemove {
			t.Fatalf("conflict: %+v", offer)
		}
	})
	t.Run("symlink", func(t *testing.T) {
		env, config := kimiHooksTestEnv(t)
		target := filepath.Join(env.Home, "target.toml")
		writeTestFile(t, target, "")
		if err := os.MkdirAll(filepath.Dir(config), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, config); err != nil {
			t.Fatal(err)
		}
		offer := kimiOffer(env, false, qualifiedKimiDetection)
		if offer.Status != HookStatusInvalid || offer.ErrorCode != "symlink" || offer.CanApply || offer.CanRemove {
			t.Fatalf("symlink: %+v", offer)
		}
		if got := readTestConfig(t, target); got != "" {
			t.Fatalf("target changed: %q", got)
		}
	})
	t.Run("known incompatible version", func(t *testing.T) {
		env, config := kimiHooksTestEnv(t)
		markKimiIncompatible(t, "2.5.0")
		offer := kimiOffer(env, false, AgentHookDetection{Installed: true, Version: "2.5.0"})
		if offer.Status != HookStatusCompatibilityReview || offer.CanApply || offer.Action != HookActionReview {
			t.Fatalf("review: %+v", offer)
		}
		if _, err := os.Stat(config); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("detection wrote config: %v", err)
		}
	})
}

func TestKimiManagedRejectsStaleAndConcurrentApprovals(t *testing.T) {
	env, config := kimiHooksTestEnv(t)
	offer := kimiOffer(env, false, qualifiedKimiDetection)
	writeTestFile(t, config, "# concurrent user edit\n")
	if _, err := applyKimiForTest(env, offer); err == nil || !strings.Contains(err.Error(), "stale") {
		t.Fatalf("stale approval: %v", err)
	}
	if got := readTestConfig(t, config); got != "# concurrent user edit\n" {
		t.Fatalf("stale writer changed config: %q", got)
	}

	env2, config2 := kimiHooksTestEnv(t)
	offer2 := kimiOffer(env2, false, qualifiedKimiDetection)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := applyKimiForTest(env2, offer2)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	successes := 0
	for err := range errs {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("concurrent applies succeeded %d times", successes)
	}
	if got := readTestConfig(t, config2); strings.Count(got, kimiHookStartMarker) != 1 {
		t.Fatalf("concurrent result: %q", got)
	}
}

func TestKimiManagedFailureRollback(t *testing.T) {
	t.Run("state save rolls back a new file", func(t *testing.T) {
		env, config := kimiHooksTestEnv(t)
		oldSave := kimiSaveInstallations
		kimiSaveInstallations = func(string, kimiInstallationsFile) error { return errors.New("state disk full") }
		t.Cleanup(func() { kimiSaveInstallations = oldSave })
		_, err := applyKimiForTest(env, kimiOffer(env, false, qualifiedKimiDetection))
		if err == nil || !strings.Contains(err.Error(), "rolled back") {
			t.Fatalf("state failure: %v", err)
		}
		if _, statErr := os.Stat(config); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("new config not rolled back: %v", statErr)
		}
	})
	t.Run("state save restores prior bytes", func(t *testing.T) {
		env, config := kimiHooksTestEnv(t)
		if _, err := applyKimiForTest(env, kimiOffer(env, false, qualifiedKimiDetection)); err != nil {
			t.Fatal(err)
		}
		before := readTestConfig(t, config)
		writeTestFile(t, config, strings.Replace(before, "timeout = 15", "timeout = 14", 1))
		drifted := readTestConfig(t, config)
		oldSave := kimiSaveInstallations
		kimiSaveInstallations = func(string, kimiInstallationsFile) error { return errors.New("state disk full") }
		t.Cleanup(func() { kimiSaveInstallations = oldSave })
		_, err := applyKimiForTest(env, kimiOffer(env, false, qualifiedKimiDetection))
		if err == nil {
			t.Fatal("state failure accepted")
		}
		if got := readTestConfig(t, config); got != drifted {
			t.Fatalf("rollback got %q want %q", got, drifted)
		}
	})
	t.Run("backup failure prevents mutation", func(t *testing.T) {
		env, config := kimiHooksTestEnv(t)
		writeTestFile(t, config, "model = \"k3\"\n")
		agentHookBackup = func(string, []byte, os.FileMode) (string, error) {
			return "", errors.New("backup denied")
		}
		_, err := applyKimiForTest(env, kimiOffer(env, false, qualifiedKimiDetection))
		if err == nil || readTestConfig(t, config) != "model = \"k3\"\n" {
			t.Fatalf("backup failure: %v", err)
		}
	})
	t.Run("atomic write failure saves no state", func(t *testing.T) {
		env, config := kimiHooksTestEnv(t)
		oldWrite := agentHookWriteFile
		agentHookWriteFile = func(string, []byte, os.FileMode) error { return errors.New("rename failed") }
		t.Cleanup(func() { agentHookWriteFile = oldWrite })
		_, err := applyKimiForTest(env, kimiOffer(env, false, qualifiedKimiDetection))
		if err == nil {
			t.Fatal("write failure accepted")
		}
		if _, statErr := os.Stat(config); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("config created: %v", statErr)
		}
		installations, readErr := readKimiInstallations(env.DataDir)
		if readErr != nil || len(installations.Installations) != 0 {
			t.Fatalf("state saved: %+v, %v", installations, readErr)
		}
	})
}

func TestKimiHookRevisionDismissal(t *testing.T) {
	env, _ := kimiHooksTestEnv(t)
	markKimiIncompatible(t, "9.0.0")
	markKimiIncompatible(t, "9.0.1")
	if err := MarkAgentHooksSeen(env.DataDir, AgentIdKimi); err != nil {
		t.Fatal(err)
	}
	offer := kimiOffer(env, true, AgentHookDetection{Installed: true, Version: "9.0.0"})
	if !offer.Show || offer.Status != HookStatusCompatibilityReview {
		t.Fatalf("compatibility review takes precedence over seen: %+v", offer)
	}
	if err := DeclineAgentHookUpdate(env.DataDir, AgentIdKimi, offer.UpdateKey); err != nil {
		t.Fatal(err)
	}
	if got := kimiOffer(env, false, AgentHookDetection{Installed: true, Version: "9.0.0"}); got.Show || got.UpdateKey == "" || got.Status != HookStatusCompatibilityReview {
		t.Fatalf("dismissed revision: %+v", got)
	}
	if got := kimiOffer(env, false, AgentHookDetection{Installed: true, Version: "9.0.1"}); !got.Show || got.UpdateKey == offer.UpdateKey {
		t.Fatalf("a new revision must offer again: %+v", got)
	}
}
