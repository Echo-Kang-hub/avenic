# A Windows pseudoconsole (ConPTY) client, so a test can run the CLI on a real
# console-backed TTY and keep what it painted. The CLI's fast path never needs
# this; the terminal layer does — a frame only redraws when stdout is a TTY.
#
#   powershell -NoProfile -File conpty-capture.ps1 -Exe <exe> -ArgsFile <json file> \
#     -Cwd <dir> -Columns 100 -Rows 40 -Out <file> [-Input <base64>] [-InputDelayMs 1500]
#
# The child's arguments come from a JSON file, not from the command line: the
# PowerShell tokenizer eats brackets and commas, so an inline `["-e","x"]` does
# not survive the trip.
#
# Writes the raw console bytes to -Out and prints one JSON line to stdout:
#   {"status":"ok","exitCode":0,"bytes":1234}
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$ArgsFile = "",
  [string]$Cwd = "",
  [int]$Columns = 100,
  [int]$Rows = 40,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Input = "",
  [int]$InputDelayMs = 1200,
  [int]$TimeoutMs = 60000
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

public static class ConPtyCapture {
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFO {
    public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES attrs, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint flags, out IntPtr phPC);
  [DllImport("kernel32.dll", SetLastError = true)] static extern void ClosePseudoConsole(IntPtr hPC);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder commandLine, IntPtr procAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInfo);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr file, byte[] buffer, int toRead, out int read, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr file, byte[] buffer, int toWrite, out int written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetCurrentThread();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CancelSynchronousIo(IntPtr thread);

  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = new IntPtr(0x00020016);

  static string Quote(string argument) {
    if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return argument;
    StringBuilder quoted = new StringBuilder("\"");
    int backslashes = 0;
    foreach (char c in argument) {
      if (c == '\\') { backslashes++; continue; }
      if (c == '"') { quoted.Append('\\', backslashes * 2 + 1).Append('"'); backslashes = 0; continue; }
      quoted.Append('\\', backslashes).Append(c); backslashes = 0;
    }
    quoted.Append('\\', backslashes * 2).Append('"');
    return quoted.ToString();
  }

  static IntPtr readerThreadHandle = IntPtr.Zero;
  static readonly System.Collections.Generic.List<byte[]> consoleChunks = new System.Collections.Generic.List<byte[]>();

  /** Waits until the reader thread has published its own handle. */
  static IntPtr ReaderHandle() {
    for (int spin = 0; spin < 500 && readerThreadHandle == IntPtr.Zero; spin++) Thread.Sleep(2);
    return readerThreadHandle;
  }

  static void ReaderLoop(IntPtr pipe) {
    readerThreadHandle = GetCurrentThread();
    byte[] buffer = new byte[65536];
    while (true) {
      int read;
      if (!ReadFile(pipe, buffer, buffer.Length, out read, IntPtr.Zero) || read == 0) break;
      byte[] copy = new byte[read];
      Array.Copy(buffer, copy, read);
      lock (consoleChunks) consoleChunks.Add(copy);
    }
  }

  /**
   * Runs `exe args` on a pseudoconsole, feeds `input`, and writes the console
   * bytes to `outPath`. The reader runs on its own thread: a pseudoconsole only
   * reaches EOF when the console closes, so the main thread waits for the child
   * to exit, drains briefly, and then cancels the blocking read.
   */
  public static string Capture(string exe, string[] args, string cwd, short columns, short rows, string input, int inputDelayMs, string outPath, int timeoutMs, out int exitCode) {
    SECURITY_ATTRIBUTES attrs = new SECURITY_ATTRIBUTES();
    attrs.nLength = Marshal.SizeOf(attrs);
    attrs.bInheritHandle = 1;
    IntPtr consoleIn = IntPtr.Zero, consoleInWrite = IntPtr.Zero, consoleOut = IntPtr.Zero, consoleOutWrite = IntPtr.Zero;
    IntPtr pty = IntPtr.Zero, attributeList = IntPtr.Zero;
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    Thread reader = null;
    exitCode = -1;
    lock (consoleChunks) consoleChunks.Clear();
    try {
      if (!CreatePipe(out consoleIn, out consoleInWrite, ref attrs, 0)) throw new Exception("CreatePipe(in) failed: " + Marshal.GetLastWin32Error());
      if (!CreatePipe(out consoleOut, out consoleOutWrite, ref attrs, 0)) throw new Exception("CreatePipe(out) failed: " + Marshal.GetLastWin32Error());
      COORD size; size.X = columns; size.Y = rows;
      int hr = CreatePseudoConsole(size, consoleIn, consoleOutWrite, 0, out pty);
      if (hr != 0) throw new Exception("CreatePseudoConsole failed: 0x" + hr.ToString("x8"));

      IntPtr attributeSize = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
      attributeList = Marshal.AllocHGlobal(attributeSize);
      if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize)) throw new Exception("InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
      if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pty, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Exception("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());

      STARTUPINFOEX startupInfo = new STARTUPINFOEX();
      startupInfo.StartupInfo.cb = Marshal.SizeOf(startupInfo);
      startupInfo.lpAttributeList = attributeList;
      // Handing the child no std handles at all is what lets the pseudoconsole
      // install its own: inherited ones (this process has a real console) win,
      // and then the child sees a pipe instead of a terminal.
      startupInfo.StartupInfo.dwFlags = 0x100; // STARTF_USESTDHANDLES, all three null

      StringBuilder commandLine = new StringBuilder();
      commandLine.Append(Quote(exe));
      foreach (string argument in args) commandLine.Append(' ').Append(Quote(argument));

      if (!CreateProcessW(exe, commandLine, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd.Length > 0 ? cwd : null, ref startupInfo, out process)) {
        throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
      }
      CloseHandle(consoleIn); consoleIn = IntPtr.Zero;
      CloseHandle(consoleOutWrite); consoleOutWrite = IntPtr.Zero;

      readerThreadHandle = IntPtr.Zero;
      reader = new Thread(delegate() { ReaderLoop(consoleOut); });
      reader.IsBackground = true;
      reader.Start();

      // The input pipe stays open for the whole run: closing it ends the console
      // input, and conhost answers that by killing the attached process group.
      if (input.Length > 0 && inputDelayMs >= 0) {
        Thread.Sleep(inputDelayMs);
        byte[] inputBytes = Encoding.UTF8.GetBytes(input);
        int written;
        WriteFile(consoleInWrite, inputBytes, inputBytes.Length, out written, IntPtr.Zero);
      }

      uint waited = WaitForSingleObject(process.hProcess, (uint)timeoutMs);
      if (waited != 0) {
        TerminateProcess(process.hProcess, 124);
        exitCode = 124;
      } else {
        uint code;
        GetExitCodeProcess(process.hProcess, out code);
        exitCode = (int)code;
      }

      // Let the last frames drain, then end the blocking read.
      Thread.Sleep(350);
      IntPtr readerNative = ReaderHandle();
      if (readerNative != IntPtr.Zero) CancelSynchronousIo(readerNative);
      reader.Join(2000);

      using (System.IO.FileStream file = new System.IO.FileStream(outPath, System.IO.FileMode.Create, System.IO.FileAccess.Write)) {
        lock (consoleChunks) {
          foreach (byte[] chunk in consoleChunks) file.Write(chunk, 0, chunk.Length);
          consoleChunks.Clear();
        }
      }
      return "ok";
    } finally {
      if (reader != null && reader.IsAlive) { IntPtr native = ReaderHandle(); if (native != IntPtr.Zero) CancelSynchronousIo(native); reader.Join(1000); }
      if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
      if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
      if (pty != IntPtr.Zero) ClosePseudoConsole(pty);
      foreach (IntPtr handle in new IntPtr[] { consoleIn, consoleInWrite, consoleOut, consoleOutWrite }) { if (handle != IntPtr.Zero) CloseHandle(handle); }
      if (attributeList != IntPtr.Zero) { DeleteProcThreadAttributeList(attributeList); Marshal.FreeHGlobal(attributeList); }
    }
  }
}
"@

$argList = @()
if ($ArgsFile.Length -gt 0) {
  $parsed = (Get-Content -LiteralPath $ArgsFile -Raw -Encoding UTF8) | ConvertFrom-Json
  if ($null -ne $parsed) { $argList = @($parsed) }
}
$inputText = ""
if ($Input.Length -gt 0) { $inputText = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Input)) }
$exePath = $Exe
if (-not (Test-Path -LiteralPath $exePath)) {
  $resolved = Get-Command $Exe -ErrorAction SilentlyContinue
  if ($resolved -and $resolved.Source) { $exePath = $resolved.Source }
}

$exitCode = -1
$status = "ok"
try {
  $status = [ConPtyCapture]::Capture($exePath, $argList, $Cwd, [int16]$Columns, [int16]$Rows, $inputText, $InputDelayMs, $Out, $TimeoutMs, [ref]$exitCode)
} catch {
  $status = "error: $($_.Exception.Message)"
}
$bytes = 0
if (Test-Path $Out) { $bytes = (Get-Item $Out).Length }
Write-Output (ConvertTo-Json -Compress @{ status = $status; exitCode = $exitCode; bytes = $bytes })
