import './BrandWordmark.css'

type Props = {
  className?: string
  as?: 'span' | 'h1' | 'p'
}

/** Logotipo tipográfico MyVibe (ámbar, estilo app musical moderna). */
export function BrandWordmark({ className = '', as: Tag = 'span' }: Props) {
  return <Tag className={`brand-wordmark ${className}`.trim()}>MyVibe</Tag>
}
