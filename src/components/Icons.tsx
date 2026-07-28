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

export function IconLibrary(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 5h3v14H4zM9 5h3v14H9zM14 5.5 20 4v15.5L14 21z" />
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
      <path d="M5 5v14h2V5H5zm3.5 7 10-6.5v13L8.5 12z" />
    </svg>
  )
}

export function IconSkipForward(p: IconProps) {
  return (
    <svg {...base({ ...p, fill: 'currentColor', stroke: 'none' })}>
      <path d="M17 5v14h2V5h-2zM5.5 5.5 15.5 12 5.5 18.5v-13z" />
    </svg>
  )
}

export function IconShuffle(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M16 4h4v4M4 8c4 0 5 4 8 4s4 4 8 4M20 16v4h-4M4 16c4 0 5-4 8-4" />
    </svg>
  )
}

export function IconRepeat(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M17 2l3 3-3 3M4 7h15a3 3 0 0 1 0 6h-2M7 22l-3-3 3-3M20 17H5a3 3 0 0 1 0-6h2" />
    </svg>
  )
}

export function IconRepeatOne(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M17 2l3 3-3 3M4 7h15a3 3 0 0 1 0 6h-2M7 22l-3-3 3-3M20 17H5a3 3 0 0 1 0-6h2" />
      <path d="M12 10v5" />
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

export function IconCar(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 14h16l-1.5-5.5A2 2 0 0 0 16.6 7H7.4a2 2 0 0 0-1.9 1.5L4 14z" />
      <path d="M6 17h0M18 17h0M5 14v3a1 1 0 0 0 1 1h1M17 18h1a1 1 0 0 0 1-1v-3" />
      <circle cx="7.5" cy="17" r="1.5" />
      <circle cx="16.5" cy="17" r="1.5" />
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

export function IconVolume(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 10v4h3l4 3V7L7 10H4zM16 9a4 4 0 0 1 0 6M18.5 7a7 7 0 0 1 0 10" />
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

export function IconBluetooth(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M7 7.5 17 16l-5 4V4l5 4L7 16.5" />
    </svg>
  )
}

export function IconSpeaker(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 9v6h3l5 4V5L7 9H4z" />
      <path d="M15.5 8.5a4 4 0 0 1 0 7" />
      <path d="M17.5 6a7 7 0 0 1 0 12" />
    </svg>
  )
}

export function IconComputer(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  )
}

export function IconHeadphones(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 13a8 8 0 0 1 16 0" />
      <path d="M4 13v5a2 2 0 0 0 2 2h2v-7H6a2 2 0 0 0-2 2zM20 13v5a2 2 0 0 1-2 2h-2v-7h2a2 2 0 0 1 2 2z" />
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
