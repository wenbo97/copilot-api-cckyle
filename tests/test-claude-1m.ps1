<#
.SYNOPSIS
    End-to-end test: copilot-api (port 8001) -> GitHub Copilot.
    Probes model routing (Bug 1/2/3 in copilot-api) AND context-window capacity
    for the claude-opus-4.6 / 4.7 / 4.8 family.

.DESCRIPTION
    1. Preflight: claude CLI present, proxy reachable, list /v1/models opus-4* SKUs.
    2. Routing probe: small POST /v1/messages per (modelName, effort) cell.
       Reads proxy log to learn what the proxy actually forwarded upstream.
    3. Context-window probe: ascending input sizes per model name.
       resp.usage.input_tokens at the highest OK row = empirical max for that SKU.

    Why no `claude -p` cells:
      - `--bare` ignores ANTHROPIC_BASE_URL (talks straight to api.anthropic.com).
      - Without `--bare`, the CLI prefers cached OAuth credentials over env-injected
        ANTHROPIC_API_KEY=dummy and still bypasses the proxy.
      - Both paths leave the proxy log empty -> the test would silently measure
        the real Anthropic backend instead of GitHub Copilot.
      Raw POST is the only reliable way to force traffic through copilot-api.

    Note: `--effort` is a Claude Code CLI concept; the proxy strips it (the
    Anthropic->OpenAI translator in non-stream-translation.ts does NOT forward
    `thinking` or any effort/reasoning field). Effort cells exist as labels.

.PARAMETER BaseUrl
    Default: http://localhost:8001.

.PARAMETER Models
    Default: opus-4-8, opus-4-8[1m], opus-4-7[1m] (1M positive control for [1m]).

.PARAMETER Efforts
    Default: high, max. Forwarded but proxy strips them.

.PARAMETER ContextSizesK
    Filler sizes (thousands of tokens) for the context probe.
    Default: 50, 220. 220 > Anthropic-standard 200K -> succeeds only on 1M backend.

.PARAMETER SkipContextProbe
    Skip the context probe.

.PARAMETER SkipRoutingProbe
    Skip the small-prompt routing probe.

.PARAMETER ProxyLog
    Path to the proxy stdout log (used to correlate each request to its
    "Using model: ... -> translated to: ..." line).
    Default: same dir as this script -> _runlog\proxy.log.
#>
param(
    [string]$BaseUrl = "http://localhost:8001",
    [string[]]$Models = @("claude-opus-4-8", "claude-opus-4-8[1m]", "claude-opus-4-7[1m]"),
    [string[]]$Efforts = @("high", "max"),
    [int[]]$ContextSizesK = @(50, 220),
    [switch]$SkipContextProbe,
    [switch]$SkipRoutingProbe,
    [string]$ProxyLog = (Join-Path $PSScriptRoot "_runlog\proxy.log")
)

$ErrorActionPreference = "Continue"

# ---------- helpers ----------

function Write-Section($title) {
    Write-Host ""
    Write-Host "=== $title ===" -ForegroundColor Cyan
}

