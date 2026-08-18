package com.stickmen.stickichat;

import android.content.res.Configuration;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BrowserOnlyPlugin.class);
        registerPlugin(PipPlugin.class);
        super.onCreate(savedInstanceState);
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
