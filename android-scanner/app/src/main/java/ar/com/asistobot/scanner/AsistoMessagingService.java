package ar.com.asistobot.scanner;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public class AsistoMessagingService extends FirebaseMessagingService {
    private static final String CHANNEL_ID = "asisto_updates";
    private static final String TURN_CHANNEL_ID = "asisto_turns";

    @Override public void onNewToken(String token) {
        super.onNewToken(token);
        PushRegistration.register(this, token);
    }

    @Override public void onMessageReceived(RemoteMessage message) {
        String title = "Asisto";
        String body = "Tenés una nueva notificación";
        if (message.getNotification() != null) {
            if (message.getNotification().getTitle() != null) title = message.getNotification().getTitle();
            if (message.getNotification().getBody() != null) body = message.getNotification().getBody();
        }
        if (message.getData().containsKey("title")) title = message.getData().get("title");
        if (message.getData().containsKey("body")) body = message.getData().get("body");

        Intent intent = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (message.getData().containsKey("url")) intent.putExtra("url", message.getData().get("url"));
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationManager manager = getSystemService(NotificationManager.class);
        String channelId = message.getData().containsKey("channelId")
            ? message.getData().get("channelId") : CHANNEL_ID;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (TURN_CHANNEL_ID.equals(channelId)) {
                NotificationChannel turnChannel = new NotificationChannel(
                    TURN_CHANNEL_ID, "Avisos de turnos", NotificationManager.IMPORTANCE_HIGH);
                turnChannel.enableVibration(true);
                turnChannel.setVibrationPattern(new long[]{0, 450, 180, 450});
                manager.createNotificationChannel(turnChannel);
            } else {
                manager.createNotificationChannel(new NotificationChannel(
                    CHANNEL_ID, "Novedades de Asisto", NotificationManager.IMPORTANCE_DEFAULT));
            }
        }
        manager.notify((int) System.currentTimeMillis(), new NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_asisto)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_SOUND | NotificationCompat.DEFAULT_VIBRATE)
            .setVibrate(new long[]{0, 450, 180, 450})
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build());
    }
}
