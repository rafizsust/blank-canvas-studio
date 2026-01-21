import React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, RefreshCw, ArrowLeft, Mic } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  testId?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error?: Error;
}

/**
 * Error boundary specifically for Speaking Test
 * Prevents crashes from causing data loss and provides recovery options
 */
export class SpeakingTestErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[SpeakingTestErrorBoundary] Caught error:', error, errorInfo);
    
    // Log to help with debugging
    console.error('[SpeakingTestErrorBoundary] Component stack:', errorInfo.componentStack);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined });
    this.props.onReset?.();
  };

  handleGoBack = () => {
    window.location.href = '/ai-practice';
  };

  handleGoToHistory = () => {
    window.location.href = '/ai-practice/history';
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
          <Card className="max-w-md w-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertCircle className="w-5 h-5" />
                Something went wrong
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground">
                The speaking test encountered an unexpected error. Don't worry - your recordings may have been saved.
              </p>
              
              {this.state.error && (
                <div className="p-3 bg-muted rounded-lg text-xs font-mono text-muted-foreground overflow-auto max-h-24">
                  {this.state.error.message}
                </div>
              )}
              
              <div className="flex flex-col gap-2">
                <Button onClick={this.handleRetry} className="w-full gap-2">
                  <RefreshCw className="w-4 h-4" />
                  Try Again
                </Button>
                
                <Button 
                  variant="secondary" 
                  onClick={this.handleGoToHistory}
                  className="w-full gap-2"
                >
                  <Mic className="w-4 h-4" />
                  Check History for Saved Progress
                </Button>
                
                <Button 
                  variant="outline" 
                  onClick={this.handleGoBack}
                  className="w-full gap-2"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to AI Practice
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
