package com.illustratedstory.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.pm.ServiceInfo;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Owns one foreground generation after JS has persisted its local intent.
 * The token only lives in this start intent and worker memory; task files keep
 * a secretRef for diagnostics but never an API key.
 */
public final class BackgroundGenerationService extends Service {
    static final String EXTRA_TASK_ID = "taskId";
    static final String EXTRA_BEARER_TOKEN = "bearerToken";
    private static final String CHANNEL_ID = "background-generation";
    private static final int NOTIFICATION_ID = 41021;
    private static final String IMAGE_PIPELINE_TAG = "ImagePipeline";
    static final String[] IMAGE_METRIC_FIELDS = {
        "bytes", "format", "responseMode", "responseMs", "writeMs", "validationAndReplaceMs", "durationMs"
    };
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private BackgroundTaskStore tasks;

    /** Live taskId -> connection map so a plugin cancel can interrupt an in-flight request. */
    private static final ConcurrentHashMap<String, HttpURLConnection> CONNECTIONS = new ConcurrentHashMap<>();

    static void cancelConnection(String taskId) {
        HttpURLConnection connection = CONNECTIONS.remove(taskId);
        if (connection != null) connection.disconnect();
    }

    @Override public void onCreate() {
        super.onCreate();
        tasks = new BackgroundTaskStore(this);
        createChannel();
        // Android requires foreground promotion promptly after startService.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification("正在保存 AI 生成结果"), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification("正在保存 AI 生成结果"));
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String taskId = intent == null ? null : intent.getStringExtra(EXTRA_TASK_ID);
        String token = intent == null ? null : intent.getStringExtra(EXTRA_BEARER_TOKEN);
        if (taskId == null || token == null || token.trim().isEmpty()) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        executor.execute(() -> {
            try { execute(taskId, token); }
            finally { stopSelf(startId); }
        });
        // Never recreate a task after process death: its token was intentionally not persisted.
        return START_NOT_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() { executor.shutdownNow(); super.onDestroy(); }

    private void execute(String taskId, String token) {
        try {
            // Guarded PREPARED→RUNNING so a cancel persisted between enqueue and
            // this worker starting can never be overwritten back to running.
            if (!tasks.startRunning(taskId)) return;
            JSONObject task = tasks.read(taskId);
            String kind = task.getString("kind");
            if ("text".equals(kind)) executeText(taskId, task, token);
            else if ("image".equals(kind)) executeImage(taskId, task, token);
            else throw new IOException("未知后台任务类型");
        } catch (Exception error) {
            try {
                tasks.failUnlessCancelled(taskId, safeError(error, token));
            } catch (Exception ignored) { }
        }
    }

    private void executeText(String taskId, JSONObject task, String token) throws Exception {
        URL endpoint = new URL(task.getString("endpoint"));
        if (!isHttpUrl(endpoint)) throw new IOException("文本接口地址必须使用 HTTP 或 HTTPS");
        HttpURLConnection connection = null;
        File response = null;
        File responseTemporary = null;
        boolean persisted = false;
        try {
            connection = (HttpURLConnection) endpoint.openConnection();
            CONNECTIONS.put(taskId, connection);
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(30_000);
            connection.setReadTimeout(180_000);
            connection.setInstanceFollowRedirects(false);
            connection.setDoOutput(true);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(task.getString("body").getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                String detail = sanitize(readErrorBody(connection.getErrorStream()), token);
                throw new IOException("文本接口返回 HTTP " + status + (detail.isEmpty() ? "" : "：" + detail));
            }
            if (shouldAbort(taskId)) throw new IOException("任务已取消");
            response = responseFile(taskId);
            responseTemporary = new File(response.getParentFile(), taskId.replaceAll("[^a-zA-Z0-9_-]", "_") + ".response.tmp");
            writeSanitizedResponse(connection.getInputStream(), responseTemporary, token, 16 * 1024 * 1024);
            if (shouldAbort(taskId)) {
                if (responseTemporary.exists()) responseTemporary.delete();
                throw new IOException("任务已取消");
            }
            if (response.exists() && !response.delete()) throw new IOException("无法替换后台文本结果");
            if (!responseTemporary.renameTo(response)) throw new IOException("无法保存后台文本结果");
            // Atomic RUNNING→COMPLETED: a cancel that lands mid-write wins and
            // the late response file is discarded instead of being persisted.
            final String responseName = response.getName();
            if (!tasks.completeIfRunning(taskId, completed -> completed.put("responsePath", responseName))) {
                return;
            }
            persisted = true;
        } finally {
            CONNECTIONS.remove(taskId, connection);
            if (connection != null) connection.disconnect();
            if (responseTemporary != null && responseTemporary.exists()) responseTemporary.delete();
            if (!persisted && response != null && response.exists()) response.delete();
        }
    }

    /**
     * True when the durable task is cancelled or has been removed entirely
     * (acknowledged while this worker was still finishing). A missing file is
     * treated as abort so a late worker never re-creates a completed task or
     * leaves an orphan response behind.
     */
    private boolean shouldAbort(String taskId) {
        try { return BackgroundTaskStore.CANCELLED.equals(tasks.read(taskId).optString("state")); }
        catch (Exception ignored) { return true; }
    }

    private void executeImage(String taskId, JSONObject task, String token) throws Exception {
        String endpoint = task.getString("endpoint");
        String projectId = task.getString("projectId");
        String assetId = task.getString("assetId");
        JSONObject stored = ImageAssetStorePlugin.generateAndStore(
            this, endpoint, task.getString("model"), task.getString("prompt"), task.getString("size"),
            projectId, assetId, token, task.optJSONArray("referenceSources"), task.optString("responseFormat", null)
        );
        // Atomic RUNNING→COMPLETED so an in-flight cancel can never be
        // overwritten by the late image result.
        if (!tasks.completeIfRunning(taskId, completed -> {
            completed.put("localUri", stored.getString("localUri"));
            copyImageMetrics(completed, stored);
        })) {
            return;
        }
        Log.i(IMAGE_PIPELINE_TAG, imageMetricsLogMessage(stored));
    }

    private File responseFile(String taskId) throws IOException {
        File directory = new File(getFilesDir(), "background-generation-tasks");
        if (!directory.exists() && !directory.mkdirs()) throw new IOException("无法创建结果目录");
        return new File(directory, taskId.replaceAll("[^a-zA-Z0-9_-]", "_") + ".response.json");
    }

    static String readResponse(Context context, String name) throws IOException {
        if (name == null || !name.matches("[a-zA-Z0-9_-]+\\.response\\.json")) throw new IOException("后台结果文件无效");
        File file = new File(new File(context.getFilesDir(), "background-generation-tasks"), name);
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            byte[] bytes = new byte[(int) file.length()];
            int offset = 0, read;
            while (offset < bytes.length && (read = input.read(bytes, offset, bytes.length - offset)) >= 0) offset += read;
            return new String(bytes, 0, offset, StandardCharsets.UTF_8);
        }
    }

