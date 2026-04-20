import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';

const NOTIFICATION_SOUND_URL = 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3';

export function AdminNotifier() {
  const { toast } = useToast();
  const { user } = useAuth();

  useEffect(() => {
    // Only run for authenticated admin users
    if (!user) return;

    // Request browser notification permission
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }

    const socket = io();

    socket.on('connect', () => {
      console.log('Connected to notification socket');
    });

    socket.on('admin_notification', (notification: { type: string; title: string; message: string; data: any }) => {
      console.log('New admin notification:', notification);

      // 1. Show Toast
      toast({
        title: notification.title,
        description: notification.message,
        duration: 10000,
      });

      // 2. Play Sound
      const audio = new Audio(NOTIFICATION_SOUND_URL);
      audio.play().catch(err => console.error('Failed to play notification sound:', err));

      // 3. Show Browser Push Notification
      if (Notification.permission === 'granted') {
        new Notification(notification.title, {
          body: notification.message,
          icon: '/favicon.ico', // Fallback to favicon
        });
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [user, toast]);

  return null; // This component doesn't render anything
}
