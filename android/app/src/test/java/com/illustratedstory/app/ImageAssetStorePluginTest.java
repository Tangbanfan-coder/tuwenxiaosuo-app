package com.illustratedstory.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.net.URL;
import java.io.File;
import java.io.IOException;

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

    @Test
    public void recognizesCapacitorFileUrlsWithoutTreatingRemoteUrlsAsLocalFiles() {
        File local = ImageAssetStorePlugin.localCapacitorFile("http://localhost/_capacitor_file_/data/user/0/test.png");
        assertTrue(local != null);
        assertTrue(local.getPath().endsWith("data" + File.separator + "user" + File.separator + "0" + File.separator + "test.png"));
        assertTrue(ImageAssetStorePlugin.localCapacitorFile("https://cdn.example.test/reference.png") == null);
    }

    @Test
    public void generationResponsesDoNotAcceptRedirectsThatCouldForwardBearerAuthentication() {
        assertTrue(ImageAssetStorePlugin.isSuccessfulGenerationResponse(200));
        assertFalse(ImageAssetStorePlugin.isSuccessfulGenerationResponse(302));
        assertFalse(ImageAssetStorePlugin.isSuccessfulGenerationResponse(307));
    }

    @Test
    public void nativeErrorsDoNotExposeProviderUrlsOrLocalPaths() {
        String fallback = "无法生成并保存图片";
        assertTrue(ImageAssetStorePlugin.safeErrorMessage(
            new IOException("Unable to resolve host api.private.example"), fallback
        ).equals(fallback));
        assertTrue(ImageAssetStorePlugin.safeErrorMessage(
            new IOException("图片生成响应过大"), fallback
        ).equals("图片生成响应过大"));
    }
}
