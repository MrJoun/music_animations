# Re-run offline analysis for a song (Demucs + Whisper + auto lyrics).
# Usage: .\run_analysis.ps1 "C:\path\to\Artist - Title.mp3"
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$AudioPath,

    [string]$LyricsPath = "",
    [string]$Artist = "",
    [string]$Title = "",
    [switch]$Force
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $ScriptDir ".venv\Scripts\python.exe"
$Analyzer = Join-Path $ScriptDir "analyze_song.py"

if (-not (Test-Path $Python)) {
    Write-Error "Python venv not found at $Python. Run: cd tools; python -m venv .venv; pip install -r requirements.txt"
    exit 1
}

$argsList = @($Analyzer, $AudioPath, "--background")
if ($LyricsPath) { $argsList += @("--lyrics", $LyricsPath) }
if ($Artist) { $argsList += @("--artist", $Artist) }
if ($Title) { $argsList += @("--title", $Title) }
if ($Force) { $argsList += "--force" }

& $Python @argsList
