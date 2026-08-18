package com.stickmen.stickichat;

import android.app.PictureInPictureParams;
import android.os.Build;
import android.util.Rational;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Picture-in-picture, the only kind Android gives a WebView.
 *
 * There is no per-element PiP here: Chrome's document PiP is not in the WebView, and the video is
 * inside a Twitch iframe we do not control. What Android does offer is putting the whole activity in
 * a small floating window — so the app enters PiP and the page, told that it has, draws nothing but
 * the player. The result looks like a video in a corner because for those few seconds that is all the
 * app is.
 */
@CapacitorPlugin(name = "Pip")
public class PipPlugin extends Plugin {

    @PluginMethod
    public void enter(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.reject("picture-in-picture needs Android 8 or newer");
            return;
        }
        // the ratio the window opens at; 16:9 is the shape of the thing being watched
        int w = call.getInt("width", 16);
        int h = call.getInt("height", 9);
        try {
            PictureInPictureParams params = new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational(w, h))
                .build();
            boolean ok = getActivity().enterPictureInPictureMode(params);
            if (ok) call.resolve();
            else call.reject("the system refused picture-in-picture");
        } catch (Exception e) {
            call.reject("picture-in-picture failed: " + e.getMessage());
        }
    }
}
