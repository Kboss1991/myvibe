/** ZIP sin compresión (STORE). Ideal para MP3 ya comprimidos. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  return b
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  b[2] = (n >>> 16) & 0xff
  b[3] = (n >>> 24) & 0xff
  return b
}

export interface ZipEntry {
  name: string
  data: Uint8Array
}

export function buildZipBlob(entries: ZipEntry[]): Blob {
  const enc = new TextEncoder()
  const parts: BlobPart[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name.replace(/\\/g, '/'))
    const data = entry.data
    const crc = crc32(data)
    const size = data.byteLength

    const local = new Uint8Array(30 + nameBytes.length)
    local.set([0x50, 0x4b, 0x03, 0x04], 0)
    local.set(u16(20), 4) // version needed
    local.set(u16(0), 6) // flags
    local.set(u16(0), 8) // method STORE
    local.set(u16(0), 10) // time
    local.set(u16(0), 12) // date
    local.set(u32(crc), 14)
    local.set(u32(size), 18)
    local.set(u32(size), 22)
    local.set(u16(nameBytes.length), 26)
    local.set(u16(0), 28) // extra
    local.set(nameBytes, 30)

    parts.push(local, data as BlobPart)

    const central = new Uint8Array(46 + nameBytes.length)
    central.set([0x50, 0x4b, 0x01, 0x02], 0)
    central.set(u16(20), 4)
    central.set(u16(20), 6)
    central.set(u16(0), 8)
    central.set(u16(0), 10)
    central.set(u16(0), 12)
    central.set(u16(0), 14)
    central.set(u32(crc), 16)
    central.set(u32(size), 20)
    central.set(u32(size), 24)
    central.set(u16(nameBytes.length), 28)
    central.set(u16(0), 30)
    central.set(u16(0), 32)
    central.set(u16(0), 34)
    central.set(u16(0), 36)
    central.set(u32(0), 38)
    central.set(u32(offset), 42)
    central.set(nameBytes, 46)
    centralParts.push(central)

    offset += local.length + size
  }

  const centralSize = centralParts.reduce((n, p) => n + p.length, 0)
  const end = new Uint8Array(22)
  end.set([0x50, 0x4b, 0x05, 0x06], 0)
  end.set(u16(0), 4)
  end.set(u16(0), 6)
  end.set(u16(entries.length), 8)
  end.set(u16(entries.length), 10)
  end.set(u32(centralSize), 12)
  end.set(u32(offset), 16)
  end.set(u16(0), 20)

  return new Blob([...parts, ...centralParts, end] as BlobPart[], { type: 'application/zip' })
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|flac|mpeg)$/i

export function isZipFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return (
    name.endsWith('.zip') ||
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed'
  )
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Este navegador no puede leer ZIP comprimidos')
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    new DecompressionStream('deflate-raw'),
  )
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

function mimeForName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.mp3') || lower.endsWith('.mpeg')) return 'audio/mpeg'
  if (lower.endsWith('.m4a') || lower.endsWith('.aac')) return 'audio/mp4'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  if (lower.endsWith('.flac')) return 'audio/flac'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}

/** Todas las entradas de un ZIP (STORE o DEFLATE). */
export async function extractZipEntries(file: File): Promise<ZipEntry[]> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: ZipEntry[] = []
  let offset = 0

  while (offset + 30 <= bytes.length) {
    const sig = readU32(view, offset)
    if (sig !== 0x04034b50) break

    const flags = readU16(view, offset + 6)
    const method = readU16(view, offset + 8)
    const compSize = readU32(view, offset + 18)
    const nameLen = readU16(view, offset + 26)
    const extraLen = readU16(view, offset + 28)
    const nameStart = offset + 30
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLen)
    const name = new TextDecoder().decode(nameBytes).replace(/\\/g, '/')
    const dataStart = nameStart + nameLen + extraLen

    if (flags & 0x8) {
      throw new Error(
        'ZIP no soportado (data descriptor). Vuelve a descargar la biblioteca desde MyVibe.',
      )
    }

    if (dataStart + compSize > bytes.length) {
      throw new Error('ZIP dañado o incompleto')
    }

    const compressed = bytes.subarray(dataStart, dataStart + compSize)
    offset = dataStart + compSize

    if (!name || name.endsWith('/')) continue

    let data: Uint8Array
    if (method === 0) {
      data = compressed
    } else if (method === 8) {
      data = await inflateRaw(compressed)
    } else {
      continue
    }

    out.push({ name, data: new Uint8Array(data) })
  }

  return out
}

/** Extrae archivos de audio de un ZIP (STORE o DEFLATE). */
export async function extractAudioFilesFromZip(file: File): Promise<File[]> {
  const entries = await extractZipEntries(file)
  const out: File[] = []

  for (const entry of entries) {
    const base = entry.name.split('/').pop() || entry.name
    if (base.startsWith('.') || !AUDIO_EXT.test(base)) continue
    out.push(
      new File([entry.data as BlobPart], base, {
        type: mimeForName(base),
        lastModified: Date.now(),
      }),
    )
  }

  if (!out.length) {
    throw new Error('El ZIP no contiene canciones (MP3, etc.)')
  }
  return out
}

