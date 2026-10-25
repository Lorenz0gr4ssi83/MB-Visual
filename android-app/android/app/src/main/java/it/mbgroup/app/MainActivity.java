package it.mbgroup.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * MB Desk per Android: la pagina e' l'app per telefono servita dal server (capacitor.config.json, server.url).
 * - link del QR (App Link https://<server>/l/...): si apre dentro l'app, che si attiva da sola;
 * - file da "Apri con" e "Condividi": li prende MbDeskPlugin e li passa alla pagina.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MbDeskPlugin.class);
        super.onCreate(savedInstanceState);
        handle(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handle(intent);
    }

    private void handle(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && data != null && "https".equals(data.getScheme())) {
            String url = data.toString();
            if (bridge != null) bridge.getWebView().postDelayed(() -> bridge.getWebView().loadUrl(url), 300);
            intent.setAction(Intent.ACTION_MAIN);
            return;
        }
        MbDeskPlugin.offer(this, intent);
    }
}
