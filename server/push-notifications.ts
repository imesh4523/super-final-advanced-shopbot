import webpush from 'web-push';
import { storage } from './storage';

export async function initPushNotifications() {
  let publicKey = (await storage.getSetting('VAPID_PUBLIC_KEY'))?.value;
  let privateKey = (await storage.getSetting('VAPID_PRIVATE_KEY'))?.value;

  if (!publicKey || !privateKey) {
    const vapidKeys = webpush.generateVAPIDKeys();
    publicKey = vapidKeys.publicKey;
    privateKey = vapidKeys.privateKey;
    
    await storage.setSetting('VAPID_PUBLIC_KEY', publicKey);
    await storage.setSetting('VAPID_PRIVATE_KEY', privateKey);
    console.log('[PUSH] Generated new VAPID keys');
  }

  webpush.setVapidDetails(
    'mailto:admin@example.com',
    publicKey,
    privateKey
  );
  
  return { publicKey };
}

export async function sendAdminPushNotification(title: string, body: string, url?: string) {
  try {
    const subscriptions = await storage.getPushSubscriptions();
    console.log(`[PUSH] Sending notification to ${subscriptions.length} subscribers`);
    
    const payload = JSON.stringify({
      title,
      body,
      url: url || '/orders',
    });

    const promises = subscriptions.map(sub => 
      webpush.sendNotification(sub.subscription, payload)
        .catch(err => {
          if (err.statusCode === 410) {
            // Subscription expired or removed
            console.log('[PUSH] Removing expired subscription');
            // TODO: Delete from DB
          } else {
            console.error('[PUSH] Error sending notification:', err);
          }
        })
    );

    await Promise.all(promises);
  } catch (err) {
    console.error('[PUSH] Failed to send notifications:', err);
  }
}
