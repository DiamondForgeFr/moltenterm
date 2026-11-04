// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package metaguard

import (
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const aiApiTokenKey = "ai:apitoken"

// RemoteListedConfig is the configuration an SSH or WSL host reads (agent launch, wsh launch): without the API
// tokens it holds and the paths of the SSH keys of this computer (#1831). The config itself is never changed.
func RemoteListedConfig(config wconfig.FullConfigType) wconfig.FullConfigType {
	rtn := config
	rtn.Settings.AiApiToken = ""
	if config.WaveAIModes != nil {
		rtn.WaveAIModes = make(map[string]wconfig.AIModeConfigType, len(config.WaveAIModes))
		for name, mode := range config.WaveAIModes {
			mode.APIToken = ""
			rtn.WaveAIModes[name] = mode
		}
	}
	if config.Connections != nil {
		rtn.Connections = make(map[string]wconfig.ConnKeywords, len(config.Connections))
		for name, keywords := range config.Connections {
			keywords.SshIdentityFile = nil
			rtn.Connections[name] = keywords
		}
	}
	if config.Presets != nil {
		rtn.Presets = make(map[string]waveobj.MetaMapType, len(config.Presets))
		for name, preset := range config.Presets {
			listed := waveobj.MetaMapType{}
			for key, value := range preset {
				if key != aiApiTokenKey {
					listed[key] = value
				}
			}
			rtn.Presets[name] = listed
		}
	}
	return rtn
}
