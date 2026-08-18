package com.stickmen.stickichat;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * Opens a URL in a browser, and never in an app that claims the link.
 *
 * The device-code login sends the user to www.twitch.tv/activate, and Twitch owns that host as a
 * verified Android App Link — so an ordinary ACTION_VIEW, a Custom Tab, and an intent:// URL all
 * hand the page to the Twitch app, which opens on a black screen and shows no activation form. The
 * login then has no way to finish.
 *
 * The only reliable way past that is to name the target package explicitly. Which browser that is
 * cannot be assumed: this device answers a plain http:// query with Firefox and no Chrome at all.
 * So the browsers are resolved at call time, against a URL with no host for anyone to have claimed.
 */
@CapacitorPlugin(name = "BrowserOnly")
public class BrowserOnlyPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }

        PackageManager pm = getContext().getPackageManager();
        // no host: only general-purpose browsers can match, never a per-domain app link
        Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse("http://"));
        probe.addCategory(Intent.CATEGORY_BROWSABLE);

        String chosen = null;
        List<ResolveInfo> browsers = pm.queryIntentActivities(probe, PackageManager.MATCH_ALL);
        for (ResolveInfo info : browsers) {
            String pkg = info.activityInfo.packageName;
            // prefer the user's default if it is among them; otherwise the first is fine
            if (chosen == null) chosen = pkg;
            ResolveInfo preferred = pm.resolveActivity(probe, PackageManager.MATCH_DEFAULT_ONLY);
            if (preferred != null && pkg.equals(preferred.activityInfo.packageName)) {
                chosen = pkg;
                break;
            }
        }

        Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        view.addCategory(Intent.CATEGORY_BROWSABLE);
        view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (chosen != null) view.setPackage(chosen);

        try {
            getContext().startActivity(view);
        } catch (Exception e) {
            // no browser would take it with the package pinned — let the system decide rather
            // than leaving the user on a dead button
            try {
                getContext().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception inner) {
                call.reject("no application could open the url");
                return;
            }
        }

        JSObject res = new JSObject();
        res.put("package", chosen == null ? "system" : chosen);
        call.resolve(res);
    }

    /**
     * Lands the user on the screen where an app's link handling is turned off.
     *
     * Telling someone to "find it in Settings" is telling them to give up: the switch is four levels
     * deep and named differently on every skin. APP_OPEN_BY_DEFAULT_SETTINGS goes straight to it,
     * and where that screen does not exist yet the app's own details page is one tap away from it.
     */
    @PluginMethod
    public void openLinkSettings(PluginCall call) {
        String pkg = call.getString("package");
        if (pkg == null || pkg.isEmpty()) {
            call.reject("package is required");
            return;
        }

        Intent intent = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            intent = new Intent(Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS, Uri.parse("package:" + pkg));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (intent.resolveActivity(getContext().getPackageManager()) == null) intent = null;
        }
        if (intent == null) {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        }

        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("could not open the settings screen");
        }
    }
}
