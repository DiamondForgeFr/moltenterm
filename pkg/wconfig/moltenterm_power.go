// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wconfig

import (
	"log"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The values of power:terminalrequests; unset asks the first time.
const (
	PowerRequestsAlways = "always"
	PowerRequestsNever  = "never"
)

// PowerMigration is what replaces the former power:sleeppolicy (FR-SHELL-023 AC18, #2089): the setting mixed what turns
// keep-awake on with what a terminal's request gets. untilworkends is Automatic on with requests let through; letsleep
// is requests refused; allow is requests let through; unset or unknown leaves both at their default (ask the first
// time, Automatic off). A value already written under a new key is kept. Nil when the former setting is not there.
func PowerMigration(settings waveobj.MetaMapType) waveobj.MetaMapType {
	legacy, found := settings[ConfigKey_PowerSleepPolicy]
	if !found {
		return nil
	}
	updates := waveobj.MetaMapType{ConfigKey_PowerSleepPolicy: nil}
	policy, _ := legacy.(string)
	automatic, requests := false, ""
	switch strings.ToLower(strings.TrimSpace(policy)) {
	case "untilworkends":
		automatic, requests = true, PowerRequestsAlways
	case "letsleep":
		requests = PowerRequestsNever
	case "allow":
		requests = PowerRequestsAlways
	}
	if _, set := settings[ConfigKey_PowerAutomatic]; !set && automatic {
		updates[ConfigKey_PowerAutomatic] = true
	}
	if _, set := settings[ConfigKey_PowerTerminalRequests]; !set && requests != "" {
		updates[ConfigKey_PowerTerminalRequests] = requests
	}
	return updates
}

// MigratePowerSettings moves power:sleeppolicy to the keys that replace it, once: the former key is removed.
func MigratePowerSettings() {
	settings, errs := ReadWaveHomeConfigFile(SettingsFile)
	if len(errs) > 0 {
		return
	}
	updates := PowerMigration(settings)
	if updates == nil {
		return
	}
	if err := SetBaseConfigValue(updates); err != nil {
		log.Printf("error migrating power:sleeppolicy: %v\n", err)
		return
	}
	log.Printf("migrated power:sleeppolicy to power:automatic and power:terminalrequests\n")
}
