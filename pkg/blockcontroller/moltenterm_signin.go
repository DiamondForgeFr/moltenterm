// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import "github.com/wavetermdev/waveterm/pkg/molten/onboarding"

// The first run checks how an agent's sign-in terminal ended (#1733, pkg/molten/onboarding/signincheck.go): the exit
// code is this package's to read, and onboarding cannot import it.
func init() {
	onboarding.UseSignInExit(signInExit)
}

func signInExit(blockId string) (onboarding.SignInExit, bool) {
	status := GetBlockControllerRuntimeStatus(blockId)
	if status == nil {
		return onboarding.SignInExit{}, false
	}
	return onboarding.SignInExit{Ended: status.ShellProcStatus == Status_Done, ExitCode: status.ShellProcExitCode}, true
}
