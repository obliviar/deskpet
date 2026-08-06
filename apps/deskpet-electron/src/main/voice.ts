import { ipcMain, app } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

function getModelDir(): string {
  return join(app.getPath('userData'), 'vosk-model-small-cn-0.22')
}

function getScriptPath(): string {
  return join(app.getPath('userData'), 'vosk_transcribe.py')
}

export function setupVoiceIPC() {
  ipcMain.handle('voice:check-model', async () => {
    const modelExists = existsSync(getModelDir())
    const scriptExists = existsSync(getScriptPath())
    let pythonOk = false
    try {
      const result = await runCommand('python', ['--version'])
      pythonOk = result.includes('Python')
    }
    catch { /* try python3 */ }
    if (!pythonOk) {
      try {
        const result = await runCommand('python3', ['--version'])
        pythonOk = result.includes('Python')
      }
      catch { /* not found */ }
    }
    let voskOk = false
    if (pythonOk) {
      try {
        await runCommand('python', ['-c', 'import vosk'])
        voskOk = true
      }
      catch { /* vosk not installed */ }
    }
    return { modelExists, scriptExists, pythonOk, voskOk }
  })

  ipcMain.handle('voice:setup', async () => {
    const userData = app.getPath('userData')
    await mkdir(userData, { recursive: true })

    // Write the transcription script
    const script = `
import sys, json, wave
from vosk import Model, KaldiRecognizer

model = Model(r"${getModelDir().replace(/\\/g, '\\\\')}")
wf = wave.open(sys.argv[1], "rb")
rec = KaldiRecognizer(model, wf.getframerate())
rec.SetWords(True)
text = ""
while True:
    data = wf.readframes(4000)
    if len(data) == 0:
        break
    if rec.AcceptWaveform(data):
        res = json.loads(rec.Result())
        text += res.get("text", "")
final = json.loads(rec.FinalResult())
text += final.get("text", "")
print(text.strip())
`
    await writeFile(getScriptPath(), script, 'utf-8')

    // Download model if not exists
    if (!existsSync(getModelDir())) {
      const modelUrl = 'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip'
      const zipPath = join(userData, 'vosk-model.zip')
      await runCommand('python', ['-c', `
import urllib.request, zipfile, os
url = r"${modelUrl}"
zip_path = r"${zipPath.replace(/\\/g, '\\\\')}"
extract_to = r"${userData.replace(/\\/g, '\\\\')}"
print("Downloading model...")
urllib.request.urlretrieve(url, zip_path)
print("Extracting...")
with zipfile.ZipFile(zip_path, 'r') as z:
    z.extractall(extract_to)
os.remove(zip_path)
print("Model ready")
`])
    }

    // Install vosk if not installed
    try {
      await runCommand('python', ['-c', 'import vosk'])
    }
    catch {
      await runCommand('python', ['-m', 'pip', 'install', 'vosk'])
    }

    return { ok: true }
  })

  ipcMain.handle('voice:transcribe', async (_event, audioBuffer: ArrayBuffer) => {
    const userData = app.getPath('userData')
    const tempFile = join(userData, `rec-${randomBytes(4).toString('hex')}.wav`)

    try {
      await writeFile(tempFile, Buffer.from(audioBuffer))
      const text = await runCommand('python', [getScriptPath(), tempFile])
      return { ok: true, text: text.trim() }
    }
    catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'transcription failed' }
    }
    finally {
      await unlink(tempFile).catch(() => {})
    }
  })
}

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr || `exit code ${code}`))
    })
  })
}