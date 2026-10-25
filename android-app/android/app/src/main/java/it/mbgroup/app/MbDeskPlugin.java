package it.mbgroup.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.List;

/**
 * Ponte tra Android e l'app web di MB Desk.
 * - File ricevuti da "Apri con" / "Condividi": copiati nella cache dell'app e passati alla pagina a pezzi (readChunk),
 *   cosi' anche i file grandi non passano interi in memoria come testo.
 * - Contatti dai biglietti da visita: schermata "Nuovo contatto" di Android gia' compilata (l'utente conferma).
 */
@CapacitorPlugin(name = "MbDesk")
public class MbDeskPlugin extends Plugin {
    private static final List<JSObject> pending = new ArrayList<>();
    private static MbDeskPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    /** Chiamato da MainActivity per ogni intent con file (VIEW su content:// o file://, SEND, SEND_MULTIPLE). */
    static void offer(android.app.Activity act, Intent intent) {
        List<Uri> uris = new ArrayList<>();
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) uris.add(intent.getData());
        else if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        if (uris.isEmpty()) return;
        new Thread(() -> {
            for (Uri u : uris) {
                JSObject f = copyToCache(act, u, intent.getType());
                if (f == null) continue;
                // evento conservato finche' la pagina non ascolta (retainUntilConsumed); senza plugin pronto resta in coda
                if (instance != null) instance.notifyListeners("file", f, true);
                else synchronized (pending) { pending.add(f); }
            }
        }).start();
        intent.setAction(Intent.ACTION_MAIN); // non riaprire lo stesso file ruotando lo schermo
    }

    private static JSObject copyToCache(android.app.Activity act, Uri uri, String type) {
        ContentResolver cr = act.getContentResolver();
        String name = "file";
        try (Cursor c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
        } catch (Exception ignored) {
            String last = uri.getLastPathSegment();
            if (last != null) name = last.substring(last.lastIndexOf('/') + 1);
        }
        name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        File dir = new File(act.getCacheDir(), "ricevuti");
        dir.mkdirs();
        File out = new File(dir, System.currentTimeMillis() + "-" + name);
        try (InputStream in = cr.openInputStream(uri); FileOutputStream os = new FileOutputStream(out)) {
            if (in == null) return null;
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
        } catch (Exception e) {
            return null;
        }
        JSObject f = new JSObject();
        f.put("name", name);
        f.put("type", type != null ? type : cr.getType(uri));
        f.put("size", out.length());
        f.put("path", out.getAbsolutePath());
        return f;
    }

    /** File arrivati prima che la pagina fosse pronta (avvio con "Apri con"). */
    @PluginMethod
    public void takePending(PluginCall call) {
        JSArray arr = new JSArray();
        synchronized (pending) {
            for (JSObject f : pending) arr.put(f);
            pending.clear();
        }
        JSObject r = new JSObject();
        r.put("files", arr);
        call.resolve(r);
    }

    @PluginMethod
    public void readChunk(PluginCall call) {
        String path = call.getString("path");
        long offset = call.getLong("offset", 0L);
        int length = call.getInt("length", 4 << 20);
        File f = path == null ? null : new File(path);
        if (f == null || !f.getAbsolutePath().startsWith(new File(getContext().getCacheDir(), "ricevuti").getAbsolutePath()) || !f.isFile()) {
            call.reject("file non disponibile");
            return;
        }
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            long left = Math.max(0, raf.length() - offset);
            byte[] buf = new byte[(int) Math.min(length, left)];
            raf.seek(offset);
            raf.readFully(buf);
            JSObject r = new JSObject();
            r.put("data", Base64.encodeToString(buf, Base64.NO_WRAP));
            r.put("eof", offset + buf.length >= raf.length());
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void release(PluginCall call) {
        String path = call.getString("path");
        if (path != null && path.startsWith(new File(getContext().getCacheDir(), "ricevuti").getAbsolutePath())) new File(path).delete();
        call.resolve();
    }

    /** Biglietto da visita -> schermata "Nuovo contatto" di Android gia' compilata (conferma dell'utente). */
    @PluginMethod
    public void insertContact(PluginCall call) {
        Intent i = new Intent(ContactsContract.Intents.Insert.ACTION);
        i.setType(ContactsContract.RawContacts.CONTENT_TYPE);
        put(i, ContactsContract.Intents.Insert.NAME, call.getString("name"));
        put(i, ContactsContract.Intents.Insert.COMPANY, call.getString("org"));
        put(i, ContactsContract.Intents.Insert.JOB_TITLE, call.getString("title"));
        put(i, ContactsContract.Intents.Insert.NOTES, call.getString("note"));
        put(i, ContactsContract.Intents.Insert.POSTAL, call.getString("address"));
        ArrayList<ContentValues> data = new ArrayList<>();
        JSArray phones = call.getArray("phones", new JSArray());
        for (int k = 0; k < phones.length(); k++) {
            JSONObject p = phones.optJSONObject(k);
            if (p == null) continue;
            ContentValues v = new ContentValues();
            v.put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE);
            v.put(ContactsContract.CommonDataKinds.Phone.NUMBER, p.optString("number"));
            String kind = p.optString("kind");
            v.put(ContactsContract.CommonDataKinds.Phone.TYPE, "cell".equals(kind) ? ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE
                    : "fax".equals(kind) ? ContactsContract.CommonDataKinds.Phone.TYPE_FAX_WORK : ContactsContract.CommonDataKinds.Phone.TYPE_WORK);
            data.add(v);
        }
        JSArray emails = call.getArray("emails", new JSArray());
        for (int k = 0; k < emails.length(); k++) {
            ContentValues v = new ContentValues();
            v.put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE);
            v.put(ContactsContract.CommonDataKinds.Email.ADDRESS, emails.optString(k));
            v.put(ContactsContract.CommonDataKinds.Email.TYPE, ContactsContract.CommonDataKinds.Email.TYPE_WORK);
            data.add(v);
        }
        String web = call.getString("website");
        if (web != null && !web.isEmpty()) {
            ContentValues v = new ContentValues();
            v.put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Website.CONTENT_ITEM_TYPE);
            v.put(ContactsContract.CommonDataKinds.Website.URL, web);
            v.put(ContactsContract.CommonDataKinds.Website.TYPE, ContactsContract.CommonDataKinds.Website.TYPE_WORK);
            data.add(v);
        }
        if (!data.isEmpty()) i.putParcelableArrayListExtra(ContactsContract.Intents.Insert.DATA, data);
        i.putExtra("finishActivityOnSaveCompleted", true);
        try {
            getActivity().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("rubrica non disponibile");
        }
    }

    private static void put(Intent i, String key, String value) {
        if (value != null && !value.isEmpty()) i.putExtra(key, value);
    }
}
