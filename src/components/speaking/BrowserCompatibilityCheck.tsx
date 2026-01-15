/**
 * Browser Compatibility Check
 * Checks for Web Speech API and Web Audio API support
 * Updated Strategy: Recommend Edge > Chrome > Others
 */

import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, CheckCircle, Chrome, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface CompatibilityResult {
  speechRecognition: boolean;
  interimResults: boolean;
  audioContext: boolean;
  isEdge: boolean;
  isChrome: boolean;
  isSupported: boolean;
}

export function BrowserCompatibilityCheck() {
  const [compat, setCompat] = useState<CompatibilityResult | null>(null);

  useEffect(() => {
    const check = () => {
      const SpeechRecognition = (window as any).SpeechRecognition || 
                                 (window as any).webkitSpeechRecognition;

      const speechRecognition = !!SpeechRecognition;

      // Test interim results (not supported in Firefox)
      let interimResults = false;
      if (SpeechRecognition) {
        try {
          const test = new SpeechRecognition();
          test.interimResults = true;
          interimResults = test.interimResults === true;
        } catch {
          interimResults = false;
        }
      }

      const audioContext = !!(window.AudioContext || (window as any).webkitAudioContext);

      // Detect browser type
      const userAgent = navigator.userAgent;
      const isEdge = /Edg\//.test(userAgent); // Microsoft Edge (Chromium-based)
      const isChrome = !isEdge && /Chrome|Chromium/.test(userAgent); // Chrome but not Edge
      const isSupported = speechRecognition && interimResults && audioContext;

      setCompat({ speechRecognition, interimResults, audioContext, isEdge, isChrome, isSupported });
    };

    check();
  }, []);

  if (!compat) return null;

  // Edge detected - Recommended browser (Azure engine, higher accuracy)
  if (compat.isEdge && compat.isSupported) {
    return (
      <Alert className="border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-800">
        <Sparkles className="h-4 w-4 text-green-600" />
        <AlertTitle className="text-green-700 dark:text-green-400 flex items-center gap-2">
          Recommended Browser Detected
          <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400 text-xs">
            High Accuracy
          </Badge>
        </AlertTitle>
        <AlertDescription className="text-green-600 dark:text-green-500">
          Microsoft Edge provides the best speech recognition accuracy for grading.
        </AlertDescription>
      </Alert>
    );
  }

  // Chrome detected - Supported but Edge is better
  if (compat.isChrome && compat.isSupported) {
    return (
      <Alert className="border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800">
        <CheckCircle className="h-4 w-4 text-blue-600" />
        <AlertTitle className="text-blue-700 dark:text-blue-400 flex items-center gap-2">
          Supported Browser
          <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400 text-xs">
            Standard Accuracy
          </Badge>
        </AlertTitle>
        <AlertDescription className="text-blue-600 dark:text-blue-500">
          Chrome is supported for speech recognition. 
          <span className="font-medium"> Pro Tip:</span> Use Microsoft Edge for better grading results.
        </AlertDescription>
      </Alert>
    );
  }

  // Other Chromium-based browsers that support the API
  if (compat.isSupported) {
    return (
      <Alert className="border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800">
        <CheckCircle className="h-4 w-4 text-blue-600" />
        <AlertTitle className="text-blue-700 dark:text-blue-400">Speech Recognition Enabled</AlertTitle>
        <AlertDescription className="text-blue-600 dark:text-blue-500">
          Your browser supports speech analysis. For best accuracy, use Microsoft Edge or Chrome.
        </AlertDescription>
      </Alert>
    );
  }

  // No speech recognition support
  if (!compat.speechRecognition) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Browser Not Supported</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>
            Your browser doesn't support speech recognition. 
            Please use Microsoft Edge (recommended) or Chrome for speech analysis.
          </p>
          <div className="flex gap-2 flex-wrap">
            <a 
              href="https://www.microsoft.com/edge" 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm underline"
            >
              Download Edge (Recommended)
            </a>
            <a 
              href="https://www.google.com/chrome/" 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm underline"
            >
              <Chrome className="w-4 h-4" />
              Download Chrome
            </a>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  // Limited support (e.g., Firefox with basic speech recognition)
  if (!compat.interimResults) {
    return (
      <Alert className="border-yellow-200 bg-yellow-50 dark:bg-yellow-950/20 dark:border-yellow-800">
        <AlertTriangle className="h-4 w-4 text-yellow-600" />
        <AlertTitle className="text-yellow-700 dark:text-yellow-400">Limited Support</AlertTitle>
        <AlertDescription className="text-yellow-600 dark:text-yellow-500">
          Your browser has limited speech recognition support. 
          Word-by-word confidence tracking may not work correctly.
          For the best experience, use Microsoft Edge or Chrome.
        </AlertDescription>
      </Alert>
    );
  }

  return null;
}

/**
 * Hook to check browser compatibility
 */
export function useBrowserCompatibility() {
  const [isSupported, setIsSupported] = useState(true);
  const [isRecommended, setIsRecommended] = useState(false);
  const [isEdge, setIsEdge] = useState(false);

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || 
                               (window as any).webkitSpeechRecognition;
    
    const supported = !!SpeechRecognition;
    setIsSupported(supported);

    // Check browser type
    const userAgent = navigator.userAgent;
    const edgeDetected = /Edg\//.test(userAgent);
    setIsEdge(edgeDetected);
    
    // Edge is the recommended browser for highest accuracy
    setIsRecommended(supported && edgeDetected);
  }, []);

  return { isSupported, isRecommended, isEdge };
}
