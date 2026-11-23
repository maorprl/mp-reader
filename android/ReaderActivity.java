package app.mpreader.reader;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.WindowInsets;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public final class ReaderActivity extends Activity {
    private static final String HOST = "reader.mpreader.invalid";
    private static final String ORIGIN = "https://" + HOST;
    private static final int PICK_FILES = 1;
    private final ConcurrentHashMap<String, Uri> imports = new ConcurrentHashMap<>();
    private ValueCallback<Uri[]> filePicker;
    private WebView reader;
    private Uri pendingBook;
    private boolean ready;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        reader = new WebView(this);
        WebSettings settings = reader.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Allow content URIs returned by Android's document picker.
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccess(false);

        reader.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if ("https".equals(url.getScheme()) &&
                        "lucky-unit-12e9.maorperlov.workers.dev".equals(url.getHost()) &&
                        !request.isForMainFrame()) return null;
                if (!"https".equals(url.getScheme()) || !HOST.equals(url.getHost()) ||
                        url.getPort() != -1 || !"GET".equals(request.getMethod())) {
                    return missing();
                }
                String path = url.getPath();
                if (path == null) return missing();
                if (path.startsWith("/import/")) {
                    Uri source = imports.remove(path);
                    if (source == null) return missing();
                    try {
                        InputStream stream = getContentResolver().openInputStream(source);
                        return stream == null ? missing() :
                            new WebResourceResponse("application/epub+zip", null, stream);
                    } catch (IOException | SecurityException error) {
                        return missing();
                    }
                }
                if (!path.equals("/index.html") && !path.matches("/assets/[A-Za-z0-9_.-]+")) {
                    return missing();
                }
                try {
                    return new WebResourceResponse(mimeType(path), "UTF-8",
                        getAssets().open("web" + path));
                } catch (IOException error) {
                    return missing();
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return request.isForMainFrame();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if ((ORIGIN + "/index.html").equals(url)) {
                    ready = true;
                    deliverBook();
                }
            }
        });

        reader.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams parameters) {
                if (filePicker != null) filePicker.onReceiveValue(null);
                filePicker = callback;
                Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType("*/*");
                picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(picker, PICK_FILES);
                } catch (android.content.ActivityNotFoundException error) {
                    filePicker = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(ReaderActivity.this, R.string.no_picker, Toast.LENGTH_SHORT).show();
                }
                return true;
            }
        });
        reader.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets padding = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom);
            return insets;
        });
        setContentView(reader);
        receiveBook(getIntent());
        reader.loadUrl(ORIGIN + "/index.html");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        receiveBook(intent);
    }

    private void receiveBook(Intent intent) {
        Uri source = intent.getData();
        if (!Intent.ACTION_VIEW.equals(intent.getAction()) || source == null ||
                !"content".equals(source.getScheme())) return;
        pendingBook = source;
        deliverBook();
    }

    private void deliverBook() {
        if (!ready || pendingBook == null) return;
        Uri source = pendingBook;
        pendingBook = null;
        String path = "/import/" + UUID.randomUUID();
        String name = "Book.epub";
        try (Cursor cursor = getContentResolver().query(source,
                new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) name = cursor.getString(0);
        } catch (RuntimeException ignored) {
            // Some document providers omit display metadata.
        }
        imports.put(path, source);
        reader.evaluateJavascript("window.dispatchEvent(new CustomEvent('mp-reader-import',{detail:{url:" +
            JSONObject.quote(path) + ",name:" + JSONObject.quote(name) + "}}))", null);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_FILES && filePicker != null) {
            ValueCallback<Uri[]> callback = filePicker;
            filePicker = null;
            ClipData files = result == RESULT_OK && data != null ? data.getClipData() : null;
            if (files == null) {
                callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
                return;
            }
            Uri[] selected = new Uri[files.getItemCount()];
            for (int i = 0; i < selected.length; i++) selected[i] = files.getItemAt(i).getUri();
            callback.onReceiveValue(selected);
        }
    }

    @Override
    protected void onDestroy() {
        if (filePicker != null) filePicker.onReceiveValue(null);
        reader.destroy();
        super.onDestroy();
    }

    private static String mimeType(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
        return "application/octet-stream";
    }

    private static WebResourceResponse missing() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
            Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }
}
