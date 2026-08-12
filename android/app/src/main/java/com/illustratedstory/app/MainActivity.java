package com.illustratedstory.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ImagePipelineLoggerPlugin.class);
        registerPlugin(ImageAssetStorePlugin.class);
        registerPlugin(BackgroundGenerationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
