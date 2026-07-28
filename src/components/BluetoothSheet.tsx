import { useEffect, useState } from 'react'
import { audioEngine } from '../lib/audioEngine'
import { IconBluetooth, IconClose } from './Icons'
import './TrackList.css'
import './BluetoothSheet.css'

type AudioOut = { deviceId: string; label: string }

interface Props {
  open: boolean
  onClose: () => void
}

function canSelectAudioOutput(): boolean {
  return typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof (navigator.mediaDevices as MediaDevices & {
      selectAudioOutput?: () => Promise<MediaDeviceInfo>
    }).selectAudioOutput === 'function'
}

function canSetSinkId(): boolean {
  return typeof HTMLAudioElement !== 'undefined' &&
    typeof (HTMLAudioElement.prototype as HTMLAudioElement & {
      setSinkId?: unknown
    }).setSinkId === 'function'
}

async function listAudioOutputs(): Promise<AudioOut[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  try {
    // En algunos navegadores hace falta un permiso previo para ver etiquetas
    await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
      s.getTracks().forEach((t) => t.stop())
    }).catch(() => undefined)
  } catch {
    // ignore
  }
  const all = await navigator.mediaDevices.enumerateDevices()
  return all
    .filter((d) => d.kind === 'audiooutput')
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `Salida de audio ${i + 1}`,
    }))
}

function openSystemBluetoothSettings() {
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) {
    window.location.href =
      'intent:#Intent;action=android.settings.BLUETOOTH_SETTINGS;end'
    return true
  }
  return false
}

export function BluetoothSheet({ open, onClose }: Props) {
  const [devices, setDevices] = useState<AudioOut[]>([])
  const [activeId, setActiveId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMessage(null)
    setError(null)
    setActiveId(audioEngine.sinkId)
    if (canSetSinkId()) {
      void listAudioOutputs()
        .then(setDevices)
        .catch(() => setDevices([]))
    }
  }, [open])

  if (!open) return null

  async function pickWithBrowser() {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const md = navigator.mediaDevices as MediaDevices & {
        selectAudioOutput: () => Promise<MediaDeviceInfo>
      }
      const device = await md.selectAudioOutput()
      await audioEngine.setSinkId(device.deviceId)
      setActiveId(device.deviceId)
      setMessage(`Sonido por: ${device.label || 'dispositivo elegido'}`)
      const list = await listAudioOutputs()
      setDevices(list)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        setError('Permiso denegado para elegir salida de audio.')
      } else if (e instanceof DOMException && e.name === 'AbortError') {
        // usuario canceló
      } else {
        setError(e instanceof Error ? e.message : 'No se pudo elegir el altavoz')
      }
    } finally {
      setBusy(false)
    }
  }

  async function pickDevice(id: string, label: string) {
    setBusy(true)
    setError(null)
    try {
      await audioEngine.setSinkId(id)
      setActiveId(id)
      setMessage(`Sonido por: ${label}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar la salida')
    } finally {
      setBusy(false)
    }
  }

  function pairNew() {
    setError(null)
    const opened = openSystemBluetoothSettings()
    if (opened) {
      setMessage('Se abrieron los ajustes de Bluetooth. Empareja el altavoz y vuelve aquí.')
      return
    }
    setMessage(
      'Empareja el altavoz en los ajustes Bluetooth de tu móvil o PC. Luego vuelve y pulsa “Elegir altavoz”.',
    )
  }

  return (
    <div className="sheet bt-sheet">
      <button type="button" className="sheet-backdrop" aria-label="Cerrar" onClick={onClose} />
      <div className="sheet__panel bt-sheet__panel" role="dialog" aria-labelledby="bt-title">
        <div className="bt-sheet__head">
          <h3 id="bt-title">
            <IconBluetooth size={22} /> Altavoz / Bluetooth
          </h3>
          <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
            <IconClose size={22} />
          </button>
        </div>

        <p className="bt-sheet__lead">
          MyVibe usa el audio del sistema. Primero empareja el altavoz (o Alexa en modo Bluetooth)
          en tu móvil/PC; después elige aquí la salida.
        </p>

        <div className="bt-sheet__actions">
          <button type="button" className="btn-primary" disabled={busy} onClick={pairNew}>
            Emparejar dispositivo nuevo
          </button>

          {canSelectAudioOutput() && (
            <button
              type="button"
              className="bt-sheet__secondary"
              disabled={busy}
              onClick={() => void pickWithBrowser()}
            >
              Elegir altavoz (buscar salidas)
            </button>
          )}
        </div>

        {canSetSinkId() && devices.length > 0 && (
          <ul className="bt-sheet__list">
            <li className="bt-sheet__list-label">Salidas disponibles</li>
            {devices.map((d) => (
              <li key={d.deviceId || d.label}>
                <button
                  type="button"
                  className={activeId === d.deviceId ? 'is-active' : ''}
                  disabled={busy}
                  onClick={() => void pickDevice(d.deviceId, d.label)}
                >
                  <IconBluetooth size={18} />
                  <span>{d.label}</span>
                  {activeId === d.deviceId ? <em>En uso</em> : null}
                </button>
              </li>
            ))}
          </ul>
        )}

        {!canSetSinkId() && (
          <p className="bt-sheet__note">
            Este navegador no permite cambiar la salida desde la web. Conecta el altavoz por
            Bluetooth en el sistema y el audio de MyVibe saldrá por él automáticamente.
          </p>
        )}

        <ol className="bt-sheet__steps">
          <li>Activa Bluetooth en el altavoz / Alexa (modo emparejar).</li>
          <li>En el móvil o PC: Ajustes → Bluetooth → vincular.</li>
          <li>Vuelve a MyVibe y pulsa “Elegir altavoz” si aparece la lista.</li>
        </ol>

        {message && <p className="form-status">{message}</p>}
        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  )
}