    /** Response files must not retain a credential echoed by a proxy/provider. */
    private static void writeSanitizedResponse(InputStream input, File target, String token, int maxBytes) throws IOException {
        byte[] bytes = readLimited(input, maxBytes);
        byte[] sanitized = sanitize(new String(bytes, StandardCharsets.UTF_8), token).getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream output = new FileOutputStream(target, false)) {
            output.write(sanitized);
            output.getFD().sync();
        }
    }

    private static byte[] readLimited(InputStream input, int maxBytes) throws IOException {
        try (InputStream source = new BufferedInputStream(input)) {
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024]; int total = 0, read;
            while ((read = source.read(buffer)) >= 0) {
                if (read == 0) continue;
                total += read; if (total > maxBytes) throw new IOException("文本响应过大");
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private static String readErrorBody(InputStream input) {
        if (input == null) return "";
        try (InputStream source = new BufferedInputStream(input)) {
            byte[] bytes = new byte[1024]; int read = source.read(bytes);
            if (read <= 0) return "";
            return new String(bytes, 0, read, StandardCharsets.UTF_8).replaceAll("[\\r\\n]+", " ").trim();
        } catch (IOException ignored) { return ""; }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "AI 生成", NotificationManager.IMPORTANCE_LOW);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }
    private Notification notification(String text) { return new NotificationCompat.Builder(this, CHANNEL_ID).setSmallIcon(android.R.drawable.stat_sys_upload).setContentTitle("叙影正在生成").setContentText(text).setOngoing(true).build(); }
    private static boolean isHttpUrl(URL url) { return "http".equalsIgnoreCase(url.getProtocol()) || "https".equalsIgnoreCase(url.getProtocol()); }
    static String sanitize(String value, String token) {
        if (value == null || value.isEmpty() || token == null || token.isEmpty()) return value == null ? "" : value;
        return value.replace("Bearer " + token, "[REDACTED]").replace(token, "[REDACTED]");
    }

    /** Copies the non-sensitive storage metrics shared with the WebView result reader. */
    static void copyImageMetrics(JSONObject task, JSONObject stored) throws Exception {
        for (String field : IMAGE_METRIC_FIELDS) {
            if (stored.has(field)) task.put(field, stored.get(field));
        }
    }

    /** Keeps native Logcat diagnostics limited to image pipeline metrics. */
    static String imageMetricsLogMessage(JSONObject stored) {
        try {
            JSONObject metrics = new JSONObject();
            metrics.put("phase", "background-generation-persist-complete");
            for (String field : IMAGE_METRIC_FIELDS) {
                if (stored.has(field)) metrics.put(field, stored.get(field));
            }
            return metrics.toString();
        } catch (Exception ignored) {
            return "{\"phase\":\"background-generation-persist-complete\"}";
        }
    }
    private static String safeError(Exception error, String token) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) return "后台生成失败";
        String sanitized = sanitize(message, token);
        String normalized = sanitized.toLowerCase();
        if (normalized.contains("timeout") || normalized.contains("timed out")) {
            return "请求超时：上游服务未在限定时间内返回结果";
        }
        return sanitized;
    }
}
