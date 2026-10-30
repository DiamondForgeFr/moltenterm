// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build darwin && cgo

package termupdate

/*
#include <pwd.h>
#include <string.h>
#include <unistd.h>
#include <utmpx.h>

// The latest console login of the user running this process, in Unix ms; 0 when there is none. The on-disk utmpx
// format differs from struct utmpx, so it is read through libc.
static long long molten_console_login_ms(void) {
    struct passwd *pw = getpwuid(getuid());
    if (pw == NULL || pw->pw_name == NULL) {
        return 0;
    }
    long long best = 0;
    struct utmpx *u;
    setutxent();
    while ((u = getutxent()) != NULL) {
        if (u->ut_type != USER_PROCESS || strncmp(u->ut_line, "console", sizeof(u->ut_line)) != 0) {
            continue;
        }
        if (strncmp(u->ut_user, pw->pw_name, sizeof(u->ut_user)) != 0) {
            continue;
        }
        long long ms = (long long)u->ut_tv.tv_sec * 1000 + u->ut_tv.tv_usec / 1000;
        if (ms > best) {
            best = ms;
        }
    }
    endutxent();
    return best;
}
*/
import "C"

func readLoginStartMs() int64 {
	return int64(C.molten_console_login_ms())
}
