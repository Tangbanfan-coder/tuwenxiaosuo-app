package com.illustratedstory.app;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

/** Capacitor bridge for durable foreground generation tasks. */
@CapacitorPlugin(name = "BackgroundGeneration")
public final class BackgroundGenerationPlugin extends Plugin {
    private static boolean recoveryChecked;

    @Override public void load() {
        super.load();
        synchronized (BackgroundGenerationPlugin.class) {
            if (recoveryChecked) return;
            recoveryChecked = true;
            try { new BackgroundTaskStore(getContext()).markInFlightUnknown(); } catch (Exception ignored) { }
        }
    }
    @PluginMethod
    public void enqueue(PluginCall call) {
        String kind = call.getString("kind");
        String token = call.getString("bearerToken");
        if (!("text".equals(kind) || "image".equals(kind)) || isBlank(token)) { call.reject("后台生成参数不完整"); return; }
        try {
            JSONObject task = new JSONObject();
            task.put("kind", kind);
            task.put("secretRef", call.getString("secretRef", ""));
            JSObject metadata = call.getObject("metadata"); if (metadata != null) task.put("metadata", new JSONObject(metadata.toString()));
            if ("text".equals(kind)) {
                required(task, call, "endpoint"); required(task, call, "body");
            } else {
                required(task, call, "endpoint"); required(task, call, "model"); required(task, call, "prompt"); required(task, call, "size");
                required(task, call, "projectId"); required(task, call, "assetId");
                JSArray sources = call.getArray("referenceSources"); if (sources != null) task.put("referenceSources", new JSONArray(sources.toString()));
                String responseFormat = call.getString("responseFormat"); if (responseFormat != null) task.put("responseFormat", responseFormat);
            }
            JSONObject saved = new BackgroundTaskStore(getContext()).create(task);
            Intent intent = new Intent(getContext(), BackgroundGenerationService.class)
                .putExtra(BackgroundGenerationService.EXTRA_TASK_ID, saved.getString("id"))
                .putExtra(BackgroundGenerationService.EXTRA_BEARER_TOKEN, token);
            ContextCompat.startForegroundService(getContext(), intent);
            JSObject result = new JSObject(); result.put("id", saved.getString("id")); result.put("state", BackgroundTaskStore.PREPARED); call.resolve(result);
        } catch (Exception error) { call.reject(error.getMessage() == null ? "无法创建后台任务" : error.getMessage()); }
    }

    @PluginMethod
    public void list(PluginCall call) {
        getBridge().execute(() -> {
            try { JSObject result = new JSObject(); result.put("tasks", new BackgroundTaskStore(getContext()).list()); call.resolve(result); }
            catch (Exception error) { call.reject("无法读取后台任务"); }
        });
    }

    @PluginMethod
    public void readResult(PluginCall call) {
        String taskId = call.getString("id"); if (isBlank(taskId)) { call.reject("后台任务 ID 缺失"); return; }
        getBridge().execute(() -> {
            try {
                JSONObject task = new BackgroundTaskStore(getContext()).read(taskId);
                JSObject result = new JSObject(); result.put("id", taskId); result.put("state", task.optString("state"));
                result.put("error", task.optString("error", "")); result.put("kind", task.optString("kind", ""));
                if (task.has("metadata")) result.put("metadata", task.getJSONObject("metadata"));
                if (task.has("localUri")) result.put("localUri", task.getString("localUri"));
                copyImageMetrics(result, task);
                if (task.has("responsePath")) result.put("rawResponse", BackgroundGenerationService.readResponse(getContext(), task.getString("responsePath")));
                call.resolve(result);
            } catch (Exception error) { call.reject("无法读取后台任务结果"); }
        });
    }

    @PluginMethod
    public void acknowledge(PluginCall call) {
        String taskId = call.getString("id"); if (isBlank(taskId)) { call.reject("后台任务 ID 缺失"); return; }
        try { new BackgroundTaskStore(getContext()).delete(taskId); call.resolve(); }
        catch (Exception error) { call.reject("无法确认后台任务"); }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String taskId = call.getString("id"); if (isBlank(taskId)) { call.reject("后台任务 ID 缺失"); return; }
        getBridge().execute(() -> {
            try {
                BackgroundTaskStore store = new BackgroundTaskStore(getContext());
                // Guarded transition: only an active task may become CANCELLED,
                // so a terminal task is never flipped back by a stale cancel.
                if (store.cancelIfActive(taskId, "任务已取消")) {
                    BackgroundGenerationService.cancelConnection(taskId);
                }
                call.resolve();
            } catch (Exception error) { call.reject("无法取消后台任务"); }
        });
    }

    private static void required(JSONObject task, PluginCall call, String name) throws Exception {
        String value = call.getString(name); if (isBlank(value)) throw new IllegalArgumentException("后台生成参数不完整"); task.put(name, value);
    }
    static void copyImageMetrics(JSObject result, JSONObject task) throws Exception {
        for (String field : BackgroundGenerationService.IMAGE_METRIC_FIELDS) if (task.has(field)) result.put(field, task.get(field));
    }
    private static boolean isBlank(String value) { return value == null || value.trim().isEmpty(); }
}
