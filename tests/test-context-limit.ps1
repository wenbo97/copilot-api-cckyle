<#
.SYNOPSIS
    Measure the real max context window for a Claude model via the copilot-api proxy.

    Unlike a naive char-count test, this script ANCHORS ON THE REAL input_tokens
    returned by the API:
      * It self-calibrates the true chars-per-token ratio from a small probe
        (reading usage.input_tokens), so each "target K" actually lands near K
        true tokens -- not 1.6x over, the way a flat "4 chars = 1 token"
        assumption does for repetitive English filler (~2.5 chars/token).
      * Every row reports the REAL input_tokens from usage, never the assumed target.
      * On rejection it prints the FULL proxy error (e.g.
        "prompt is too long: 1280051 tokens > 1000000 maximum") and extracts the
        exact cap, so the boundary is unambiguous.

.PARAMETER BaseUrl
    Proxy URL. Default: http://localhost:4141

.PARAMETER Model
    Model to test. Default: claude-opus-4.8

.PARAMETER Steps
    TRUE target token sizes to test, in thousands. Default: 200,500,800,1000,1100
    (brackets the 1M boundary). Each payload is sized via the calibrated ratio so
    the actual input_tokens lands close to the requested target.

.EXAMPLE
    .\test-context-limit.ps1
    .\test-context-limit.ps1 -Model "claude-opus-4.8" -Steps 200,500,800,1000,1100
#>
param(
    [string]$BaseUrl = "http://localhost:4141",
    [string]$Model   = "claude-opus-4.8",
    [int[]]$Steps    = @(200, 500, 800, 1000, 1100)
)

$endpoint = "$BaseUrl/v1/messages"

# --- helpers ---------------------------------------------------------------

function New-Filler([int]$charCount) {
    $sentence = "The quick brown fox jumps over the lazy dog. "
    $repeat = [math]::Ceiling($charCount / $sentence.Length)
    $sb = [System.Text.StringBuilder]::new($charCount + $sentence.Length)
    for ($i = 0; $i -lt $repeat; $i++) { [void]$sb.Append($sentence) }
    return $sb.ToString().Substring(0, $charCount)
}

# The proxy double-wraps errors: {"error":{"message":"{\"error\":{...}}","type":"error"}}
# Dig out the clean inner code + message.
function Get-ProxyError([string]$raw) {
    if (-not $raw) { return $null }
    try {
        $outer = $raw | ConvertFrom-Json
        $msg = $outer.error.message
        try {
            $inner = $msg | ConvertFrom-Json
            return [PSCustomObject]@{ Code = $inner.error.code; Message = $inner.error.message }
        } catch {
            return [PSCustomObject]@{ Code = $outer.error.type; Message = $msg }
        }
    } catch {
        return [PSCustomObject]@{ Code = $null; Message = $raw }
    }
}

