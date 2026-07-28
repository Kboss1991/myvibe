import { useCallback, useEffect, useState } from 'react'
import { audioEngine } from '../lib/audioEngine'
import {
  IconBluetooth,
  IconClose,
  IconComputer,
  IconHeadphones,
  IconRefresh,
  IconSpeaker,
} from './Icons'
import './TrackList.css'
import './BluetoothSheet.css'

type AudioOut = {
  deviceId: string
  label: string
  kind: 'phone' | 'speaker' | 'headphones' | 'other'
}

interface Props {
  open: boolean
  onClose: () => void
}

const SINK_KEY = 'myvibe_audio_sink'

function canSelectAudioOutput(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof (navigator.mediaDevices as MediaDevices & {
      selectAudioOutput?: () => Promise<MediaDeviceInfo>
    }).selectAudioOutput === 'function'
  )
}

function canSetSinkId(): boolean {
  return (
    typeof HTMLAudioElement !== 'undefined' &&
    typeof (HTMLAudioElement.prototype as HTMLAudioElement & {
      setSinkId?: unknown
    }).setSinkId === 'function'
  )
}

function classifyOutput(label: string): AudioOut['kind'] {
  const l = label.toLowerCase()
  if (/headphone|auricular|airpods|buds|headset|cascos/i.test(l)) return 'headphones'
  if (/speaker|altavoz|soundbar|echo|alexa|homepod|jbl|bose|sony|marshall/i.test(l)) {
    return 'speaker'
  }
  if (/speaker|default|interno|built-in|macbook|laptop|pc|computer|altavoces/i.test(l)) {
    return 'phone'
  }
  return 'other'
}

function DeviceIcon({ kind }: { kind: AudioOut['kind'] }) {
  if (kind === 'headphones') return <IconHeadphones size={22} />
  if (kind === 'speaker') return <IconSpeaker size={22} />
  if (kind === 'phone') return <IconComputer size={22} />
  return <IconBluetooth size={22} />
}

