// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"strconv"
	"strings"
	"time"
)

// What the shims read of their command line under Let it sleep (DS-SHELL-024): the command to run without the block,
// or, for a bare caffeinate, what ends it. Anything they cannot read goes to the real tool, which reports it.

const caffeinateUserActiveTimeout = 5 * time.Second

// CaffeinateCall is `caffeinate [-disum] [-t timeout] [-w pid] [utility arguments...]`.
type CaffeinateCall struct {
	Timeout time.Duration
	WaitPid int
	Command []string
	// Invalid: an option caffeinate does not know, or a missing or bad value.
	Invalid bool
}

// ParseCaffeinate reads caffeinate's options the way getopt does: grouped flags (-di), a value attached (-t300) or
// next, "--" ending the options, the first other word starting the utility.
func ParseCaffeinate(args []string) CaffeinateCall {
	var call CaffeinateCall
	userActive := false
	i := 0
	for i < len(args) {
		arg := args[i]
		if arg == "--" {
			i++
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			break
		}
		i++
		flags := arg[1:]
		for j := 0; j < len(flags); j++ {
			switch flags[j] {
			case 'd', 'i', 's', 'm':
				continue
			case 'u':
				userActive = true
				continue
			case 't', 'w':
				value := flags[j+1:]
				if value == "" {
					if i >= len(args) {
						call.Invalid = true
						return call
					}
					value = args[i]
					i++
				}
				n, err := strconv.Atoi(value)
				if err != nil || n < 0 {
					call.Invalid = true
					return call
				}
				if flags[j] == 't' {
					call.Timeout = time.Duration(n) * time.Second
				} else {
					call.WaitPid = n
				}
				j = len(flags)
			default:
				call.Invalid = true
				return call
			}
		}
	}
	if i < len(args) {
		call.Command = append([]string{}, args[i:]...)
	}
	// caffeinate -u alone asserts for 5 seconds.
	if userActive && call.Timeout == 0 && call.WaitPid == 0 && len(call.Command) == 0 {
		call.Timeout = caffeinateUserActiveTimeout
	}
	return call
}

// InhibitCall is `systemd-inhibit [OPTIONS...] COMMAND [ARGUMENTS...]`.
type InhibitCall struct {
	Command []string
	// Passthrough: a listing, help, version, or no command: nothing to inhibit, the real tool answers.
	Passthrough bool
}

var inhibitValueOptions = map[string]bool{"--what": true, "--who": true, "--why": true, "--mode": true}
var inhibitPassthroughOptions = map[string]bool{"--list": true, "-h": true, "--help": true, "--version": true}

// ParseInhibit reads systemd-inhibit's options up to its command.
func ParseInhibit(args []string) InhibitCall {
	i := 0
	for i < len(args) {
		arg := args[i]
		if arg == "--" {
			i++
			break
		}
		if !strings.HasPrefix(arg, "-") {
			break
		}
		name, _, hasValue := strings.Cut(arg, "=")
		if inhibitPassthroughOptions[name] {
			return InhibitCall{Passthrough: true}
		}
		i++
		if inhibitValueOptions[name] && !hasValue {
			i++
		}
	}
	if i >= len(args) {
		return InhibitCall{Passthrough: true}
	}
	return InhibitCall{Command: append([]string{}, args[i:]...)}
}
