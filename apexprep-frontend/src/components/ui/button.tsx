import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-white hover:bg-primary-press active:bg-primary-press',
        secondary: 'border border-line-strong bg-transparent text-ink-soft hover:bg-deck hover:border-ink',
        ghost: 'text-ink-soft hover:bg-deck',
        destructive: 'border border-[#FCA5A5] bg-[#FEF2F2] text-deficit hover:bg-[#FEE2E2]',
        subtle: 'bg-primary/10 text-primary hover:bg-primary/15',
      },
      size: {
        sm: 'h-8 px-3 text-body-sm',
        md: 'h-10 px-4 text-body-sm',
        lg: 'h-11 px-5 text-body-md',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  }
)

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
)
Button.displayName = 'Button'
