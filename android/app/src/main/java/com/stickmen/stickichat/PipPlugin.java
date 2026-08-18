package com.stickmen.stickichat;

import android.app.PictureInPictureParams;
import android.content.Intent;
import android.os.Build;
import android.util.Rational;
import android.webkit.CookieManager;

import com.getcapacitor.JSObject;
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

    /**
     * Whether leaving the app should put it in the little window.
     *
     * Static because the activity has to read it from onUserLeaveHint, which is the only moment
     * Android accepts the request — by the time the app is actually in the background it is too late
     * to ask. False unless a stream is playing, or every trip to the home screen would leave a video
     * window behind.
     */
    public static boolean autoPipWanted = false;

    @PluginMethod
    public void setAuto(PluginCall call) {
        autoPipWanted = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        call.resolve();
    }

    /**
     * Open Twitch's login page in its own window, so the player can stop being anonymous.
     *
     * Lives on this plugin because it is the same subject: what the embedded player is allowed to be.
     * See LoginActivity for why a session, and not the API token the app already has, is what decides
     * whether a subscriber sees ads.
     */
    @PluginMethod
    public void openTwitchLogin(PluginCall call) {
        try {
            getContext().startActivity(new Intent(getContext(), LoginActivity.class));
            call.resolve();
        } catch (Exception e) {
            call.reject("could not open the login window: " + e.getMessage());
        }
    }

    /** whether this process holds a twitch.tv session — the player is logged in exactly when it does */
    @PluginMethod
    public void hasTwitchSession(PluginCall call) {
        String cookie = CookieManager.getInstance().getCookie("https://www.twitch.tv");
        JSObject res = new JSObject();
        res.put("value", cookie != null && cookie.contains("auth-token"));
        call.resolve(res);
    }

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
