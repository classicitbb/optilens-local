# Git steps of the guarded updater (scripts/apply-local-update.ps1).
#
# They live in their own file so they can be exercised against a throwaway repository
# (test/update-git-helpers.test.js) without restarting the service.
#
# The host runs the DEPLOY branch (master unless OPTILENS_UPDATE_BRANCH says otherwise). If the
# checkout is resting on another branch, an update switches to the deploy branch first and, if
# the update fails before the restart, switches back and puts every ref exactly where it was.

function Invoke-GitCapture {
    param([string] $Root, [string[]] $GitArgs)
    # Git writes progress to stderr; with the updater's Stop preference that would become an
    # exception, and the exit code is the authoritative result.
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & git -c "safe.directory=$Root" -C $Root @GitArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    [pscustomobject]@{
        ExitCode = $code
        Output   = (($output | ForEach-Object { "$_" }) -join "`n").Trim()
    }
}

# Tracked modifications only. An untracked file cannot be lost by a fast-forward, and Git itself
# refuses (safely) if an incoming file would overwrite one.
function Get-TrackedChanges {
    param([string] $Root)
    (Invoke-GitCapture $Root @("status", "--porcelain", "--untracked-files=no")).Output
}

function Get-CurrentRevision {
    param([string] $Root)
    (Invoke-GitCapture $Root @("rev-parse", "HEAD")).Output
}

# Puts the checkout on $Branch, creating it from $Remote/$Branch if it does not exist locally.
# Returns what Restore-GitState needs to undo it.
function Enter-DeployBranch {
    param([string] $Root, [string] $Remote, [string] $Branch)

    $current = (Invoke-GitCapture $Root @("rev-parse", "--abbrev-ref", "HEAD")).Output
    $revision = Get-CurrentRevision $Root
    $existing = Invoke-GitCapture $Root @("rev-parse", "--verify", "--quiet", "refs/heads/$Branch")
    $hadLocalBranch = ($existing.ExitCode -eq 0)

    $state = [pscustomobject]@{
        Switched            = $false
        Detached            = ($current -eq "HEAD")
        Branch              = $current
        Revision            = $revision
        DeployBranch        = $Branch
        DeployHadLocal      = $hadLocalBranch
        DeployPriorRevision = if ($hadLocalBranch) { $existing.Output } else { "" }
    }
    if ($current -eq $Branch) { return $state }

    $switch = if ($hadLocalBranch) {
        Invoke-GitCapture $Root @("switch", "--quiet", $Branch)
    } else {
        Invoke-GitCapture $Root @("switch", "--quiet", "-c", $Branch, "--track", "$Remote/$Branch")
    }
    if ($switch.ExitCode -ne 0) { throw "Could not switch to the deploy branch ${Branch}: $($switch.Output)" }
    $state.Switched = $true
    return $state
}

# Undoes Enter-DeployBranch plus any fast-forward: back on the original branch (or detached
# commit), with the deploy branch pointing where it did before, or removed if the update created it.
function Restore-GitState {
    param([string] $Root, $State)

    if (-not $State.Switched) {
        $reset = Invoke-GitCapture $Root @("reset", "--hard", $State.Revision)
        return ($reset.ExitCode -eq 0)
    }

    $back = if ($State.Detached) {
        Invoke-GitCapture $Root @("switch", "--quiet", "--detach", $State.Revision)
    } else {
        Invoke-GitCapture $Root @("switch", "--quiet", $State.Branch)
    }
    if ($back.ExitCode -ne 0) { return $false }

    if ($State.DeployHadLocal) {
        $move = Invoke-GitCapture $Root @("branch", "--force", $State.DeployBranch, $State.DeployPriorRevision)
    } else {
        $move = Invoke-GitCapture $Root @("branch", "-D", $State.DeployBranch)
    }
    return ($move.ExitCode -eq 0)
}