async function listAudioOutputs(): Promise<AudioOut[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  try {
    // Necesario en muchos navegadores para ver etiquetas reales
    await navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => s.getTracks().forEach((t) => t.stop()))
      .catch(() => undefined)
  } catch {
    // ignore
  }
  const all = await navigator.mediaDevices.enumerateDevices()
  return all
    .filter((d) => d.kind === 'audiooutput')
    .map((d, i) => {
      const label = d.label || `Dispositivo ${i + 1}`
      return {
        deviceId: d.deviceId,
        label,
        kind: classifyOutput(label),
      }
    })
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
  const [scanning, setScanning] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const supportsPicker = canSelectAudioOutput()
  const supportsSink = canSetSinkId()

  const refresh = useCallback(async () => {
    if (!supportsSink) {
      setDevices([])
      return
    }
    setScanning(true)
    setError(null)
    try {
      const list = await listAudioOutputs()
      setDevices(list)
      const current = audioEngine.sinkId || localStorage.getItem(SINK_KEY) || ''
      setActiveId(current)
      if (!list.length) {
        setMessage(
          'No hay salidas visibles aún. Empareja el altavoz en Bluetooth del sistema y pulsa Actualizar.',
        )
      } else {
        setMessage(null)
      }
    } catch {
      setDevices([])
      setError('No se pudo listar dispositivos. Revisa permisos del micrófono/audio.')
    } finally {
      setScanning(false)
    }
  }, [supportsSink])

  useEffect(() => {
    if (!open) return
    setMessage(null)
    setError(null)
    void audioEngine.restoreSinkId()
    void refresh()

    const onChange = () => void refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange)
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', onChange)
    }
  }, [open, refresh])

  if (!open) return null

  /** Como el buscador de Spotify: abre el picker nativo del navegador */
  async function searchDevices() {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      if (supportsPicker) {
        const md = navigator.mediaDevices as MediaDevices & {
          selectAudioOutput: () => Promise<MediaDeviceInfo>
        }
        const device = await md.selectAudioOutput()
        await audioEngine.setSinkId(device.deviceId)
        setActiveId(device.deviceId)
        setMessage(`Reproduciendo en: ${device.label || 'dispositivo elegido'}`)
        await refresh()
        return
      }

      // Sin picker: refrescar lista + guía de emparejar
      await refresh()
      if (!supportsSink) {
        setMessage(
          'En este navegador el audio sigue la salida del sistema. Conecta el Bluetooth en Ajustes y MyVibe sonará ahí.',
        )
        return
      }
      setMessage(
        'Elige un dispositivo de la lista. Si no aparece, emparéjalo primero en Ajustes → Bluetooth.',
      )
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        setError('Permiso denegado. Permite elegir la salida de audio e inténtalo de nuevo.')
      } else if (e instanceof DOMException && e.name === 'AbortError') {
        // canceló
      } else {
        setError(e instanceof Error ? e.message : 'No se pudo buscar dispositivos')
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
      setMessage(`Reproduciendo en: ${label}`)
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
      setMessage('Abre Ajustes Bluetooth, empareja el altavoz y vuelve. Luego pulsa Buscar.')
      return
    }
    setMessage(
      'Ve a Ajustes → Bluetooth de tu móvil/PC, empareja el altavoz (o Alexa en modo BT) y vuelve aquí a Buscar dispositivos.',
    )
  }

  return (
    <div className="sheet bt-sheet">
      <button type="button" className="sheet-backdrop" aria-label="Cerrar" onClick={onClose} />
      <div className="sheet__panel bt-sheet__panel" role="dialog" aria-labelledby="bt-title">
        <div className="bt-sheet__head">
          <div>
            <p className="bt-sheet__eyebrow">Conectar a un dispositivo</p>
            <h3 id="bt-title">Escuchar en…</h3>
          </div>
          <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
            <IconClose size={22} />
          </button>
        </div>

        <button
          type="button"
          className="bt-sheet__search"
          disabled={busy || scanning}
          onClick={() => void searchDevices()}
        >
          <IconBluetooth size={22} />
          <span>
            {scanning ? 'Buscando…' : supportsPicker ? 'Buscar dispositivos' : 'Actualizar dispositivos'}
          </span>
        </button>

        <div className="bt-sheet__toolbar">
          <button
            type="button"
            className="bt-sheet__ghost"
            disabled={busy || scanning}
            onClick={() => void refresh()}
          >
            <IconRefresh size={16} /> Actualizar lista
          </button>
          <button type="button" className="bt-sheet__ghost" disabled={busy} onClick={pairNew}>
            Emparejar nuevo
          </button>
        </div>

        <ul className="bt-sheet__list">
          <li className="bt-sheet__list-label">Disponibles cerca / conectados</li>
          {devices.length === 0 && (
            <li className="bt-sheet__empty">
              {supportsSink
                ? 'Ningún altavoz listado. Empareja por Bluetooth del sistema y pulsa Buscar.'
                : 'Este navegador no lista salidas. Conecta el Bluetooth en el sistema: MyVibe usará esa salida automáticamente.'}
            </li>
          )}
          {devices.map((d) => {
            const active = activeId === d.deviceId || (!activeId && d.deviceId === 'default')
            return (
              <li key={d.deviceId || d.label}>
                <button
                  type="button"
                  className={active ? 'is-active' : ''}
                  disabled={busy}
                  onClick={() => void pickDevice(d.deviceId, d.label)}
                >
                  <span className="bt-sheet__icon">
                    <DeviceIcon kind={d.kind} />
                  </span>
                  <span className="bt-sheet__meta">
                    <strong>{d.label}</strong>
                    <small>
                      {d.kind === 'headphones'
                        ? 'Auriculares'
                        : d.kind === 'speaker'
                          ? 'Altavoz Bluetooth'
                          : d.kind === 'phone'
                            ? 'Este dispositivo'
                            : 'Salida de audio'}
                    </small>
                  </span>
                  {active ? <em className="bt-sheet__now">En uso</em> : null}
                </button>
              </li>
            )
          })}
        </ul>

        <p className="bt-sheet__note">
          Como en Spotify: eliges dónde suena. La diferencia es que el <strong>emparejamiento</strong>{' '}
          Bluetooth lo hace el sistema (Ajustes). Aquí solo eliges la salida ya conectada y MyVibe
          reproduce ahí.
        </p>

        {message && <p className="form-status">{message}</p>}
        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  )
}
