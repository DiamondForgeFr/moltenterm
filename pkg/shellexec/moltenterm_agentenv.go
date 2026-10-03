// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package shellexec

import (
	"os"

	"github.com/wavetermdev/waveterm/pkg/util/envutil"
)

// localShellBaseEnv is the environment a local shell starts from: wavesrv's own, without the session markers of an
// agent that launched MoltenTerm (#106).
func localShellBaseEnv() []string {
	return envutil.StripAgentSessionMarkers(os.Environ())
}
