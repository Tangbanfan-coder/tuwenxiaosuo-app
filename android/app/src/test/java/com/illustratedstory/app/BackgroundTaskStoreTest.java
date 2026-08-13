package com.illustratedstory.app;

import org.json.JSONArray;
import org.json.JSONObject;
import com.getcapacitor.JSObject;
import org.junit.After;
import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class BackgroundTaskStoreTest {
    private final File directory = new File(System.getProperty("java.io.tmpdir"), "background-task-store-test-" + System.nanoTime());

    @After public void cleanup() { delete(directory); }

    @Test public void persistsNoTokenAndSeparatesUnsentFromInFlightTasks() throws Exception {
        BackgroundTaskStore store = new BackgroundTaskStore(directory);
        JSONObject prepared = store.create(new JSONObject().put("kind", "text").put("endpoint", "https://api.test").put("body", "{}"));
        JSONObject running = store.create(new JSONObject().put("kind", "text").put("endpoint", "https://api.test").put("body", "{}"));
        store.transition(running.getString("id"), BackgroundTaskStore.RUNNING, null);
        JSONObject completed = store.create(new JSONObject().put("kind", "image").put("endpoint", "https://api.test"));
        store.transition(completed.getString("id"), BackgroundTaskStore.COMPLETED, null);
        String persisted = new String(Files.readAllBytes(new File(directory, prepared.getString("id") + ".json").toPath()), StandardCharsets.UTF_8);
        assertFalse(persisted.contains("secret-token"));
        store.markInFlightUnknown();
        assertEquals(BackgroundTaskStore.FAILED, store.read(prepared.getString("id")).getString("state"));
        assertEquals(BackgroundTaskStore.UNKNOWN, store.read(running.getString("id")).getString("state"));
        assertEquals(BackgroundTaskStore.COMPLETED, store.read(completed.getString("id")).getString("state"));
    }

    @Test public void restoresFinalTextResponseButIgnoresPartialTemporaryResponse() throws Exception {
        BackgroundTaskStore store = new BackgroundTaskStore(directory);
        JSONObject finalResponse = store.create(new JSONObject().put("kind", "text"));
        store.transition(finalResponse.getString("id"), BackgroundTaskStore.RUNNING, null);
        Files.write(store.responseFile(finalResponse.getString("id")).toPath(), "{\"choices\":[]}".getBytes(StandardCharsets.UTF_8));
        JSONObject partial = store.create(new JSONObject().put("kind", "text"));
        store.transition(partial.getString("id"), BackgroundTaskStore.RUNNING, null);
        Files.write(store.responseTemporaryFile(partial.getString("id")).toPath(), "{\"cho".getBytes(StandardCharsets.UTF_8));
        store.markInFlightUnknown();
        assertEquals(BackgroundTaskStore.COMPLETED, store.read(finalResponse.getString("id")).getString("state"));
        assertEquals(BackgroundTaskStore.UNKNOWN, store.read(partial.getString("id")).getString("state"));
        assertFalse(store.responseTemporaryFile(partial.getString("id")).exists());
    }

    @Test public void acknowledgementDeletesTaskAndResponse() throws Exception {
        BackgroundTaskStore store = new BackgroundTaskStore(directory);
        JSONObject task = store.create(new JSONObject().put("kind", "text"));
        File response = new File(directory, task.getString("id") + ".response.json");
        assertTrue(response.createNewFile());
        store.delete(task.getString("id"));
        assertFalse(new File(directory, task.getString("id") + ".json").exists());
        assertFalse(response.exists());
    }

    @Test public void readRestoresBackupWhenReplacementWasInterrupted() throws Exception {
        BackgroundTaskStore store = new BackgroundTaskStore(directory);
        JSONObject task = store.create(new JSONObject().put("kind", "text"));
        File target = new File(directory, task.getString("id") + ".json");
        File backup = store.backupFile(task.getString("id"));
        assertTrue(target.renameTo(backup));
        assertFalse(target.exists());
        assertEquals(task.getString("id"), store.read(task.getString("id")).getString("id"));
        assertTrue(target.exists());
        assertFalse(backup.exists());
        store.transition(task.getString("id"), BackgroundTaskStore.RUNNING, null);
        assertFalse(backup.exists());
    }

    @Test public void redactsTokensFromPersistedProviderText() {
        String token = "local-test-token";
        assertEquals("token=[REDACTED] authorization=[REDACTED]", BackgroundGenerationService.sanitize("token=local-test-token authorization=Bearer local-test-token", token));
        assertEquals("normal response", BackgroundGenerationService.sanitize("normal response", token));
    }

    @Test public void copiesOnlyImageMetricsIntoTaskAndPipelineLog() throws Exception {
        JSONObject stored = new JSONObject()
            .put("localUri", "file:///private/image.png")
            .put("endpoint", "https://api.test/private")
            .put("prompt", "private prompt")
            .put("bytes", 2400000)
            .put("format", "png")
            .put("responseMode", "b64_json")
            .put("responseMs", 60000)
            .put("writeMs", 35)
            .put("validationAndReplaceMs", 12)
            .put("durationMs", 60047);
        JSONObject task = new JSONObject();

        BackgroundGenerationService.copyImageMetrics(task, stored);
        JSONObject logged = new JSONObject(BackgroundGenerationService.imageMetricsLogMessage(stored));

        assertEquals(2400000, task.getInt("bytes"));
        assertEquals("png", task.getString("format"));
        assertEquals("b64_json", task.getString("responseMode"));
        assertEquals(60000, task.getInt("responseMs"));
        assertEquals(35, task.getInt("writeMs"));
        assertEquals(12, task.getInt("validationAndReplaceMs"));
        assertEquals(60047, task.getInt("durationMs"));
        assertFalse(task.has("endpoint"));
        assertFalse(task.has("prompt"));
        assertEquals("background-generation-persist-complete", logged.getString("phase"));
        assertEquals(2400000, logged.getInt("bytes"));
        assertFalse(logged.has("localUri"));
        assertFalse(logged.has("endpoint"));
        assertFalse(logged.has("prompt"));
    }

    @Test public void pluginResultForwardsPersistedImageMetrics() throws Exception {
        JSONObject task = new JSONObject()
            .put("bytes", 2400000)
            .put("format", "png")
            .put("responseMode", "b64_json")
            .put("responseMs", 60000)
            .put("writeMs", 35)
            .put("validationAndReplaceMs", 12)
            .put("durationMs", 60047);
        JSObject result = new JSObject();

        BackgroundGenerationPlugin.copyImageMetrics(result, task);

        assertEquals(2400000, result.getInt("bytes"));
        assertEquals("png", result.getString("format"));
        assertEquals("b64_json", result.getString("responseMode"));
        assertEquals(60000, result.getInt("responseMs"));
        assertEquals(35, result.getInt("writeMs"));
        assertEquals(12, result.getInt("validationAndReplaceMs"));
        assertEquals(60047, result.getInt("durationMs"));
    }

    private static void delete(File file) {
        File[] files = file.listFiles(); if (files != null) for (File child : files) delete(child);
        file.delete();
    }
}