function Test-Url($url, $timeoutSec = 5) {
    try {
        $resp = Invoke-WebRequest -Uri $url -Method GET -TimeoutSec $timeoutSec -UseBasicParsing `
                -Headers @{ "Authorization" = "Bearer dummy" } -ErrorAction Stop
        return @{ Ok = $true; Status = $resp.StatusCode; Body = $resp.Content }
    } catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        return @{ Ok = $false; Status = $status; Error = $_.Exception.Message }
    }
}

function Get-ProxyLogTail($beforeBytes, $count = 30) {
    if (-not (Test-Path $ProxyLog)) { return @() }
    # Read everything appended after $beforeBytes, return the last $count meaningful lines.
    $fs = [System.IO.File]::Open($ProxyLog, "Open", "Read", "ReadWrite")
    try {
        $totalLen = $fs.Length
        if ($totalLen -le $beforeBytes) { return @() }
        $fs.Seek($beforeBytes, "Begin") | Out-Null
        $reader = New-Object System.IO.StreamReader($fs)
        $new = $reader.ReadToEnd()
        $reader.Close()
        # Strip ANSI escapes for grep.
        $clean = $new -replace [char]27 + '\[[0-9;]*[A-Za-z]', ''
        $lines = $clean -split "`r?`n" | Where-Object { $_ -match '\S' }
        return $lines | Select-Object -Last $count
    } finally {
        $fs.Close()
    }
}

function Get-ProxyLogSize {
    if (-not (Test-Path $ProxyLog)) { return 0 }
    return (Get-Item $ProxyLog).Length
}

function Invoke-Probe([string]$model, [int]$targetK, [string]$effort) {
    # Filler ~1 token per 4 chars; target K thousand tokens.
    $charCount   = $targetK * 1000 * 4
    $sentence    = "The quick brown fox jumps over the lazy dog. "
    $repeatCount = [math]::Ceiling($charCount / $sentence.Length)
    $sb = [System.Text.StringBuilder]::new($charCount + $sentence.Length)
    for ($i = 0; $i -lt $repeatCount; $i++) { [void]$sb.Append($sentence) }
    $filler = $sb.ToString().Substring(0, $charCount)

    $payload = @{
        model      = $model
        max_tokens = 50
        messages   = @(@{
            role    = "user"
            content = "$filler`n`nRespond with exactly: PROBE_OK_$($targetK)K_$($effort)"
        })
    }
    if ($effort) {
        # Anthropic-style thinking field. Proxy strips it but include for completeness.
        $payload.thinking = @{ type = "enabled"; budget_tokens = 1024 }
    }
    $body = $payload | ConvertTo-Json -Depth 5 -Compress

    $logBefore = Get-ProxyLogSize
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $resp = Invoke-RestMethod -Uri "$BaseUrl/v1/messages" -Method Post -Body $body `
                -ContentType "application/json" `
                -Headers @{ "x-api-key" = "dummy"; "anthropic-version" = "2023-06-01" } `
                -TimeoutSec 300 -ErrorAction Stop
        $sw.Stop()
        $text = ($resp.content | Where-Object { $_.type -eq "text" } | Select-Object -First 1).text
        $proxyLines = Get-ProxyLogTail -beforeBytes $logBefore -count 8
        return [PSCustomObject]@{
            Model        = $model
            Effort       = $effort
            TargetK      = $targetK
            Status       = "OK"
            HttpStatus   = 200
            RespModel    = $resp.model
            InputTokens  = $resp.usage.input_tokens
            OutputTokens = $resp.usage.output_tokens
            TimeSec      = [math]::Round($sw.Elapsed.TotalSeconds, 1)
            Echo         = if ($text) { $text.Substring(0, [math]::Min(80, $text.Length)) } else { $null }
            ProxyTrans   = ($proxyLines | Where-Object { $_ -match 'translated to' } | Select-Object -Last 1)
            Error        = $null
        }
    } catch {
        $sw.Stop()
        $status = $null; $errBody = $null
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            try {
                $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
                $errBody = $reader.ReadToEnd(); $reader.Close()
            } catch {}
        }
        $proxyLines = Get-ProxyLogTail -beforeBytes $logBefore -count 8
        return [PSCustomObject]@{
            Model        = $model
            Effort       = $effort
            TargetK      = $targetK
            Status       = "FAIL"
            HttpStatus   = $status
            RespModel    = $null
            InputTokens  = $null
            OutputTokens = $null
            TimeSec      = [math]::Round($sw.Elapsed.TotalSeconds, 1)
            Echo         = $null
            ProxyTrans   = ($proxyLines | Where-Object { $_ -match 'translated to' } | Select-Object -Last 1)
            Error        = if ($errBody) { $errBody.Substring(0, [math]::Min(220, $errBody.Length)) } else { $_.Exception.Message }
        }
    }
}

# ---------- preflight ----------

Write-Section "Preflight"
Write-Host "Proxy        : $BaseUrl"
Write-Host "Models       : $($Models -join ', ')"
Write-Host "Efforts      : $($Efforts -join ', ')"
Write-Host "ContextSizes : $($ContextSizesK -join 'K, ')K"
Write-Host "Proxy log    : $ProxyLog"

$claudeVer = & claude --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "FATAL: 'claude' CLI not on PATH (--version exit $LASTEXITCODE)" -ForegroundColor Red
    Write-Host $claudeVer
    exit 2
}
Write-Host "claude       : $claudeVer" -ForegroundColor Green

$probe = Test-Url "$BaseUrl/v1/models"
if (-not $probe.Ok) {
    Write-Host "FATAL: proxy unreachable at $BaseUrl/v1/models (status=$($probe.Status))" -ForegroundColor Red
    Write-Host "  hint: start with -- pushd C:\src\wb\copilot-api-cckyle ; npm run dev" -ForegroundColor Yellow
    Write-Host "  err : $($probe.Error)" -ForegroundColor DarkGray
    exit 2
}
Write-Host "proxy        : reachable (HTTP $($probe.Status))" -ForegroundColor Green

try {
    $modelList = $probe.Body | ConvertFrom-Json
    $opusIds   = $modelList.data | Where-Object { $_.id -like "*opus-4*" } | Select-Object -ExpandProperty id
    Write-Host "opus-4* SKUs on upstream:"
    if ($opusIds) { $opusIds | ForEach-Object { Write-Host "  - $_" -ForegroundColor DarkGray } }
    else          { Write-Host "  (none -- 1M routing impossible)" -ForegroundColor Yellow }
} catch {
    Write-Host "  (could not parse /v1/models response)" -ForegroundColor Yellow
}

