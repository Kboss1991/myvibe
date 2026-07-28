export type RadioStation = {
  id: string
  name: string
  tagline: string
  streamUrl: string
  logoUrl: string
  group: 'catalunya' | 'espana' | 'world'
}

/**
 * Semillas locales (primera visita a Mis radios).
 * La UI ya no lista este catálogo entero: el usuario busca en Radio Browser y añade.
 */
export const RADIO_SEED_STATIONS: RadioStation[] = [
  {
    id: 'rac1',
    name: 'RAC1',
    tagline: 'En directe',
    streamUrl: 'https://playerservices.streamtheworld.com/api/livestream-redirect/RAC_1.mp3',
    logoUrl: 'https://graph.facebook.com/rac1oficial/picture?width=200&height=200',
    group: 'catalunya',
  },
  {
    id: 'catradio',
    name: 'Catalunya Ràdio',
    tagline: '3Cat · En directe',
    streamUrl:
      'https://directes-radio-int.3catdirectes.cat/live-content/catalunya-radio-hls/master.m3u8',
    logoUrl: 'https://graph.facebook.com/catradio/picture?width=200&height=200',
    group: 'catalunya',
  },
  {
    id: 'catinfo',
    name: 'Catalunya Informació',
    tagline: 'Notícies 24 h',
    streamUrl:
      'https://directes-radio-int.3catdirectes.cat/live-content/catalunya-informacio-hls/master.m3u8',
    logoUrl: 'https://graph.facebook.com/catinformacio/picture?width=200&height=200',
    group: 'catalunya',
  },
  {
    id: 'icat',
    name: 'iCat',
    tagline: 'Música · 3Cat',
    streamUrl: 'https://directes-radio-int.3catdirectes.cat/live-content/icat-hls/master.m3u8',
    logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/ICat.cat.svg/250px-ICat.cat.svg.png',
    group: 'catalunya',
  },
  {
    id: 'rac105',
    name: 'RAC 105',
    tagline: 'Música · En directe',
    streamUrl: 'https://playerservices.streamtheworld.com/api/livestream-redirect/RAC105.mp3',
    logoUrl: 'https://graph.facebook.com/rac105/picture?width=200&height=200',
    group: 'catalunya',
  },
  {
    id: 'flaixfm',
    name: 'Flaix FM',
    tagline: 'Dance · En directe',
    streamUrl: 'https://stream.flaixfm.cat/icecast',
    logoUrl: 'https://pbs.twimg.com/profile_images/1051761197127745541/whMnn4_K_200x200.jpg',
    group: 'catalunya',
  },
  {
    id: 'flaixbac',
    name: 'Flaixbac',
    tagline: 'Pop · En directe',
    streamUrl: 'https://stream.flaixbac.cat/icecast',
    logoUrl: 'https://pbs.twimg.com/profile_images/1164926188307001344/PtDeZDOO_200x200.jpg',
    group: 'catalunya',
  },
  {
    id: 'ser',
    name: 'Cadena SER',
    tagline: 'En directo',
    streamUrl: 'https://playerservices.streamtheworld.com/api/livestream-redirect/CADENASER.mp3',
    logoUrl: 'https://graph.facebook.com/cadenaser/picture?width=200&height=200',
    group: 'espana',
  },
  {
    id: 'los40',
    name: 'LOS40',
    tagline: 'Música · En directo',
    streamUrl: 'https://playerservices.streamtheworld.com/api/livestream-redirect/Los40.mp3',
    logoUrl: 'https://graph.facebook.com/los40/picture?width=200&height=200',
    group: 'espana',
  },
  {
    id: 'cope',
    name: 'COPE',
    tagline: 'En directo',
    streamUrl: 'https://flucast09-h-cloud.flumotion.com/cope/net1.mp3',
    logoUrl: 'https://graph.facebook.com/COPE/picture?width=200&height=200',
    group: 'espana',
  },
  {
    id: 'kissfm',
    name: 'Kiss FM',
    tagline: 'Música · En directo',
    streamUrl: 'https://kissfm.kissfmradio.cires21.com/kissfm.mp3',
    logoUrl: 'https://graph.facebook.com/kissfm.es/picture?width=200&height=200',
    group: 'espana',
  },
]

/** @deprecated Usa listMyRadios(); se mantiene por compatibilidad temporal. */
export const RADIO_STATIONS = RADIO_SEED_STATIONS

export function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url) || /\/hls\//i.test(url) || /m3u8/i.test(url)
}
