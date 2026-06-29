<#
Usage:
  From repo root:
  powershell -ExecutionPolicy Bypass -File .\chat-edit.ps1

Features:
  - Lists tracked files (git) or any file you choose
  - Sends file + instruction to LiteLLM (OpenAI-style endpoint)
  - Shows a git-style diff preview
  - Optionally writes changes and commits
#>

# Config
$LITELLM_URL = "http://localhost:4000/v1/chat/completions"
$API_KEY = "ollama"                # LiteLLM expects this by default
$MODEL = "qwen2.5-coder:7b"
$headers = @{ "Authorization" = "Bearer $API_KEY"; "Content-Type" = "application/json" }

function Send-Chat {
    param($systemMsg, $userMsg)
    $payload = @{
        model = $MODEL
        messages = @(
            @{ role = "system"; content = $systemMsg }
            @{ role = "user"; content = $userMsg }
        )
        temperature = 0.2
        max_tokens = 2048
    } | ConvertTo-Json -Depth 8

    try {
        $resp = Invoke-RestMethod -Uri $LITELLM_URL -Method Post -Body $payload -Headers $headers -ContentType "application/json" -ErrorAction Stop
    } catch {
        Write-Host "ERROR: API request failed:" -ForegroundColor Red
        Write-Host $_.Exception.Message
        return $null
    }

    # Robust extraction of assistant text
    if ($resp.choices -and $resp.choices.Count -gt 0) {
        if ($resp.choices[0].message -and $resp.choices[0].message.content) {
            return $resp.choices[0].message.content
        } elseif ($resp.choices[0].text) {
            return $resp.choices[0].text
        }
    }
    return $null
}

function Show-Diff {
    param($origPath, $newPath)
    if (Get-Command git -ErrorAction SilentlyContinue) {
        git --no-pager diff --no-index -- $origPath $newPath
    } else {
        Write-Host "git not found; showing simple side-by-side preview" -ForegroundColor Yellow
        Write-Host "----- ORIGINAL -----"
        Get-Content $origPath | Select-Object -First 200
        Write-Host "----- NEW -----"
        Get-Content $newPath | Select-Object -First 200
    }
}

# Main loop
while ($true) {
    Write-Host ""
    Write-Host "Files in repo (tracked) — enter number or full path (q to quit):" -ForegroundColor Cyan
    $files = @()
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $files = git ls-files | Select-Object -First 200
    } else {
        $files = Get-ChildItem -Recurse -File -Include *.py,*.js,*.ts,*.go,*.cs,*.java | ForEach-Object { $_.FullName }
    }
    for ($i=0; $i -lt $files.Count; $i++) {
        Write-Host ("[{0}] {1}" -f $i, $files[$i])
    }

    $choice = Read-Host "Choose file index or path (q to quit)"
    if ($choice -eq 'q') { break }

    if ($choice -match '^\d+$') {
        $idx = [int]$choice
        if ($idx -ge 0 -and $idx -lt $files.Count) {
            $filePath = $files[$idx]
        } else {
            Write-Host "Invalid index" -ForegroundColor Red
            continue
        }
    } else {
        $filePath = $choice
        if (-not (Test-Path $filePath)) {
            Write-Host "File not found: $filePath" -ForegroundColor Red
            continue
        }
    }

    $orig = Get-Content $filePath -Raw
    Write-Host "File loaded: $filePath" -ForegroundColor Green
    Write-Host ""
    $userPrompt = Read-Host "Instruction (e.g., 'Add error handling for null inputs' or 'Refactor to async')"

    $systemMsg = "You are a careful coding assistant. Return only the full updated file contents. Do not include explanations or markdown fences."

    $combinedPrompt = "Task: $userPrompt`n`nFile path: $filePath`n---BEGIN FILE---`n$orig`n---END FILE---`n`nReturn the full updated file content only."

    Write-Host "Sending request to model..." -ForegroundColor Yellow
    $aiOutput = Send-Chat -systemMsg $systemMsg -userMsg $combinedPrompt

    if (-not $aiOutput) {
        Write-Host "No response from model." -ForegroundColor Red
        continue
    }

    # Save to temp file and show diff
    $tmp = [System.IO.Path]::GetTempFileName()
    Set-Content -Path $tmp -Value $aiOutput -Encoding UTF8

    Write-Host "`n--- DIFF PREVIEW ---`n" -ForegroundColor Cyan
    Show-Diff -origPath $filePath -newPath $tmp

    $apply = Read-Host "Apply changes? (y/n) [n]"
    if ($apply -eq 'y') {
        # Backup original
        Copy-Item -Path $filePath -Destination "$filePath.bak" -Force
        Set-Content -Path $filePath -Value $aiOutput -Encoding UTF8
        Write-Host "File updated. Backup saved as $filePath.bak" -ForegroundColor Green

        if (Get-Command git -ErrorAction SilentlyContinue) {
            $commit = Read-Host "Commit changes with message? (enter message or leave blank to skip commit)"
            if ($commit) {
                git add $filePath
                git commit -m $commit
                Write-Host "Committed." -ForegroundColor Green
            }
        }
    } else {
        Write-Host "Changes not applied." -ForegroundColor Yellow
    }

    Remove-Item $tmp -Force
}
