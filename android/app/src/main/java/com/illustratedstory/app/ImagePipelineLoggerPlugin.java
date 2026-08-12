package com.illustratedstory.app;

import android.util.Log;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ImagePipelineLogger")
public class ImagePipelineLoggerPlugin extends Plugin {
    private static final String TAG = "ImagePipeline";
    private static final int MAX_MESSAGE_LENGTH = 2000;

    @Override
    public void load() {
        Log.i(TAG, "{\"phase\":\"logger-native-ready\"}");
    }

    @PluginMethod
    public void write(PluginCall call) {
        String message = call.getString("message", "{}");
        if (message.length() > MAX_MESSAGE_LENGTH) {
            message = message.substring(0, MAX_MESSAGE_LENGTH);
        }
        if ("warn".equals(call.getString("level", "info"))) {
            Log.w(TAG, message);
        } else {
            Log.i(TAG, message);
        }
        call.resolve();
    }
}
