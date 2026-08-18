package com.stickmen.stickichat;

import android.app.Activity;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;

/**
 * Twitch's own login page, in a window of its own.
 *
 * The point is the cookie jar. Android's WebView cookies are shared by every WebView in the process,
 * so a session established here is a session the embedded player can see — and the player is the whole
 * reason: logged out it serves pre-roll ads to a subscriber. An API token cannot do this; it is a
 * different thing entirely from a web session.
 *
 * Nothing here reads the page. No injected JavaScript, no listener on the form, no interest in what is
 * typed — this class loads a URL and closes when the login is done. That is deliberate and it is the
 * only reason this is acceptable at all: the password goes to Twitch and is never in reach of our code.
 *
 * The user agent is overridden to a plain Chrome one. Twitch refuses to serve its login to a WebView,
 * which it recognises by the "; wv" its user agent carries. There is no way around that from the page
 * side and no other way to have a session in this process.
 */
public class LoginActivity extends Activity {

    private static final String LOGIN_URL = "https://www.twitch.tv/login";
    private static final String UA =
        "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/125.0.0.0 Mobile Safari/537.36";

    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        web = new WebView(this);
        web.setLayoutParams(
            new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        );

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUserAgentString(UA);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(
            new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    /*
                     * Twitch sends a completed login to the site root. That is the signal, and the only
                     * one available without reading the page: the session cookie is set by then, so the
                     * window has done its job and gets out of the way.
                     */
                    if (url == null) return;
                    boolean atRoot =
                        url.equals("https://www.twitch.tv/") || url.equals("https://twitch.tv/");
                    if (atRoot) {
                        cookies.flush();
                        finish();
                    }
                }
            }
        );

        root.addView(web);
        setContentView(root);
        web.loadUrl(LOGIN_URL);
    }

    /** back inside the login flow should walk the flow, not abandon it */
    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        CookieManager.getInstance().flush();
        super.onDestroy();
    }
}
