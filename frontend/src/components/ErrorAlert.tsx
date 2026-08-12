import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface ErrorAlertProps {
  message: string;
  className?: string;
}

export default function ErrorAlert({ message, className = '' }: ErrorAlertProps) {
  return (
    <Alert variant="destructive" className={`rounded-2xl ${className}`}>
      <AlertCircle className="h-4 w-4" />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
