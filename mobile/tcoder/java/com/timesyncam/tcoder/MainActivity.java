package com.timesyncam.tcoder;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

// Всё приложение — одна страница (assets/index.html): экран синхронизации и «О программе».
// Отсюда — то, чего страница сама не умеет: не гасить экран, яркость на максимум, ссылки — в браузере.
public class MainActivity extends Activity {
  private WebView web;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    web = new WebView(this);
    web.setBackgroundColor(0xFFFFFFFF);
    web.getSettings().setJavaScriptEnabled(true);
    web.addJavascriptInterface(new Bridge(), "TCoder");
    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if ("file".equals(url.getScheme())) return false;
        try {
          startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (ActivityNotFoundException e) {
          // Браузера нет — ссылка просто не откроется.
        }
        return true;
      }
    });
    setContentView(web);
    if (state != null) web.restoreState(state);
    else web.loadUrl("file:///android_asset/index.html");
  }

  @Override
  protected void onSaveInstanceState(Bundle out) {
    super.onSaveInstanceState(out);
    web.saveState(out);
  }

  // Во весь экран: камере нужен только QR-код, без строки состояния и кнопок.
  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) {
      web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }
  }

  // «Назад» из «О программе» возвращает к экрану синхронизации.
  @Override
  public void onBackPressed() {
    if (web.canGoBack()) web.goBack();
    else super.onBackPressed();
  }

  private class Bridge {
    // Яркость на максимум, пока виден QR-код: камера читает его лучше; в «О программе» — как в системе.
    @JavascriptInterface
    public void bright(final boolean on) {
      runOnUiThread(new Runnable() {
        @Override
        public void run() {
          WindowManager.LayoutParams lp = getWindow().getAttributes();
          lp.screenBrightness = on ? 1f : WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
          getWindow().setAttributes(lp);
        }
      });
    }
  }
}