function Send-Probe([int]$charCount, [string]$marker) {
    $filler = New-Filler $charCount
    $body = @{
        model      = $Model
        max_tokens = 16
        messages   = @(@{ role = "user"; content = "$filler`n`nRespond with exactly: $marker" })
    } | ConvertTo-Json -Depth 5 -Compress

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $resp = Invoke-RestMethod -Uri $endpoint -Method Post -Body $body `
            -ContentType "application/json" `
            -Headers @{ "x-api-key" = "dummy"; "anthropic-version" = "2023-06-01" } `
            -TimeoutSec 300
        $sw.Stop()
        return [PSCustomObject]@{
            Ok          = $true
            Status      = 200
            Chars       = $charCount
            InputTokens = [int]$resp.usage.input_tokens
            OutputTokens= [int]$resp.usage.output_tokens
            StopReason  = $resp.stop_reason
            Text        = ($resp.content | Where-Object { $_.type -eq "text" } | Select-Object -First 1).text
            TimeSec     = [math]::Round($sw.Elapsed.TotalSeconds, 1)
            ErrCode     = $null
            ErrMessage  = $null
        }
    } catch {
        $sw.Stop()
        $statusCode = $null
        if ($_.Exception.Response) {
            try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
        }
        # $_.ErrorDetails.Message carries the response body in both PS 5.1 and PS 7+.
        $raw = $_.ErrorDetails.Message
        if (-not $raw -and $_.Exception.Response) {
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                $reader = [System.IO.StreamReader]::new($stream)
                $raw = $reader.ReadToEnd(); $reader.Close()
            } catch {}
        }
        $parsed = Get-ProxyError $raw
        return [PSCustomObject]@{
            Ok          = $false
            Status      = $statusCode
            Chars       = $charCount
            InputTokens = $null
            TimeSec     = [math]::Round($sw.Elapsed.TotalSeconds, 1)
            ErrCode     = if ($parsed) { $parsed.Code } else { $null }
            ErrMessage  = if ($parsed) { $parsed.Message } else { $_.Exception.Message }
        }
    }
}

# --- run -------------------------------------------------------------------

Write-Host "=== Context Limit Test (token-accurate) ===" -ForegroundColor Cyan
Write-Host "Proxy : $BaseUrl"
Write-Host "Model : $Model"
Write-Host "Steps : $($Steps -join 'K, ')K true tokens"
Write-Host ""

# 1) Calibrate true chars-per-token from a ~40K-char probe.
Write-Host -NoNewline "[calibrate] probing chars/token... " -ForegroundColor Yellow
$cal = Send-Probe 40000 "CALIBRATE_OK"
if (-not $cal.Ok -or -not $cal.InputTokens) {
    Write-Host "FAILED" -ForegroundColor Red
    Write-Host "  status=$($cal.Status) code=$($cal.ErrCode) msg=$($cal.ErrMessage)" -ForegroundColor DarkGray
    Write-Host "  Is the proxy running at $BaseUrl and does it serve '$Model'?" -ForegroundColor Red
    return
}
$charsPerToken = $cal.Chars / $cal.InputTokens
$overshoot = (4.0 / $charsPerToken) - 1   # how badly a flat "4 chars/token" guess inflates each target
Write-Host ("OK -> {0:N3} chars/token  (probe: {1} chars = {2} tokens)" -f $charsPerToken, $cal.Chars, $cal.InputTokens) -ForegroundColor Green
Write-Host ("            (a flat '4 chars/token' guess would overshoot every target by ~{0:P0})" -f $overshoot) -ForegroundColor DarkGray
Write-Host ""

$results = @()

foreach ($sizeK in $Steps) {
    $targetTokens = $sizeK * 1000
    $charCount = [int][math]::Round($targetTokens * $charsPerToken)

    Write-Host -NoNewline "[$($sizeK)K] Sending... " -ForegroundColor Yellow
    $mb = [math]::Round($charCount / 1MB, 1)
    Write-Host -NoNewline "(payload: ${mb}MB, aiming for ~$($sizeK)K true tokens) " -ForegroundColor DarkGray

    $r = Send-Probe $charCount "CONTEXT_OK_$($sizeK)K"

    if ($r.Ok) {
        Write-Host "OK" -ForegroundColor Green -NoNewline
        Write-Host " | input=$($r.InputTokens), output=$($r.OutputTokens), stop=$($r.StopReason), time=$($r.TimeSec)s"
        if ($r.Text) {
            Write-Host "       response: $($r.Text.Substring(0, [math]::Min(80, $r.Text.Length)))" -ForegroundColor DarkGray
        }
        # Refine the ratio from this real measurement for the next step.
        if ($r.InputTokens -gt 0) { $charsPerToken = $r.Chars / $r.InputTokens }

        $results += [PSCustomObject]@{
            TargetK     = $sizeK
            Status      = "OK"
            InputTokens = $r.InputTokens
            TimeSec     = $r.TimeSec
            Detail      = $null
        }
    } else {
        Write-Host "FAIL" -ForegroundColor Red -NoNewline
        Write-Host " | status=$($r.Status) | code=$($r.ErrCode), time=$($r.TimeSec)s"
        if ($r.ErrMessage) {
            Write-Host "       limit: $($r.ErrMessage)" -ForegroundColor DarkGray
        }
        $results += [PSCustomObject]@{
            TargetK     = $sizeK
            Status      = "FAIL ($($r.Status))"
            InputTokens = $null
            TimeSec     = $r.TimeSec
            Detail      = $r.ErrMessage
        }
    }
}

Write-Host ""
Write-Host "=== Summary (InputTokens = REAL usage.input_tokens) ===" -ForegroundColor Cyan
$results | Format-Table TargetK, Status, InputTokens, TimeSec -AutoSize

# --- boundary --------------------------------------------------------------
$lastOK    = $results | Where-Object { $_.Status -eq "OK" } | Select-Object -Last 1
$firstFail = $results | Where-Object { $_.Status -ne "OK" } | Select-Object -First 1

Write-Host ""
if ($lastOK -and $firstFail) {
    Write-Host "Largest accepted prompt : $($lastOK.InputTokens) input tokens (real)" -ForegroundColor Green
    # Pull the exact cap out of the rejection message, e.g. "... > 1000000 maximum"
    $cap = $null
    if ($firstFail.Detail -and $firstFail.Detail -match '>\s*(\d+)\s*maximum') { $cap = [int]$matches[1] }
    elseif ($firstFail.Detail -and $firstFail.Detail -match '(\d{6,})\s*maximum') { $cap = [int]$matches[1] }
    if ($cap) {
        Write-Host ("Hard context window cap : {0:N0} tokens  (stated by the API)" -f $cap) -ForegroundColor Cyan
    } else {
        Write-Host "First rejection         : $($firstFail.Detail)" -ForegroundColor DarkGray
    }
} elseif (-not $firstFail -and $lastOK) {
    Write-Host "All steps passed. Largest real input_tokens: $($lastOK.InputTokens)" -ForegroundColor Green
    Write-Host "Raise -Steps to find the upper bound." -ForegroundColor Yellow
} else {
    Write-Host "All steps failed. Check the proxy and model name at $BaseUrl." -ForegroundColor Red
}
