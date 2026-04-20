import webpush from 'web-push';
import { storage } from './storage';

export async function initPushNotifications() {
  const publicKey = "BLi12JZdvdRbULvhPcN-pwedf_t72vUTO4XT-R_AfB58GRSfr_wkB7G-KFffQXFclHxhOQn4Qf-yidRm0o0_Img";
  const privateKey = "rfNmhj1wxk2Bo4zjk5lY7PeOadLP6ZHbvVooox7qdIY";
  const subject = "mailto:imeshcheak@gmail.com";

  await storage.setSetting('VAPID_PUBLIC_KEY', publicKey);
  await storage.setSetting('VAPID_PRIVATE_KEY', privateKey);

  webpush.setVapidDetails(
    subject,
    publicKey,
    privateKey
  );
  
  console.log('[PUSH] Initialized with user-provided VAPID keys');
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
          if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription expired or removed
            console.log(`[PUSH] Removing invalid subscription (Status: ${err.statusCode})`);
          } else {
            console.error('[PUSH] Error sending to subscriber:', err.endpoint, err.message);
          }
        })
    );

    await Promise.all(promises);
  } catch (err) {
    console.error('[PUSH] Failed to send notifications:', err);
  }
}
