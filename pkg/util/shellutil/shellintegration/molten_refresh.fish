# MoltenTerm's managed shell environment, generation {{.GEN}} (FR-SHELL-041, DS-SHELL-074). MoltenTerm rewrites this
# file at every start; its fish integration sources it before each prompt and each command, so a shell left open
# across an update catches up. It only acts where the agent launchers' folder exists (never on a remote host).
set -l _moltenterm_rdir {{.AGENTBINDIR_FISH}}
if test -d "$_moltenterm_rdir"
    set -l _moltenterm_rgen 0
    set -q _MOLTENTERM_SHELLGEN; and set _moltenterm_rgen $_MOLTENTERM_SHELLGEN
    if test "$_moltenterm_rgen" != {{.GEN}}; or not contains -- $_moltenterm_rdir $PATH
        set -gx MOLTENTERM_AGENTBINDIR $_moltenterm_rdir
        set -l _moltenterm_rpath
        for _moltenterm_rentry in $PATH
            test "$_moltenterm_rentry" = "$_moltenterm_rdir"; or set -a _moltenterm_rpath $_moltenterm_rentry
        end
        set -gx PATH $_moltenterm_rdir $_moltenterm_rpath
        if test "$_moltenterm_rgen" != {{.GEN}}
            set -g _MOLTENTERM_SHELLGEN {{.GEN}}
            if not set -q TMUX; and not set -q STY; and not string match -q 'tmux*' -- "$TERM"; and not string match -q 'screen*' -- "$TERM"
                printf '\033]16162;MOLTEN;{"gen":%d}\007' {{.GEN}}
            end
        end
    end
end
