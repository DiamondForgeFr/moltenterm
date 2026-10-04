// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// `molten version` and `molten --version` (FR-REL-001): MoltenTerm's own number, and the Wave Terminal release it is
// based on. `wsh version` keeps Wave's output, `wsh v<version>`: the remote wsh check parses it.

var moltenVersionCmd = &cobra.Command{
	Use:   "version",
	Short: "print the MoltenTerm version and the Wave Terminal release it is based on",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		return moltenVersionRun()
	},
}

func init() {
	moltenVersionCmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	moltenCmd.AddCommand(moltenVersionCmd)
}

type moltenVersionInfo struct {
	Version   string `json:"version"`
	WaveBase  string `json:"wavebase"`
	BuildTime string `json:"buildtime"`
}

func readMoltenVersionInfo() moltenVersionInfo {
	return moltenVersionInfo{
		Version:   wavebase.WaveVersion,
		WaveBase:  wavebase.MoltentermWaveBaseVersion,
		BuildTime: wavebase.BuildTime,
	}
}

// The build stamps its time as YYYYMMDDHHMM (Taskfile.yml).
func formatMoltenBuildTime(stamp string) string {
	if len(stamp) != 12 {
		return stamp
	}
	return fmt.Sprintf("%s-%s-%s %s:%s", stamp[0:4], stamp[4:6], stamp[6:8], stamp[8:10], stamp[10:12])
}

func formatMoltenVersion(info moltenVersionInfo) string {
	line := "MoltenTerm " + info.Version
	if info.BuildTime != "" && info.BuildTime != "0" {
		line += " (built " + formatMoltenBuildTime(info.BuildTime) + ")"
	}
	return line + ", based on Wave Terminal " + info.WaveBase + "\n"
}

func moltenVersionRun() error {
	info := readMoltenVersionInfo()
	if moltenJson {
		return moltenWriteJson(info)
	}
	WriteStdout("%s", formatMoltenVersion(info))
	return nil
}
