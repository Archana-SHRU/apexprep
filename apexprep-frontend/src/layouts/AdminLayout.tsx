import { useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { BarChart3, FileCheck2, FileUp, FolderTree, LayoutDashboard, Library, LogOut, Menu, Users, Cpu, X } from 'lucide-react'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/admin/syllabus', label: 'Syllabus', icon: FolderTree },
  { to: '/admin/upload', label: 'Content Upload', icon: FileUp },
  { to: '/admin/processing', label: 'Processing', icon: Cpu },
  { to: '/admin/review', label: 'Content Review', icon: FileCheck2 },
  { to: '/admin/questions', label: 'Question Bank', icon: Library },
  { to: '/admin/students', label: 'Students', icon: Users },
  { to: '/admin/analytics', label: 'Platform Analytics', icon: BarChart3 },
]

export function AdminLayout() {
  const [open, setOpen] = useState(false)
  const { logout } = useAuth()
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-deck lg:flex">
      <aside className={cn(
        'fixed inset-y-0 left-0 z-50 w-64 shrink-0 border-r border-line bg-canvas transition-transform lg:static lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full'
      )}>
        <div className="flex h-14 items-center justify-between border-b border-line px-4">
          <Link to="/admin" className="flex items-center gap-2"><Logo showWordmark={false} />
            <span className="font-mono text-label-sm uppercase text-ink">Admin Console</span></Link>
          <button className="text-ink-muted lg:hidden" aria-label="Close menu" onClick={() => setOpen(false)}><X className="h-4 w-4" /></button>
        </div>
        <nav className="space-y-0.5 p-3">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setOpen(false)}
              className={({ isActive }) => cn('flex items-center gap-2.5 rounded px-3 py-2 text-body-sm font-medium transition-colors',
                isActive ? 'bg-primary/10 text-primary' : 'text-ink-soft hover:bg-deck')}>
              <n.icon className="h-4 w-4" />{n.label}
            </NavLink>
          ))}
        </nav>
        <div className="absolute inset-x-0 bottom-0 border-t border-line p-3">
          <Button variant="secondary" size="sm" className="w-full" onClick={() => { logout(); navigate('/admin/login') }}>
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </Button>
        </div>
      </aside>

      {open && <div className="fixed inset-0 z-40 bg-ink/40 lg:hidden" onClick={() => setOpen(false)} />}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-canvas px-4 lg:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open menu" className="text-ink-soft"><Menu className="h-5 w-5" /></button>
          <span className="font-mono text-label-sm uppercase text-ink">Admin Console</span>
        </header>
        <main className="p-4 sm:p-6 lg:p-8"><Outlet /></main>
      </div>
    </div>
  )
}
