import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base({ size = 24, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...props,
  }
}

export function IconHome(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5z" />
    </svg>
  )
}

export function IconSearch(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16.5 16.5 4 4" />
    </svg>
  )
}

/** Lucide library — lomos de discoteca / estantería */
export function IconLibrary(p: IconProps) {
  return (
    <svg {...base({ ...p, strokeWidth: 2 })}>
      <path d="M4 4v16" />
      <path d="M8 8v12" />
      <path d="M12 6v14" />
      <path d="m16 6 4 14" />
    </svg>
  )
}

export function IconUpload(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 16V5M8 8l4-4 4 4M5 19h14" />
    </svg>
  )
}

export function IconPlay(p: IconProps) {
  return (
    <svg {...base({ ...p, fill: 'currentColor', stroke: 'none' })}>
      <path d="M8 5.5v13l11-6.5L8 5.5z" />
    </svg>
  )
}

export function IconPause(p: IconProps) {
  return (
    <svg {...base({ ...p, fill: 'currentColor', stroke: 'none' })}>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  )
}

export function IconSkipBack(p: IconProps) {
  return (
    <svg {...base({ ...p, fill: 'currentColor', stroke: 'none' })}>
      <path d="M19 20 9 12l10-8v16z" />
      <rect x="5" y="4" width="2.5" height="16" rx="0.5" />
    </svg>
  )
}

export function IconSkipForward(p: IconProps) {
  return (
    <svg {...base({ ...p, fill: 'currentColor', stroke: 'none' })}>
      <path d="M5 4v16l10-8L5 4z" />
      <rect x="16.5" y="4" width="2.5" height="16" rx="0.5" />
    </svg>
  )
}

/** Lucide shuffle — cruces con flechas en los extremos */
export function IconShuffle(p: IconProps) {
  return (
    <svg {...base({ ...p, strokeWidth: 2 })}>
      <path d="m18 14 4 4-4 4" />
      <path d="m18 2 4 4-4 4" />
      <path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22" />
      <path d="M2 6h1.972a4 4 0 0 1 3.3 1.7l5.454 8.6a4 4 0 0 0 3.3 1.7H22" />
    </svg>
  )
}

/** Lucide repeat — bucle con flechas */
export function IconRepeat(p: IconProps) {
  return (
    <svg {...base({ ...p, strokeWidth: 2 })}>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  )
}

/** Lucide repeat-1 */
export function IconRepeatOne(p: IconProps) {
  return (
    <svg {...base({ ...p, strokeWidth: 2 })}>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
      <path d="M11 10h1v4" />
    </svg>
  )
}

export function IconHeart(p: IconProps & { filled?: boolean }) {
  const { filled, ...rest } = p
  return (
    <svg {...base({ ...rest, fill: filled ? 'currentColor' : 'none' })}>
      <path d="M12 20s-7-4.4-7-9.2A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7 2.8C19 15.6 12 20 12 20z" />
    </svg>
  )
}

export function IconQueue(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 7h12M4 12h12M4 17h8M17 14l4 3-4 3v-6z" />
    </svg>
  )
}

export function IconMore(p: IconProps) {
  return (
    <svg {...base({ ...p, fill: 'currentColor', stroke: 'none' })}>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  )
}

export function IconClose(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

export function IconGrip(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" strokeWidth="2.6" />
    </svg>
  )
}

export function IconCheck(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M5 12.5 10 17l9-10" />
    </svg>
  )
}

export function IconSelect(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8 12.5 11 15.5 16 9" />
    </svg>
  )
}

export function IconPlus(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function IconChevronDown(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function IconEdit(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 20h4l11-11-4-4L4 16v4zM13 7l4 4" />
    </svg>
  )
}

export function IconTrash(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M5 7h14M10 7V5h4v2M8 7v12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7" />
    </svg>
  )
}

export function IconDownload(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 4v10M8 10l4 4 4-4M5 19h14" />
    </svg>
  )
}

export function IconShare(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M8.4 10.7 15.6 6.8M8.4 13.3l7.2 4.9" />
    </svg>
  )
}

export function IconHeadphones(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 13v2.5A2.5 2.5 0 0 0 6.5 18H8v-5H6.5A2.5 2.5 0 0 0 4 15.5V13a8 8 0 0 1 16 0v2.5A2.5 2.5 0 0 1 17.5 18H16v-5h1.5A2.5 2.5 0 0 1 20 15.5" />
    </svg>
  )
}

export function IconPerson(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 19.5c1.6-3.2 4-4.8 7-4.8s5.4 1.6 7 4.8" />
    </svg>
  )
}

export function IconMusicNote(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M9 5v11.2A3.2 3.2 0 1 0 11 19V9l8-1.6V14a3.2 3.2 0 1 0 2 2.9V5.6L9 5z" />
    </svg>
  )
}

export function IconFlame(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 3c1.8 2.4 3 4.2 3 6.2a3 3 0 0 1-6 0c0-.7.2-1.4.5-2C8 9.5 7 11.2 7 13a5 5 0 0 0 10 0c0-3.2-2.2-5.8-5-10z" />
    </svg>
  )
}

export function IconClock(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.5l3 1.5" />
    </svg>
  )
}

export function IconSort(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 7h10M4 12h7M4 17h5M16 6l4 4h-3v8h-2v-8h-3l4-4z" />
    </svg>
  )
}

export function IconRefresh(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}

export function IconRadio(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M7 7 16 3" />
      <circle cx="8.5" cy="13.5" r="1.5" />
      <path d="M13 12h5M13 15.5h5" />
    </svg>
  )
}

export function IconPodcast(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="2.25" />
      <path d="M8.2 8.2a5.4 5.4 0 0 1 7.6 0" />
      <path d="M5.5 5.5a9.2 9.2 0 0 1 13 0" />
      <path d="M12 14.2v4.3" />
      <path d="M9.5 18.5h5" />
    </svg>
  )
}

/** Retroceso −10 s (podcasts). */
export function IconSkipBack15(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M3 12a9 9 0 1 0 2.4-6" />
      <path d="M3 3v5h5" />
      <text
        x="12"
        y="15.2"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontSize="7.5"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
      >
        10
      </text>
    </svg>
  )
}

/** Avance +10 s (podcasts). */
export function IconSkipForward15(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M21 12a9 9 0 1 1-2.4-6" />
      <path d="M21 3v5h-5" />
      <text
        x="12"
        y="15.2"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontSize="7.5"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
      >
        10
      </text>
    </svg>
  )
}

/** Completar / mejorar metadatos (portada, artista, álbum) */
export function IconSparkles(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 3.5 13.2 8.5 18 9.7 13.2 10.9 12 16l-1.2-5.1L6 9.7l4.8-1.2L12 3.5z" />
      <path d="M18.5 14.5 19.1 17 21.5 17.6 19.1 18.2 18.5 20.7 17.9 18.2 15.5 17.6 17.9 17z" />
      <path d="M5.5 13.5 6 15.2 7.7 15.7 6 16.2 5.5 17.9 5 16.2 3.3 15.7 5 15.2z" />
    </svg>
  )
}