# ---------- routing probe ----------

$routingResults = @()
if (-not $SkipRoutingProbe) {
    Write-Section "Routing probe (small prompt, per model x effort)"
    foreach ($model in $Models) {
        foreach ($effort in $Efforts) {
            Write-Host -NoNewline "[$model | $effort] " -ForegroundColor Yellow
            $r = Invoke-Probe -model $model -targetK 1 -effort $effort
            $routingResults += $r
            if ($r.Status -eq "OK") {
                Write-Host "OK" -ForegroundColor Green -NoNewline
                Write-Host " | resp.model=$($r.RespModel) | in=$($r.InputTokens) | $($r.TimeSec)s"
                if ($r.ProxyTrans) {
                    Write-Host "       proxy: $($r.ProxyTrans.Trim())" -ForegroundColor DarkGray
                }
            } else {
                Write-Host "FAIL ($($r.HttpStatus))" -ForegroundColor Red -NoNewline
                Write-Host " | $($r.TimeSec)s"
                if ($r.ProxyTrans) {
                    Write-Host "       proxy: $($r.ProxyTrans.Trim())" -ForegroundColor DarkGray
                }
                if ($r.Error) {
                    Write-Host "       err:   $($r.Error)" -ForegroundColor DarkGray
                }
            }
        }
    }
}

# ---------- context probe ----------

$contextResults = @()
if (-not $SkipContextProbe) {
    Write-Section "Context probe (ascending input sizes per model)"
    foreach ($model in $Models) {
        # Skip larger sizes once a smaller one fails (the SKU is capped).
        $sortedSizes = $ContextSizesK | Sort-Object
        $skipRest = $false
        foreach ($targetK in $sortedSizes) {
            if ($skipRest) {
                Write-Host "[$model | $($targetK)K] SKIPPED (prior size failed)" -ForegroundColor DarkGray
                continue
            }
            Write-Host -NoNewline "[$model | $($targetK)K] " -ForegroundColor Yellow
            $r = Invoke-Probe -model $model -targetK $targetK -effort ""
            $contextResults += $r
            if ($r.Status -eq "OK") {
                Write-Host "OK" -ForegroundColor Green -NoNewline
                Write-Host " | resp.model=$($r.RespModel) | in=$($r.InputTokens) | $($r.TimeSec)s"
                if ($r.Echo) { Write-Host "       echo:  $($r.Echo)" -ForegroundColor DarkGray }
                if ($r.ProxyTrans) {
                    Write-Host "       proxy: $($r.ProxyTrans.Trim())" -ForegroundColor DarkGray
                }
            } else {
                Write-Host "FAIL ($($r.HttpStatus))" -ForegroundColor Red -NoNewline
                Write-Host " | $($r.TimeSec)s"
                if ($r.ProxyTrans) {
                    Write-Host "       proxy: $($r.ProxyTrans.Trim())" -ForegroundColor DarkGray
                }
                if ($r.Error) {
                    Write-Host "       err:   $($r.Error)" -ForegroundColor DarkGray
                }
                $skipRest = $true
            }
        }
    }
}

# ---------- summary ----------

Write-Section "Summary -- routing probe"
if ($routingResults.Count -gt 0) {
    $routingResults | Format-Table Model, Effort, Status, HttpStatus, RespModel, InputTokens, TimeSec -AutoSize
}

Write-Section "Summary -- context probe"
if ($contextResults.Count -gt 0) {
    $contextResults | Format-Table Model, TargetK, Status, HttpStatus, RespModel, InputTokens, TimeSec -AutoSize
}

# ---------- interpretation hints ----------

Write-Section "Interpretation"
Write-Host "  proxy log line 'translated to: claude-opus-4'  ->  Bug 2 fired" -ForegroundColor DarkGray
Write-Host "    (regex collapsed version + [1m] suffix; upstream returns model_not_supported 400)" -ForegroundColor DarkGray
Write-Host "  proxy log line shows 'Model mapping:' before translation  ->  MODEL_MAPPINGS hit" -ForegroundColor DarkGray
Write-Host "  no 'Model mapping:' line for an input with [1m]  ->  Bug 1 fired (exact-match miss)" -ForegroundColor DarkGray
Write-Host "  context probe OK at 220K with input_tokens ~ 220K -> 1M-context SKU is live" -ForegroundColor DarkGray
Write-Host "  context probe OK at 220K with input_tokens ~ 200K cap or FAIL 400 'context_length_exceeded'" -ForegroundColor DarkGray
Write-Host "    -> hit non-1M SKU; check proxy log for which upstream model was actually called" -ForegroundColor DarkGray

# Non-zero exit if anything failed.
$failures  = @($routingResults | Where-Object { $_.Status -ne "OK" }).Count
$failures += @($contextResults | Where-Object { $_.Status -ne "OK" }).Count
exit ([math]::Min($failures, 1))
