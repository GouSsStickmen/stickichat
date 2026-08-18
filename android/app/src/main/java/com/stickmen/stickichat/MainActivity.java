package com.stickmen.stickichat;

import android.app.PictureInPictureParams;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;

import android.webkit.CookieManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BrowserOnlyPlugin.class);
        registerPlugin(PipPlugin.class);
        super.onCreate(savedInstanceState);
        /*
         * The player is an iframe on player.twitch.tv inside a page served from localhost, which makes
         * its cookies third-party. Without this the session established by LoginActivity exists in the
         * process and is still invisible to the one thing it was for.
         */
        if (getBridge() != null && getBridge().getWebView() != null) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(getBridge().getWebView(), true);
            /*
             * The player starts playing on its own. A WebView refuses media until the page has had a
             * user gesture, and the tap that opened the player landed on our page — not inside the
             * Twitch iframe, which is where the rule is applied. So the stream opened paused, every
             * time, with nothing to press.
             */
            getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        }
    }

    /**
     * Leaving the app while a stream plays puts it in the little window instead of stopping it.
     *
     * onUserLeaveHint is the one callback that fires while the activity is still allowed to ask for
     * picture-in-picture: from onPause onwards the system refuses. So the decision has to be made
     * here, from a flag the page keeps up to date.
     */
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (!PipPlugin.autoPipWanted) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            enterPictureInPictureMode(
                new PictureInPictureParams.Builder().setAspectRatio(new Rational(16, 9)).build()
            );
        } catch (Exception ignored) {
            // a phone that will not do it is not a reason to fail leaving the app
        }
    }

    /**
     * In the little window, staying paused is not an option — and onPause is what pauses it.
     *
     * The order Android uses is onUserLeaveHint, then onPictureInPictureModeChanged, then onPause. So
     * resuming the view as it entered PiP was undone a moment later by the pause that followed, and in
     * a PiP window there is no way to press play: taps there go to the system, not to the page.
     */
    @Override
    public void onPause() {
        super.onPause();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        if (!isInPictureInPictureMode()) return;
        if (getBridge() == null || getBridge().getWebView() == null) return;
        runOnUiThread(
            () -> {
                getBridge().getWebView().onResume();
                getBridge().getWebView().resumeTimers();
            }
        );
    }

    /**
     * Tell the page when it is in the little window.
     *
     * The page has to know, because in picture-in-picture there is room for the player and nothing
     * else — the tab strip, the chat and the input all have to go, and only the page can do that. An
     * event rather than a plugin listener: no JS has to have subscribed first for it to arrive.
     */
    @Override
    public void onPictureInPictureModeChanged(boolean inPip, Configuration config) {
        super.onPictureInPictureModeChanged(inPip, config);
        if (getBridge() == null || getBridge().getWebView() == null) return;

        /*
         * Entering picture-in-picture takes the activity through onPause, and a paused WebView has its
         * timers and its media stopped — so the video froze in the very window it was moved into. In
         * PiP the app is not in the background in any sense that matters: it is on screen and playing.
         */
        if (inPip) {
            runOnUiThread(
                () -> {
                    getBridge().getWebView().onResume();
                    getBridge().getWebView().resumeTimers();
                }
            );
        }

        // evaluateJavascript has to be on the UI thread, and this callback is not guaranteed to be
        runOnUiThread(
            () ->
                getBridge()
                    .getWebView()
                    .evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('sticki:pip',{detail:{inPip:" + inPip + "}}))",
                        null
                    )
        );
    }
}
