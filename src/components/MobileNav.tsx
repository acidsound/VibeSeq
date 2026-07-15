import { ListMusic, SlidersHorizontal, Sparkles } from 'lucide-react'
import type { MobileSurface } from '../ui/types'

export function MobileNav({ active, onChange }: { active: MobileSurface; onChange: (surface: MobileSurface) => void }) {
  return (
    <nav className="mobile-nav" aria-label="Studio surfaces">
      <button className={active === 'arrange' ? 'is-active' : ''} aria-current={active === 'arrange' ? 'page' : undefined} onClick={() => onChange('arrange')}><ListMusic /><span>Arrange</span></button>
      <button className={active === 'create' ? 'is-active' : ''} aria-current={active === 'create' ? 'page' : undefined} onClick={() => onChange('create')}><Sparkles /><span>Create</span></button>
      <button className={active === 'mix' ? 'is-active' : ''} aria-current={active === 'mix' ? 'page' : undefined} onClick={() => onChange('mix')}><SlidersHorizontal /><span>Mix</span></button>
    </nav>
  )
}
