param(
    [Parameter(Mandatory = $true)][string]$PythonPath,
    [Parameter(Mandatory = $true)][string]$FfmpegPath,
    [string]$ModelCache = (Join-Path $env:LOCALAPPDATA 'FeishinCustom\word-lyrics-models')
)
$ErrorActionPreference = 'Stop'
$PythonPath = (Resolve-Path -LiteralPath $PythonPath).Path
$FfmpegPath = (Resolve-Path -LiteralPath $FfmpegPath).Path
$runner = Join-Path $PSScriptRoot 'word-lyrics-engine\runner.py'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'Run the installed copy from the application resources directory.' }
& $PythonPath -c "import sys, torch, torchaudio, whisperx.alignment, nltk, transformers, demucs; assert sys.version_info[:2] == (3, 13), 'Python 3.13 is required'; assert torch.__version__.split('+')[0] == '2.8.0'; assert torchaudio.__version__.split('+')[0] == '2.8.0'"
if ($LASTEXITCODE -ne 0) { throw 'The Python environment is missing the required alignment dependencies.' }
& $FfmpegPath -version | Select-Object -First 1
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg validation failed.' }
$ModelCache = [IO.Path]::GetFullPath($ModelCache)
New-Item -ItemType Directory -Path $ModelCache -Force | Out-Null
$runtime = @{
    pythonPath = $PythonPath
    ffmpegPath = $FfmpegPath
    modelCache = $ModelCache
    scriptPath = (Resolve-Path -LiteralPath $runner).Path
}
$json = $runtime | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'word-lyrics-runtime.json'), $json, (New-Object Text.UTF8Encoding $false))
Write-Output 'Local word-timing runtime registered. Restart Feishin Custom.'
