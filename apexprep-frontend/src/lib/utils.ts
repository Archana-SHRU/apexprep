import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { Difficulty } from '@/types'

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)) }

export const TIER_META: Record<Difficulty, { label: string; hex: string; short: string }> = {
  1: { label: 'L1 Foundational', short: 'L1', hex: '#3B82F6' },
  2: { label: 'L2 Standard', short: 'L2', hex: '#10B981' },
  3: { label: 'L3 Competitive', short: 'L3', hex: '#F59E0B' },
  4: { label: 'L4 Advanced', short: 'L4', hex: '#F97316' },
  5: { label: 'L5 Olympiad Master', short: 'L5', hex: '#8B5CF6' },
}

export function formatClock(totalSec: number) {
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
export function formatPace(sec: number) {
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
}
export function formatDuration(min: number) {
  const h = Math.floor(min / 60)
  return h ? `${h}h ${min % 60}m` : `${min}m`
}
export function pad2(n: number) { return String(n).padStart(2, '0') }
export function compact(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
export function greeting(d = new Date()) {
  const h = d.getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}
