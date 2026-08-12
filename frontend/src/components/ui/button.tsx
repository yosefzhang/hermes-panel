import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        default:
          'bg-white dark:bg-slate-800 text-foreground shadow-sm border border-border hover:bg-primary hover:text-primary-foreground hover:shadow-md hover:border-primary',
        destructive:
          'bg-white dark:bg-slate-800 text-red-600 dark:text-red-400 shadow-sm border border-red-200 dark:border-red-900 hover:bg-red-600 hover:text-white hover:shadow-md hover:border-red-600',
        outline:
          'border border-input bg-white dark:bg-slate-800 shadow-sm hover:bg-primary hover:text-primary-foreground hover:border-primary hover:shadow-md',
        secondary:
          'bg-white dark:bg-slate-800 text-foreground shadow-sm border border-border hover:bg-primary hover:text-primary-foreground hover:shadow-md hover:border-primary',
        ghost:
          'hover:bg-primary/15 hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline hover:text-primary/80',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
