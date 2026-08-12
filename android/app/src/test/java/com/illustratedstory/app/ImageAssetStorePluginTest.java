package com.illustratedstory.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.net.URL;

public class ImageAssetStorePluginTest {
    @Test
    public void sameOriginIncludesSchemeHostAndEffectivePort() throws Exception {
        URL provider = new URL("https://api.example.test/v1/image");
        assertTrue(ImageAssetStorePlugin.sameOrigin(provider, new URL("https://api.example.test:443/result")));
        assertFalse(ImageAssetStorePlugin.sameOrigin(provider, new URL("https://cdn.example.test/result")));
        assertFalse(ImageAssetStorePlugin.sameOrigin(provider, new URL("http://api.example.test/result")));
        assertFalse(ImageAssetStorePlugin.sameOrigin(provider, new URL("https://api.example.test:8443/result")));
    }

    @Test
    public void siblingCleanupTargetsOnlyOtherSupportedFormatsForTheSameAsset() {
        assertTrue(ImageAssetStorePlugin.isSiblingImageFormat("asset-1.jpg", "asset-1", "png"));
        assertFalse(ImageAssetStorePlugin.isSiblingImageFormat("asset-1.png", "asset-1", "png"));
        assertFalse(ImageAssetStorePlugin.isSiblingImageFormat("asset-2.jpg", "asset-1", "png"));
        assertFalse(ImageAssetStorePlugin.isSiblingImageFormat("asset-1.download.tmp", "asset-1", "png"));
    }
}
