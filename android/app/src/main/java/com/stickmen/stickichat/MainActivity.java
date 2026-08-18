package com.stickmen.stickichat;

import android.app.PictureInPictureParams;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BrowserOnlyPlugin.class);
        registerPlugin(PipPlugin.class);
        super.onCreate(savedInstanceState);
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
