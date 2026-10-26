param([switch]$Install,[string]$At="06:00")
$ErrorActionPreference="Stop"
$root=Split-Path -Parent $PSScriptRoot
$taskName="OptiLens Clearance Catalogue Daily"
$node=(Get-Command node -ErrorAction Stop).Source
$script=Join-Path $PSScriptRoot "publish-clearance-catalogue.js"
if(!$Install){Write-Output "Preview only: daily catalogue publication at $At in the host's local timezone. Run with -Install after approval.";exit 0}
$protected=Join-Path $root "data/clearance/publish-config.dpapi"
if(!(Test-Path -LiteralPath $protected)){
  foreach($name in @("OPTILENS_CLEARANCE_PUBLISH_URL","OPTILENS_CLEARANCE_API_KEY","OPTILENS_CLEARANCE_LINK_TOKEN","OPTILENS_CLEARANCE_PUBLIC_KEY")){
    if(![Environment]::GetEnvironmentVariable($name,"Machine")){throw "Required machine-local configuration is missing: $name"}
  }
}
$action=New-ScheduledTaskAction -Execute $node -Argument ('"'+$script+'" --commit') -WorkingDirectory $root
$trigger=New-ScheduledTaskTrigger -Daily -At ([datetime]::Parse($At))
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -Hidden
$principal=New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Publish the allowlisted clearance snapshot daily using ACL-restricted machine-protected configuration." | Select-Object TaskName,State
