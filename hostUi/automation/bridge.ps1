param(
    [Parameter(Mandatory = $true)][string]$TargetFile,
    [switch]$Bind,
    [switch]$Probe,
    [switch]$Inspect,
    [int]$WindowProcessId = 0
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BridgeNative {
    [DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object acc);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT keyboard; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
    [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    private static INPUT Key(ushort key, ushort scan, uint flags) {
        return new INPUT { type=1, data=new UNION { keyboard=new KEYBDINPUT { key=key, scan=scan, flags=flags } } };
    }
    private static void Send(INPUT[] inputs) {
        if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
            throw new InvalidOperationException("Windows refused keyboard input. Do not run VS Code elevated.");
    }
    public static void Text(string text) {
        foreach(char ch in text) {
            if (ch=='\n') {
                Send(new [] {Key(16,0,0),Key(13,0,0),Key(13,0,2),Key(16,0,2)});
            } else {
                Send(new [] {Key(0,ch,4),Key(0,ch,6)});
            }
        }
    }
    public static void Clear() {
        Send(new [] {Key(17,0,0),Key(65,0,0),Key(65,0,2),Key(17,0,2),Key(8,0,0),Key(8,0,2)});
    }
    public static void Submit() {
        Send(new [] {Key(13,0,0),Key(13,0,2)});
    }
}
'@

function Find-All($Element, $Property, $Value) {
    $condition = New-Object System.Windows.Automation.PropertyCondition($Property, $Value)
    return ,$Element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Get-Windows {
    $all = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($window in $all) {
        if ($window.Current.ClassName -eq 'Chrome_WidgetWin_1' -and $window.Current.Name -match 'Visual Studio Code') {
            if ($WindowProcessId -eq 0 -or $WindowProcessId -eq $window.Current.ProcessId) { $window }
        }
    }
}

function Enable-Tree($Window) {
    $iid = [Guid]'618736e0-3c3d-11cf-810c-00aa00389b71'
    $acc = $null
    $status = [BridgeNative]::AccessibleObjectFromWindow(
        [IntPtr]$Window.Current.NativeWindowHandle, [uint32]4294967292, [ref]$iid, [ref]$acc
    )
    if ($status -ne 0) { throw 'Could not request the VS Code accessibility tree.' }
}

function Get-Context {
    $windows = @(Get-Windows)
    if ($windows.Count -eq 0) { throw 'No matching VS Code window found. Open VS Code and keep Chat visible.' }
    $window = $windows[0]
    Enable-Tree $window
    $process = Get-Process -Id $window.Current.ProcessId
    if ($script:target) {
        if ($process.Id -ne $script:target.processId -or
            $process.StartTime.ToUniversalTime().ToString('O') -ne $script:target.processStartedAt) {
            throw 'The bound VS Code window has restarted. Bind the window again locally.'
        }
    }
    $chats = Find-All $window ([System.Windows.Automation.AutomationElement]::NameProperty) 'Chat'
    $lists = @($chats | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::List -and -not $_.Current.IsOffscreen })
    if ($lists.Count -eq 0) { throw 'No visible Chat transcript found. Open the intended chat in the selected VS Code window.' }
    $chat = $lists[0]
    foreach ($list in $lists) {
        $parent = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($list)
        $focused = Find-All $parent ([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty) $true
        if ($focused.Count -gt 0) {
            $chat = $list
            break
        }
    }
    $group = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($chat)
    if ($group.Current.ClassName -notmatch '^interactive-session(?: |$)') {
        throw 'VS Code chat structure changed; refusing to automate an unknown control.'
    }
    $editors = Find-All $group ([System.Windows.Automation.AutomationElement]::ControlTypeProperty) ([System.Windows.Automation.ControlType]::Edit)
    $inputs = @($editors | Where-Object { $_.Current.Name.StartsWith('Chat Input') -and -not $_.Current.IsOffscreen })
    if ($inputs.Count -ne 1) {
        throw 'Accessible Chat Input not found. Enable editor.accessibilitySupport: on in VS Code and keep Chat visible.'
    }
    return @{
        window = $window
        process = $process
        chat = $chat
        group = $group
        input = $inputs[0]
    }
}

function Get-Buttons($Group) {
    return ,(Find-All $Group ([System.Windows.Automation.AutomationElement]::ControlTypeProperty) ([System.Windows.Automation.ControlType]::Button))
}

function Get-TranscriptIdentity([string]$RuntimeKey, $Messages) {
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($message in $Messages) {
        if ([string]::IsNullOrWhiteSpace($message.id) -or -not $seen.Add($message.id)) {
            throw [System.IO.InvalidDataException]::new('VS Code exposed an incomplete or ambiguous transcript row identity. Wait for the chat to settle before retrying.')
        }
    }
    $ids = @($Messages | ForEach-Object { $_.id })
    $reset = -not $script:transcriptIdentity -or $script:transcriptRuntime -cne $RuntimeKey
    if (-not $reset -and $script:transcriptIds.Count -gt 0) {
        $overlap = @($ids | Where-Object { $script:transcriptIds.Contains($_) })
        if ($overlap.Count -eq 0) { $reset = $true }
        foreach ($message in $Messages) {
            $previous = $script:transcriptRows[$message.id]
            if ($previous -and ($previous.role -cne $message.role -or
                ($message.role -eq 'user' -and $previous.text -cne $message.text) -or
                ($previous.completed -eq $true -and $message.completed -eq $true -and $previous.text -cne $message.text))) {
                $reset = $true
            }
        }
    }
    if ($reset) {
        $script:transcriptIdentity = $RuntimeKey + ':' + [Guid]::NewGuid().ToString()
    }
    $script:transcriptRuntime = $RuntimeKey
    $script:transcriptIds = New-Object 'System.Collections.Generic.HashSet[string]'
    $script:transcriptRows = @{}
    foreach ($message in $Messages) {
        [void]$script:transcriptIds.Add($message.id)
        $script:transcriptRows[$message.id] = $message
    }
    return $script:transcriptIdentity
}

function Assert-ExpectedTranscript($Actual, $Expected) {
    if (-not $Expected -or $Actual.targetId -cne $Expected.targetId) {
        throw 'The active VS Code chat changed before submission. Nothing was sent.'
    }
    $a = @($Actual.messages | ForEach-Object { [ordered]@{ id = $_.id; role = $_.role; text = $_.text } }) | ConvertTo-Json -Depth 6 -Compress
    $b = @($Expected.messages | ForEach-Object { [ordered]@{ id = $_.id; role = $_.role; text = $_.text } }) | ConvertTo-Json -Depth 6 -Compress
    if ($a -cne $b) { throw 'The active transcript changed before submission. Check the draft locally; nothing was sent.' }
}

function Get-ResponseText($Element) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $type = $Element.Current.ControlType
    if ($type -eq [System.Windows.Automation.ControlType]::Button -or
        $type -eq [System.Windows.Automation.ControlType]::ToolBar) { return '' }
    if ($type -eq [System.Windows.Automation.ControlType]::Table) {
        $lines = @()
        $row = $walker.GetFirstChild($Element)
        while ($row) {
            $cells = @()
            $cell = $walker.GetFirstChild($row)
            while ($cell) {
                $cells += ((Get-ResponseText $cell) -replace '\|', '\|' -replace '\r?\n', ' ')
                $cell = $walker.GetNextSibling($cell)
            }
            if ($cells.Count -gt 0) {
                $lines += '| ' + ($cells -join ' | ') + ' |'
                if ($lines.Count -eq 1) { $lines += '| ' + ((@('---') * $cells.Count) -join ' | ') + ' |' }
            }
            $row = $walker.GetNextSibling($row)
        }
        return "`n`n" + ($lines -join "`n") + "`n`n"
    }
    $child = $walker.GetFirstChild($Element)
    if (-not $child) {
        if ($type -eq [System.Windows.Automation.ControlType]::Text -or
            $type -eq [System.Windows.Automation.ControlType]::Hyperlink -or
            $type -eq [System.Windows.Automation.ControlType]::DataItem) {
            return $Element.Current.Name
        }
        return ''
    }
    $texts = @()
    while ($child) {
        $text = Get-ResponseText $child
        if ($text) { $texts += $text }
        $child = $walker.GetNextSibling($child)
    }
    return $texts -join ' '
}

function Get-Snapshot($Context) {
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try {
            return Get-SnapshotOnce $Context
        } catch [System.IO.InvalidDataException] {
            if ($attempt -eq 2) { throw }
            Start-Sleep -Milliseconds 100
            $Context = Get-Context
        }
    }
}

function Get-SnapshotOnce($Context) {
    $buttons = Get-Buttons $Context.group
    $busy = @($buttons | Where-Object {
        -not $_.Current.IsOffscreen -and $_.Current.ClassName -match '\bcodicon-stop-circle\b'
    }).Count -gt 0
    $prompts = @($buttons | Where-Object {
        -not $_.Current.IsOffscreen -and $_.Current.IsEnabled -and
        $_.Current.Name -match '^(Allow|Approve|Continue|Submit Answer|Submit answer)( once| for .*)?$'
    })
    $blocked = $null
    if ($prompts.Count -gt 0) { $blocked = 'VS Code is waiting for local confirmation or input. Respond in VS Code; the relay never clicks approvals.' }
    $rows = $Context.chat.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $messages = @()
    foreach ($row in $rows) {
        $class = $row.Current.ClassName
        $role = $null
        if ($class -match '\brequest\b') { $role = 'user' }
        elseif ($class -match '\bresponse\b') { $role = 'assistant' }
        if (-not $role) { continue }
        $text = ''
        $completed = $false
        if ($role -eq 'user') {
            $text = $row.Current.Name
        } else {
            $groups = Find-All $row ([System.Windows.Automation.AutomationElement]::ControlTypeProperty) ([System.Windows.Automation.ControlType]::Group)
            $parts = @($groups | Where-Object { $_.Current.ClassName -match '^chat-markdown-part rendered-markdown(?: |$)' })
            $paragraphs = @()
            foreach ($part in $parts) {
                $pattern = $null
                if ($part.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
                    $paragraphs += $pattern.DocumentRange.GetText(-1)
                } else {
                    $paragraphs += Get-ResponseText $part
                }
            }
            if ($parts.Count -eq 0) {
                $containers = @($groups | Where-Object { $_.Current.ClassName -match '\binteractive-response\b' })
                foreach ($container in $containers) {
                    $children = $container.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
                    foreach ($child in $children) {
                        if ($child.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -or
                            $child.Current.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink) {
                            $paragraphs += $child.Current.Name
                        }
                    }
                }
            }
            $text = $paragraphs -join "`n`n"
            $completed = @($groups | Where-Object {
                $_.Current.ClassName -eq 'chat-footer-details' -and $_.Current.Name -match '^Completed '
            }).Count -gt 0
        }
        $messages += @{
            id = $row.Current.AutomationId
            role = $role
            text = $text
            completed = $completed
        }
    }
    $snapshot = @{
        targetId = Get-TranscriptIdentity ($Context.chat.GetRuntimeId() -join ',') $messages
        busy = $busy
        messages = @($messages)
    }
    if ($blocked) { $snapshot.blocked = $blocked }
    return $snapshot
}

function Get-InputValue($InputElement) {
    $pattern = $InputElement.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return $pattern.Current.Value.TrimEnd([char[]]"`r`n")
}

function Assert-Focus($Context) {
    if ([BridgeNative]::GetForegroundWindow() -ne [IntPtr]$Context.window.Current.NativeWindowHandle) {
        throw 'Focus left the bound VS Code window. Submission cancelled; check the draft locally.'
    }
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if (-not [System.Windows.Automation.Automation]::Compare($focused, $Context.input)) {
        throw 'Focus left the Chat Input. Submission cancelled; check the draft locally.'
    }
    foreach ($key in @(16,17,18,91,92)) {
        if (([BridgeNative]::GetAsyncKeyState($key) -band 0x8000) -ne 0) {
            throw 'A modifier key is pressed. Submission cancelled; check the draft locally.'
        }
    }
}

function Write-Draft($Context, [string]$Text) {
    if ((Get-InputValue $Context.input).Length -ne 0) { throw 'The VS Code input already contains a draft. It was not changed.' }
    foreach ($key in @(16,17,18,91,92)) {
        if (([BridgeNative]::GetAsyncKeyState($key) -band 0x8000) -ne 0) { throw 'Release modifier keys before using the relay.' }
    }
    [void][BridgeNative]::SetForegroundWindow([IntPtr]$Context.window.Current.NativeWindowHandle)
    $Context.input.SetFocus()
    Start-Sleep -Milliseconds 100
    Assert-Focus $Context
    $normalized = $Text.Replace("`r`n", "`n")
    if ($normalized -match '[\x00-\x09\x0B-\x1F\x7F]') { throw 'Unsupported control character in message. Nothing was typed.' }
    for ($offset = 0; $offset -lt $normalized.Length; $offset += 32) {
        Assert-Focus $Context
        [BridgeNative]::Text($normalized.Substring($offset, [Math]::Min(32, $normalized.Length - $offset)))
    }
    Start-Sleep -Milliseconds 300
    Assert-Focus $Context
    if ((Get-InputValue $Context.input) -cne $normalized.TrimEnd([char[]]"`r`n")) {
        throw 'VS Code input readback did not match the message. Not submitted; inspect the draft locally.'
    }
}

function Submit-Message([string]$Text, $Expected) {
    if ([string]::IsNullOrWhiteSpace($Text) -or $Text.Length -gt 20000) { throw 'Message must contain 1 to 20000 characters.' }
    $context = Get-Context
    $snapshot = Get-Snapshot $context
    Assert-ExpectedTranscript $snapshot $Expected
    if ($snapshot.busy) { throw 'The bound VS Code chat is busy. Wait for its response to finish.' }
    if ($snapshot.blocked) { throw $snapshot.blocked }
    Write-Draft $context $Text
    $verified = Get-Context
    Assert-Focus $verified
    $verifiedSnapshot = Get-Snapshot $verified
    Assert-ExpectedTranscript $verifiedSnapshot $Expected
    if ($verifiedSnapshot.busy -or $verifiedSnapshot.blocked) { throw 'The chat became busy or blocked before submission. Draft was not submitted.' }
    if ((Get-InputValue $verified.input) -cne $Text.Replace("`r`n", "`n").TrimEnd([char[]]"`r`n")) {
        throw 'The draft changed before submission. It was not sent.'
    }
    $buttons = Get-Buttons $verified.group
    $send = @($buttons | Where-Object {
        -not $_.Current.IsOffscreen -and $_.Current.IsEnabled -and
        $_.Current.Name -match '^Send(?:$| \(| to Agent(?:$| \())'
    })
    if ($send.Count -gt 1) { throw 'Multiple Send buttons were found. Draft was not submitted.' }
    Assert-Focus $verified
    if ($send.Count -eq 1) {
        $invoke = $send[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $invoke.Invoke()
    } elseif ($verified.input.Current.Name -match '\bPress Enter to send\b') {
        # The accessible editor advertises its submit binding even when the toolbar differs.
        [BridgeNative]::Submit()
    } else {
        throw 'No unambiguous Send action or advertised Enter-to-send binding was found. Draft was not submitted.'
    }
}

$script:target = $null
if ($Bind) {
    $context = Get-Context
    $binding = @{
        selectionMode = $(if ($WindowProcessId -gt 0) { 'pinned' } else { 'first' })
        processId = $context.process.Id
        processStartedAt = $context.process.StartTime.ToUniversalTime().ToString('O')
    }
    $parent = Split-Path -Parent ([System.IO.Path]::GetFullPath($TargetFile))
    [void][System.IO.Directory]::CreateDirectory($parent)
    [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($TargetFile), ($binding | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
    $binding | ConvertTo-Json -Compress
    exit
}

if ($WindowProcessId -eq 0 -and (Test-Path -LiteralPath $TargetFile)) {
    $binding = Get-Content -LiteralPath $TargetFile -Raw | ConvertFrom-Json
    if ($binding.selectionMode -eq 'pinned') {
        $script:target = $binding
        $WindowProcessId = [int]$script:target.processId
    }
}

if ($Inspect) {
    Get-Snapshot (Get-Context) | ConvertTo-Json -Depth 12 -Compress
    exit
}
if ($Probe) {
    $context = Get-Context
    $sentinel = "Mcpro UI relay probe - NOT SUBMITTED`nSecond line: multiline caf" + [char]0x00e9 + '.'
    Write-Draft $context $sentinel
    Assert-Focus $context
    [BridgeNative]::Clear()
    Start-Sleep -Milliseconds 300
    if ((Get-InputValue $context.input).Length -ne 0) { throw 'Probe draft cleanup failed. Check VS Code input locally.' }
    @{ ok = $true; message = 'Draft insertion and readback verified, then draft cleared. Nothing submitted.' } | ConvertTo-Json -Compress
    exit
}

while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $null
    try {
        $request = $line | ConvertFrom-Json
        if ($request.command -eq 'inspect') { $result = Get-Snapshot (Get-Context) }
        elseif ($request.command -eq 'submit') {
            Submit-Message ([string]$request.text) $request.expected
            $result = @{ submitted = $true }
        } else { throw 'Unsupported automation command.' }
        @{ id = $request.id; result = $result } | ConvertTo-Json -Compress -Depth 12 | ForEach-Object { [Console]::WriteLine($_) }
    } catch {
        @{ id = $request.id; error = "$($_.Exception.Message) (UI worker line $($_.InvocationInfo.ScriptLineNumber))" } | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
    }
}
