import { useCallback, useEffect, useState } from 'react';

interface NotificationOptions {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  onClick?: () => void;
}

export function useBrowserNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [isSupported, setIsSupported] = useState(false);

  useEffect(() => {
    // Check if browser supports notifications
    if ('Notification' in window) {
      setIsSupported(true);
      setPermission(Notification.permission);
    }
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!isSupported) return false;

    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      return result === 'granted';
    } catch (error) {
      console.error('Failed to request notification permission:', error);
      return false;
    }
  }, [isSupported]);

  const showNotification = useCallback(
    async ({ title, body, icon, tag, onClick }: NotificationOptions): Promise<boolean> => {
      if (!isSupported) {
        console.log('[Notifications] Not supported in this browser');
        return false;
      }

      // Request permission if not already granted
      let currentPermission = permission;
      if (currentPermission === 'default') {
        const granted = await requestPermission();
        if (!granted) return false;
        currentPermission = 'granted';
      }

      if (currentPermission !== 'granted') {
        console.log('[Notifications] Permission denied');
        return false;
      }

      try {
        const notification = new Notification(title, {
          body,
          icon: icon || '/favicon.svg',
          tag: tag || 'ielts-dhaka',
          requireInteraction: false,
        });

        if (onClick) {
          notification.onclick = () => {
            window.focus();
            onClick();
            notification.close();
          };
        }

        // Auto-close after 5 seconds
        setTimeout(() => notification.close(), 5000);

        return true;
      } catch (error) {
        console.error('Failed to show notification:', error);
        return false;
      }
    },
    [isSupported, permission, requestPermission]
  );

  const notifyEvaluationComplete = useCallback(
    (testTopic?: string, onClickNavigate?: () => void) => {
      showNotification({
        title: '🎉 Speaking Evaluation Ready!',
        body: testTopic 
          ? `Your "${testTopic}" speaking test has been evaluated.`
          : 'Your speaking test results are now available.',
        tag: 'speaking-eval-complete',
        onClick: onClickNavigate,
      });
    },
    [showNotification]
  );

  const notifyEvaluationFailed = useCallback(
    (reason?: string) => {
      showNotification({
        title: '❌ Evaluation Failed',
        body: reason || 'Your speaking evaluation failed after multiple attempts. Please try again or contact support.',
        tag: 'speaking-eval-failed',
      });
    },
    [showNotification]
  );

  return {
    isSupported,
    permission,
    requestPermission,
    showNotification,
    notifyEvaluationComplete,
    notifyEvaluationFailed,
  };
}
